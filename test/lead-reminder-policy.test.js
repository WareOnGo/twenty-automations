import test from "node:test";
import assert from "node:assert/strict";
import { reminderConfig, workingDeadline, reconcileLead, dueNotifications, rosterResolver, REMINDER_ROLLOUT_START } from "../src/lib/lead-reminder-policy.js";
import { buildReminderMessage } from "../src/lib/lead-reminder-messages.js";

const env = {
  CRM_LEAD_REMINDERS_ENABLED: "true", CRM_REMINDER_NEW_LEADS_FROM: "2026-10-27T00:00:00+05:30",
  CRM_REMINDER_BETA_EMPLOYEE_IDS: "12,19,1,2,5", CRM_REMINDER_ESCALATION_EMPLOYEE_IDS: "2,5",
  CRM_REMINDER_ESCALATION_EXEMPT_EMPLOYEE_IDS: "2,5", RAMESH_API_URL: "https://ramesh.example",
  RAMESH_AUTOMATION_API_KEY: "synthetic-test-key", TWENTY_CRM_BASE_URL: "https://crm.example",
};
const config = reminderConfig(env);
const people = [[12, "Maneesh"], [19, "Nihas"], [1, "Raghav"], [2, "Dhaval"], [5, "Jayanth"], [6, "Other"]]
  .map(([id, name]) => ({ id, name, is_active: true, phone_number: "+9190000000" + String(id).padStart(2, "0"),
    twenty_user_id: "member-" + id }));
const roster = rosterResolver(people, config);
const at = "2026-10-27T03:30:00.000Z"; // 09:00 IST
const later = hours => new Date(Date.parse(at) + hours * 3600000).toISOString();
const lead = extra => ({ id: "00000000-0000-4000-8000-000000000001", createdAt: at,
  stage: "RFQ_RECEIVED", assignedTo: ["MANEESH"], ...extra });
const plan = (record, start = at) => reconcileLead(null, record, roster, config, start);

test("explicit forward cutoff and recipient lists are required only when enabled", () => {
  assert.equal(reminderConfig({}).enabled, false);
  for (const field of ["CRM_REMINDER_NEW_LEADS_FROM", "CRM_REMINDER_BETA_EMPLOYEE_IDS",
    "CRM_REMINDER_ESCALATION_EMPLOYEE_IDS", "RAMESH_AUTOMATION_API_KEY"]) {
    assert.throws(() => reminderConfig({ ...env, [field]: "" }));
  }
  assert.throws(() => reminderConfig({ ...env, RAMESH_API_URL: "http://ramesh.example" }));
  assert.throws(() => reminderConfig({ ...env, CRM_REMINDER_BETA_EMPLOYEE_IDS: "12,anyone" }));
  assert.equal(reminderConfig({ ...env, CRM_LEAD_REMINDERS_ENABLED: "false", RAMESH_AUTOMATION_API_KEY: "" },
    { forPreview: true }).enabled, false);
});

test("working clock carries evenings overnight and handles assignment outside work hours", () => {
  assert.equal(workingDeadline("2026-10-26T10:30:00Z", 8), "2026-10-27T06:30:00.000Z");
  assert.equal(workingDeadline("2026-10-26T16:30:00Z", 2), "2026-10-27T04:30:00.000Z");
  assert.equal(workingDeadline("2026-10-26T02:00:00Z", 0), "2026-10-26T02:30:00.000Z");
  assert.equal(workingDeadline("2026-10-26T02:30:00Z", 4), "2026-10-26T06:30:00.000Z");
  assert.equal(workingDeadline("2026-10-26T10:30:00Z", 4), "2026-10-27T02:30:00.000Z");
});

test("the fixed rollout starts at midnight IST on 27 October and cannot be backdated", () => {
  assert.equal(REMINDER_ROLLOUT_START, "2026-10-27T00:00:00+05:30");
  assert.equal(config.cutoff, "2026-10-26T18:30:00.000Z");
  for (const cutoff of ["2026-10-26T18:29:59.999Z", "2026-10-22T00:00:00Z"]) {
    assert.throws(() => reminderConfig({ ...env, CRM_REMINDER_NEW_LEADS_FROM: cutoff }), /CUTOFF_BEFORE_ROLLOUT/);
    assert.throws(() => reminderConfig({ ...env, CRM_LEAD_REMINDERS_ENABLED: "false",
      CRM_REMINDER_NEW_LEADS_FROM: cutoff }, { forPreview: true }), /CUTOFF_BEFORE_ROLLOUT/);
  }
  assert.equal(reminderConfig({ ...env, CRM_REMINDER_NEW_LEADS_FROM: "2026-10-28T00:00:00+05:30" }).cutoff,
    "2026-10-27T18:30:00.000Z");
});

test("initial, 2h and 4h reminders become an 8h escalation per founder", () => {
  const record = lead();
  const state = plan(record);
  for (const hours of [0, 2, 4]) {
    const notifications = dueNotifications(state, record, roster, config, later(hours));
    assert.deepEqual(notifications.map(n => [n.recipient.id, n.step]), [[12, String(hours)]]);
  }
  const escalation = dueNotifications(state, record, roster, config, later(8));
  assert.deepEqual(escalation.map(n => [n.recipient.id, n.step]), [[2, "8"], [5, "8"]]);
  assert.equal(dueNotifications(state, record, roster, config, later(1))[0].step, "0");
});

test("historic leads never qualify even with fresh assignment, contact or stage edits", () => {
  const record = lead({ createdAt: "2026-10-01T00:00:00Z", updatedAt: later(8) });
  assert.deepEqual(dueNotifications(plan(record), record, roster, config, later(8)), []);
});

test("email is unnecessary, non-beta people are excluded and duplicate names are unresolved", () => {
  assert.ok(roster.canNotify(people[0]));
  const record = lead({ assignedTo: ["OTHER"] });
  assert.deepEqual(dueNotifications(plan(record), record, roster, config, later(8)), []);
  const ambiguous = rosterResolver([...people, { ...people[0], id: 20 }], config);
  assert.equal(ambiguous.assignee("MANEESH"), null);
  const explicit = rosterResolver([...people, { ...people[0], id: 20 }], { ...config, aliases: { MANEESH: 12 } });
  assert.equal(explicit.assignee("MANEESH").id, 12);
});

test("founders receive all three reminders but their sequences never escalate or threaten escalation", () => {
  for (const key of ["DHAVAL", "JAYANTH"]) {
    const record = lead({ assignedTo: [key] });
    const state = plan(record);
    for (const hour of [0, 2, 4]) {
      const [n] = dueNotifications(state, record, roster, config, later(hour));
      assert.equal(n.step, String(hour));
      const message = buildReminderMessage(record, n, config);
      assert.match(message, /no management escalation/);
      assert.doesNotMatch(message, /this will be escalated/);
    }
    assert.deepEqual(dueNotifications(state, record, roster, config, later(8)), []);
  }
});

test("escalations exclude a founder who owns or is assigned to the deal", () => {
  for (const record of [
    lead({ ownerId: "member-2" }),
    lead({ assignedTo: ["MANEESH", "DHAVAL"] }),
  ]) {
    const ns = dueNotifications(plan(record), record, roster, config, later(8));
    assert.deepEqual(ns.map(n => n.recipient.id), [5]);
    assert.deepEqual(ns[0].assignments.map(a => a.key), ["MANEESH"]);
  }
  const both = lead({ assignedTo: ["MANEESH", "DHAVAL", "JAYANTH"] });
  assert.deepEqual(dueNotifications(plan(both), both, roster, config, later(8)), []);
});

test("unassigned notification goes to the real owner without creating a sales assignment", () => {
  const record = lead({ assignedTo: [], ownerId: "member-1" });
  const state = plan(record);
  assert.equal(state.assignments.length, 0);
  assert.deepEqual(dueNotifications(state, record, roster, config, at).map(n => [n.step, n.recipient.id]), [["owner", 1]]);
  const noOwner = lead({ assignedTo: [], createdBy: { workspaceMemberId: "member-1" } });
  assert.deepEqual(dueNotifications(plan(noOwner), noOwner, roster, config, at), []);
});

test("reassignment starts only the new person's clock and preserves the previous episode", () => {
  const old = plan(lead());
  const record = lead({ assignedTo: ["MANEESH", "RAGHAV"], updatedAt: later(3) });
  const state = reconcileLead(old, record, roster, config, later(3));
  assert.equal(state.assignments[0].assignedAt, at);
  assert.equal(state.assignments[1].assignedAt, later(3));
  assert.deepEqual(dueNotifications(state, record, roster, config, later(4)).map(n => [n.recipient.id, n.step]), [[12, "4"], [1, "0"]]);
  const removed = reconcileLead(state, lead({ assignedTo: ["RAGHAV"] }), roster, config, later(5));
  assert.equal(removed.assignments[0].removedAt, later(5));
});

test("contact or stage exit stops follow-ups; unrelated CRM activity and future contact dates do not", () => {
  const state = plan(lead());
  for (const fields of [{ lastContacted: later(1) }, { lastContacted: "2026-10-27" }, { stage: "PROPOSAL_SHARED" }, { deletedAt: later(1) }]) {
    const record = lead(fields);
    const next = reconcileLead(state, record, roster, config, later(2));
    assert.deepEqual(dueNotifications(next, record, roster, config, later(8)), []);
  }
  for (const fields of [{ updatedAt: later(1), description: "new note" },
    { lastContacted: later(20) }, { lastContacted: later(-1) }]) {
    const record = lead(fields);
    const next = reconcileLead(state, record, roster, config, later(2));
    assert.equal(dueNotifications(next, record, roster, config, later(2))[0].step, "2");
  }
});

test("pre-existing date-only contact does not falsely complete a new assignment", () => {
  const record = lead({ lastContacted: "2026-10-27" });
  const state = plan(record);
  assert.equal(dueNotifications(state, record, roster, config, later(2))[0].step, "2");
});

test("a pre-existing future contact does not become completion when the clock catches up", () => {
  const record = lead({ lastContacted: later(2) });
  const state = plan(record);
  for (const hours of [0, 2, 4]) {
    const next = reconcileLead(state, record, roster, config, later(hours));
    assert.equal(dueNotifications(next, record, roster, config, later(hours))[0].step, String(hours));
  }
  const corrected = lead({ lastContacted: later(3) });
  const next = reconcileLead(state, corrected, roster, config, later(4));
  assert.deepEqual(dueNotifications(next, corrected, roster, config, later(4)), []);
});

test("later beta admission does not replay an already observed non-beta assignment", () => {
  const excluded = { ...config, betaIds: [1, 2, 5, 19] };
  const state = reconcileLead(null, lead(), rosterResolver(people, excluded), excluded, at);
  const laterState = reconcileLead(state, lead(), roster, config, later(2));
  assert.deepEqual(dueNotifications(laterState, lead(), roster, config, later(8)), []);
});

test("message includes actionable drafts, no fabricated inventory, and stays within transport limits", () => {
  const record = lead({ name: "A".repeat(500), description: "x".repeat(10000), companyName: "C".repeat(500),
    city: "Bengaluru", microMarket: "Nelamangala", requirementInSft: 50000, budget: "20 / sq ft",
    pocName: { firstName: "Client", lastName: "Name" }, companyEmail: "client@example.com" });
  const [n] = dueNotifications(plan(record), record, roster, config, at);
  const message = buildReminderMessage(record, n, config);
  assert.ok(message.length <= 4000);
  assert.match(message, /verified option 1/);
  assert.match(message, /review and send/);
  assert.match(message, /Last contacted/);
  assert.match(message, /50000 sq ft/);
  assert.doesNotMatch(message, /email sent|draft saved in Gmail/i);
});
