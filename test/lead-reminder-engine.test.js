import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { migrateLeadReminders } from "../scripts/migrate-lead-reminders.js";
import { createReminderRepository } from "../src/services/lead-reminder.repository.js";
import { createReminderEngine } from "../src/services/lead-reminder-engine.js";
import { reminderConfig } from "../src/lib/lead-reminder-policy.js";

// Execute the production migration and repository SQL against actual PostgreSQL
// in WASM. Only the Prisma call interface is adapted; SQL behavior is not mocked.
function adapter(pg) {
  const query = (strings, values) => pg.query(strings.reduce((sql, s, i) => sql + (i ? "$" + i : "") + s, ""),
    values.map(v => v instanceof Date ? v.toISOString() : v));
  return {
    $queryRaw: async (strings, ...values) => (await query(strings, values)).rows,
    $executeRaw: async (strings, ...values) => (await query(strings, values)).affectedRows,
    $executeRawUnsafe: async sql => (await pg.query(sql)).affectedRows,
    $transaction: fn => pg.transaction(tx => fn(adapter(tx))),
  };
}

let pg, db, repository;
before(async () => {
  pg = new PGlite();
  db = adapter(pg);
  await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;");
  await migrateLeadReminders(db);
  repository = createReminderRepository(db);
});
after(async () => { await pg?.close(); });
beforeEach(async () => { await pg.exec("TRUNCATE crm_lead_reminder_outbox, crm_lead_reminder_state, crm_reminder_rollout;"); });

const start = "2026-10-27T03:30:00.000Z";
const later = hours => new Date(Date.parse(start) + hours * 3600000);
const config = reminderConfig({
  CRM_LEAD_REMINDERS_ENABLED: "true", CRM_REMINDER_NEW_LEADS_FROM: "2026-10-27T00:00:00+05:30",
  CRM_REMINDER_BETA_EMPLOYEE_IDS: "12,19,1,2,5", CRM_REMINDER_ESCALATION_EMPLOYEE_IDS: "2,5",
  CRM_REMINDER_ESCALATION_EXEMPT_EMPLOYEE_IDS: "2,5", RAMESH_API_URL: "https://ramesh.example",
  RAMESH_AUTOMATION_API_KEY: "synthetic-test-key", TWENTY_CRM_BASE_URL: "https://crm.example",
});
const people = [[12, "Maneesh"], [19, "Nihas"], [1, "Raghav"], [2, "Dhaval"], [5, "Jayanth"], [6, "Other"]]
  .map(([id, name]) => ({ id, name, is_active: true, phone_number: "+9190000000" + String(id).padStart(2, "0"),
    twenty_user_id: "member-" + id }));
const lead = extra => ({ id: "00000000-0000-4000-8000-000000000001", name: "Synthetic warehouse lead",
  createdAt: start, stage: "NEW_LEAD", assignedTo: ["MANEESH"], ...extra });

function fixture(record = lead()) {
  const f = { now: later(0), record, people: structuredClone(people), healthy: true,
    sends: [], delivered: new Map(), statusState: "SENT", failures: 0, throwAfterAcceptance: false };
  const source = {
    healthy: async () => f.healthy,
    roster: async () => f.people,
    async *pages() { yield [{ data: f.record, lastPolledAt: f.snapshotAt || f.now }]; },
    current: async () => {
      if (f.liveFailure) throw new Error("synthetic unavailable source");
      return f.live === undefined ? f.record : f.live;
    },
  };
  const transport = {
    async enqueue(id, payload) {
      f.sends.push({ id, payload: structuredClone(payload) });
      if (f.failures-- > 0) throw new Error("synthetic network error");
      let messageId = f.delivered.get(id)?.messageId;
      if (messageId) assert.deepEqual(payload, f.delivered.get(id).payload, "retries must use the frozen payload");
      else {
        messageId = randomUUID();
        f.delivered.set(id, { messageId, payload: structuredClone(payload) });
      }
      if (f.throwAfterAcceptance) { f.throwAfterAcceptance = false; throw new Error("ambiguous POST timeout"); }
      return { messageId, status: "queued" };
    },
    status: async messageId => ({ messageId, state: f.statusState }),
  };
  f.engine = () => createReminderEngine({ repository, source, transport, config, clock: () => f.now });
  f.run = (options = { preview: false }) => f.engine()(options);
  f.at = hours => { f.now = later(hours); };
  return f;
}

test("migration is additive, idempotent and private to the DB owner", async () => {
  assert.deepEqual(await migrateLeadReminders(db), { alreadyApplied: true });
  const { rows } = await pg.query("SELECT relrowsecurity, has_table_privilege('anon',oid,'SELECT') AS anon_read, has_table_privilege('service_role',oid,'SELECT') AS service_read FROM pg_class WHERE relname IN ('crm_reminder_rollout','crm_lead_reminder_state','crm_lead_reminder_outbox')");
  assert.equal(rows.length, 3);
  assert.ok(rows.every(r => r.relrowsecurity && !r.anon_read && !r.service_read));
});

test("0/2/4/8 sequence survives worker restarts and repeated ticks without duplicate delivery", async () => {
  const f = fixture();
  for (const hours of [0, 2, 4, 8]) {
    f.at(hours);
    assert.equal((await f.run()).queued, hours === 8 ? 2 : 1);
    assert.equal((await f.run()).queued, 0);
  }
  assert.equal(f.delivered.size, 5);
  const state = await repository.state(f.record.id);
  assert.equal(state.assignments.length, 1);
  assert.equal(state.assignments[0].assignedAt, start);
  // Ramesh SENT means an internal message was sent; it is never client-contact completion.
  assert.equal(state.assignments[0].finished, null);
});

test("Dhaval and Jayanth receive exactly three reminders with no escalation of their sequences", async () => {
  for (const name of ["DHAVAL", "JAYANTH"]) {
    const f = fixture(lead({ id: randomUUID(), assignedTo: [name] }));
    for (const h of [0, 2, 4, 8]) { f.at(h); await f.run(); }
    assert.equal(f.delivered.size, 3);
    assert.ok(f.sends.every(s => s.payload.text.includes("no management escalation")));
  }
});

test("preview does not acquire a lease, persist state or enqueue anything", async () => {
  const f = fixture();
  const result = await f.run({ preview: true });
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].status, "would_enqueue");
  assert.equal(f.sends.length, 0);
  const { rows } = await pg.query("SELECT (SELECT count(*) FROM crm_reminder_rollout)::int AS rollout, (SELECT count(*) FROM crm_lead_reminder_state)::int AS states, (SELECT count(*) FROM crm_lead_reminder_outbox)::int AS outbox");
  assert.deepEqual(rows, [{ rollout: 0, states: 0, outbox: 0 }]);
});

test("dispatch kill switch is checked before reading or writing any state", async () => {
  const engine = createReminderEngine({ config: { enabled: false },
    source: { healthy: () => { throw new Error("must not be called"); } } });
  assert.deepEqual(await engine({ preview: false }), { status: "disabled", preview: false });
});

test("historical leads and non-beta assignments never produce notifications", async () => {
  for (const fields of [{ createdAt: "2025-01-01T00:00:00Z" }, { assignedTo: ["OTHER"] }]) {
    const f = fixture(lead({ id: randomUUID(), ...fields }));
    for (const h of [0, 2, 4, 8]) { f.at(h); await f.run(); }
    assert.equal(f.sends.length, 0);
  }
});

test("unassigned lead notifies its owner once; assignment starts a new clock later", async () => {
  const f = fixture(lead({ assignedTo: [], ownerId: "member-1" }));
  assert.equal((await f.run()).queued, 1);
  f.at(4);
  assert.equal((await f.run()).queued, 0);
  f.record = { ...f.record, assignedTo: ["NIHAS"] };
  assert.equal((await f.run()).queued, 1);
  assert.equal((await repository.state(f.record.id)).assignments[0].assignedAt, later(4).toISOString());
  f.at(6);
  assert.equal((await f.run()).queued, 1);
  assert.match(f.sends.at(-1).payload.text, /2 working hours/);
});

test("live completion, deletion or stage exit suppresses a reminder from the stale mirror", async () => {
  for (const update of [{ lastContacted: later(1).toISOString() }, { stage: "PROPOSAL_SHARED" }, null]) {
    const f = fixture(lead({ id: randomUUID() }));
    await f.run();
    f.at(2);
    f.live = update === null ? null : { ...f.record, ...update };
    assert.equal((await f.run()).queued, 0);
    f.at(8);
    await f.run();
    assert.equal(f.delivered.size, 1);
  }
});

test("leads outside intake or deleted do not report irrelevant recipient routing issues", async () => {
  for (const inactive of [{ stage: "PROPOSAL_SHARED" }, { deletedAt: start }]) {
    for (const assignedTo of [[], ["UNKNOWN"], ["MANEESH"]]) {
      const f = fixture(lead({ id: randomUUID(), ...inactive, assignedTo, ownerId: null }));
      f.people.find(p => p.id === 12).phone_number = "";
      for (const preview of [true, false]) {
        const result = await f.run({ preview });
        assert.equal(result.status, "ok");
        assert.equal(result.routingIssues, 0);
        assert.equal(result.queued, 0);
      }
      assert.equal(f.sends.length, 0);
    }
  }
});

test("stage exit still finishes assignments and cancels pending retries without a remaining owner", async () => {
  const f = fixture();
  f.failures = 1;
  await f.run();
  f.at(2);
  f.record = { ...f.record, stage: "PROPOSAL_SHARED", assignedTo: [], ownerId: null };
  const result = await f.run();
  assert.equal(result.status, "ok");
  assert.equal(result.routingIssues, 0);
  assert.equal((await repository.state(f.record.id)).assignments[0].finished.reason, "stage_exit");
  const { rows } = await pg.query("SELECT status FROM crm_lead_reminder_outbox");
  assert.deepEqual(rows, [{ status: "superseded" }]);
  assert.equal(f.sends.length, 1);
});

test("live reassignment cancels the old recipient and gives the new assignee an initial draft", async () => {
  const f = fixture();
  await f.run();
  f.at(2);
  f.live = { ...f.record, assignedTo: ["RAGHAV"] };
  assert.equal((await f.run()).queued, 1);
  assert.equal(f.sends.at(-1).payload.to, people.find(p => p.id === 1).phone_number);
  assert.match(f.sends.at(-1).payload.text, /Outreach draft/);
});

test("an older mirror snapshot cannot undo a live reassignment or reset its clock", async () => {
  const f = fixture();
  await f.run();
  f.at(2);
  f.snapshotAt = later(2 - 1 / 6);
  f.live = { ...f.record, assignedTo: ["RAGHAV"] };
  await f.run();
  f.at(2 + 1 / 6);
  assert.equal((await f.run()).queued, 0);
  const state = await repository.state(f.record.id);
  assert.equal(state.assignments.length, 2);
  assert.equal(state.assignments[1].assignedAt, later(2).toISOString());
  assert.equal(f.delivered.size, 2);
});

test("failed preflight preserves the first observed assignment without sending", async () => {
  const f = fixture();
  f.liveFailure = true;
  assert.equal((await f.run()).status, "partial");
  assert.equal(f.sends.length, 0);
  f.at(1);
  f.liveFailure = false;
  await f.run();
  assert.equal((await repository.state(f.record.id)).assignments[0].assignedAt, start);
});

test("a cached snapshot at exactly the live observation timestamp cannot replay a reassignment", async () => {
  const f = fixture();
  await f.run();
  f.at(2); f.snapshotAt = later(2);
  f.live = { ...f.record, assignedTo: ["RAGHAV"] };
  assert.equal((await f.run()).queued, 1);
  f.at(2 + 1 / 6);
  assert.equal((await f.run()).queued, 0);
  const state = await repository.state(f.record.id);
  assert.equal(state.assignments.length, 2);
  assert.equal(state.assignments[1].assignedAt, later(2).toISOString());
});

test("ambiguous POST retry uses the original key and text even after lead details change", async () => {
  const f = fixture();
  f.throwAfterAcceptance = true;
  assert.equal((await f.run()).status, "partial");
  f.at(1);
  f.record = { ...f.record, name: "Changed synthetic lead name" };
  const preview = await f.run({ preview: true });
  assert.equal(preview.notifications[0].text, f.sends[0].payload.text,
    "preview must show the frozen retry payload that will actually be sent");
  assert.equal(f.sends.length, 1);
  await f.run();
  assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends[0], f.sends[1]);
  assert.equal(f.delivered.size, 1);
});

test("late ticks coalesce old reminders instead of sending a burst after recovery", async () => {
  const f = fixture();
  f.failures = 1;
  await f.run();
  const initialId = f.sends[0].id;
  f.at(4);
  assert.equal((await f.run()).queued, 1);
  assert.match(f.sends.at(-1).payload.text, /4 working hours/);
  assert.equal((await repository.notification(initialId)).status, "superseded");
  f.at(8);
  assert.equal((await f.run()).queued, 2);
});

test("an owner's failed notification can resume after quiet hours with the same intent", async () => {
  const f = fixture(lead({ assignedTo: [], ownerId: "member-1" }));
  f.at(10); // 19:00 IST
  f.failures = 1;
  assert.equal((await f.run()).failures, 1);
  const original = structuredClone(f.sends[0]);
  f.at(12); // 21:00 IST: no send during quiet hours
  assert.equal((await f.run()).queued, 0);
  f.at(23); // 08:00 next morning: still unassigned
  assert.equal((await f.run()).queued, 1);
  assert.deepEqual(f.sends.at(-1), original);
  assert.equal(f.delivered.size, 1);
});

test("a temporary routing failure does not permanently discard a failed assignment notification", async () => {
  const f = fixture();
  f.failures = 1;
  await f.run();
  const original = structuredClone(f.sends[0]);
  f.at(0.5); f.people[0].phone_number = "";
  assert.equal((await f.run()).queued, 0);
  f.at(1); f.people[0].phone_number = people[0].phone_number;
  assert.equal((await f.run()).queued, 1);
  assert.deepEqual(f.sends.at(-1), original);
});

test("ambiguous sends stop retrying before the provider can forget their idempotency keys", async () => {
  const f = fixture();
  f.failures = 1;
  await f.run();
  await pg.exec("UPDATE crm_lead_reminder_outbox SET created_at=now()-interval '25 hours'");
  assert.equal((await f.run()).queued, 0);
  assert.equal(f.sends.length, 1);
  assert.equal((await repository.notification(f.sends[0].id)).reason, "RETRY_WINDOW_EXPIRED");
});

test("resuming an intent after quiet hours does not restart its 24-hour retry window", async () => {
  const f = fixture(lead({ assignedTo: [], ownerId: "member-1" }));
  f.at(10); f.failures = 1;
  await f.run();
  f.at(12); await f.run();
  await pg.exec("UPDATE crm_lead_reminder_outbox SET created_at=now()-interval '25 hours'");
  f.at(23);
  assert.equal((await f.run()).deliveryFailures, 1);
  assert.equal(f.sends.length, 1);
  assert.equal((await repository.notification(f.sends[0].id)).reason, "RETRY_WINDOW_EXPIRED");
});

test("removing an overdue co-assignee cannot escalate the remaining assignee a second time", async () => {
  const f = fixture(lead({ assignedTo: ["MANEESH", "NIHAS"] }));
  await f.run();
  f.at(8);
  assert.equal((await f.run()).queued, 4); // Each assignee has an independent clock/case.
  f.record = { ...f.record, assignedTo: ["MANEESH"] };
  f.at(9);
  assert.equal((await f.run()).queued, 0);
  assert.equal(f.delivered.size, 6);
});

test("missing employee email is harmless; missing phone is a routing issue, still escalated", async () => {
  const f = fixture();
  f.people[0].phone_number = "";
  assert.equal((await f.run()).routingIssues, 1);
  assert.equal(f.sends.length, 0);
  f.at(8);
  assert.equal((await f.run()).queued, 2);
});

test("an unreachable escalation recipient is reported while the other founder can still be notified", async () => {
  const f = fixture();
  f.people.find(p => p.id === 2).phone_number = "";
  assert.equal((await f.run()).routingIssues, 1);
  f.at(8);
  const result = await f.run();
  assert.equal(result.status, "partial");
  assert.equal(result.queued, 1);
  assert.equal(result.routingIssues, 1);
  assert.equal(f.sends.at(-1).payload.to, people.find(p => p.id === 5).phone_number);
});

test("unhealthy source sends nothing and does not enroll any lead", async () => {
  const f = fixture();
  f.healthy = false;
  assert.equal((await f.run()).status, "source_unavailable");
  assert.equal(await repository.state(f.record.id), null);
  assert.equal(f.sends.length, 0);
});

test("provider failure or uncertainty is recorded and never blindly re-enqueued", async () => {
  for (const state of ["FAILED", "UNCERTAIN", "EXPIRED"]) {
    const f = fixture(lead({ id: randomUUID() }));
    f.statusState = state;
    assert.equal((await f.run()).deliveryFailures, 1);
    assert.equal((await f.run()).queued, 0);
    assert.equal((await repository.notification(f.sends[0].id)).provider_state, state);
  }
});

test("durable lease prevents overlapping workers, fences expired workers and fixes cutoff", async () => {
  const a = randomUUID(), b = randomUUID();
  assert.equal(await repository.claim(config.cutoff, a), true);
  assert.equal(await repository.claim(config.cutoff, b), false);
  assert.equal((await fixture().run()).status, "locked");
  await assert.rejects(repository.save(b, lead(), {}), /LEASE_LOST/);
  await pg.exec("UPDATE crm_reminder_rollout SET lease_until=now()-interval '1 second'");
  assert.equal(await repository.claim(config.cutoff, b), true);
  await assert.rejects(repository.save(a, lead(), {}), /LEASE_LOST/);
  await repository.release(a);
  assert.equal(await repository.claim(config.cutoff, randomUUID()), false);
  await repository.release(b);
  await assert.rejects(repository.claim("2026-10-21T00:00:00Z", a), /CUTOFF_CHANGED/);
  await assert.rejects(repository.checkCutoff("2026-10-24T00:00:00Z"), /CUTOFF_CHANGED/);
});
