// End-to-end local dry run: real Express app -> sync/source -> Prisma over TCP ->
// disposable PostgreSQL -> real outbound client -> loopback recording stub.
// Forces synthetic configuration and checks a private in-memory DB marker before
// any migration/write through Prisma. It cannot forward a WhatsApp message.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mock } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const realFetch = globalThis.fetch;
const baseTime = "2026-10-27T03:30:00.000Z"; // 09:00 IST
const cutoff = "2026-10-26T18:30:00.000Z";
const key = "synthetic-local-dry-run-key";
const roster = [[12, "Maneesh"], [19, "Nihas"], [1, "Raghav"], [2, "Dhaval"], [5, "Jayanth"], [99, "Other"]]
  .map(([id, name]) => ({ id, name, phone: "+1999555" + String(id).padStart(4, "0"), member: "member-" + id }));
const phoneToId = new Map(roster.map(p => [p.phone, p.id]));
const report = { generatedAt: new Date().toISOString(), passed: [], failed: [], timeline: [],
  externalFetchAttempts: 0, realMessagesSent: 0, simulatedRequests: 0, simulatedAccepted: 0 };
const live = new Map(), notes = new Map(), tasks = new Map(), overrides = new Map();
let requests = [], accepted = new Map(), sourceFailure = false, failedStream = null, providerMode = "ok", providerState = "SENT";
let db, pg, socket, appServer, twentyServer, rameshServer, appBase, twentyBase, rameshBase;
const allowedOrigins = new Set();
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const listen = async server => {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = "http://127.0.0.1:" + server.address().port;
  allowedOrigins.add(origin);
  return origin;
};
const bodyOf = async req => { let text = ""; for await (const chunk of req) text += chunk; return text ? JSON.parse(text) : {}; };
const at = hours => mock.timers.setTime(Date.parse(baseTime) + hours * 3600000);
const lead = (assignee = "MANEESH", extra = {}) => ({
  id: randomUUID(), name: "Synthetic dry-run lead", createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), updatedBy: { source: "MANUAL", name: "Synthetic operator" },
  stage: "NEW_LEAD", assignedTo: assignee ? [assignee] : [], ownerId: null,
  companyName: "Synthetic client", pocName: { firstName: "Test", lastName: "Client" },
  city: "Bengaluru", requirementInSft: 50000, ...extra,
});
const update = (record, changes) => { Object.assign(record, changes, { updatedAt: new Date().toISOString() }); live.set(record.id, record); };

async function api(path, body = {}, auth = key) {
  const response = await fetch(appBase + path, { method: "POST", headers: {
    "Content-Type": "application/json", "X-Auth": auth }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
}
async function sync(expectedStatus = "ok") {
  const result = await api("/sync");
  assert.equal(result.status, expectedStatus === "ok" ? 200 : 503, JSON.stringify(result.body));
  assert.equal(result.body.status, expectedStatus, JSON.stringify(result.body));
  assert.ok(result.body.reminders, "the production /sync wiring must invoke reminders");
  return result.body.reminders;
}
const tick = () => api("/lead-reminders", { dispatch: true });
const rows = async () => db.$queryRaw`SELECT recipient_id,step,status,provider_state,opportunity_id,id FROM crm_lead_reminder_outbox ORDER BY opportunity_id,recipient_id,step`;
async function reset() {
  process.env.CRM_LEAD_REMINDERS_ENABLED = "true";
  process.env.CRM_REMINDER_NEW_LEADS_FROM = cutoff;
  live.clear(); notes.clear(); tasks.clear(); overrides.clear();
  requests = []; accepted = new Map(); sourceFailure = false; failedStream = null; providerMode = "ok"; providerState = "SENT";
  at(0);
  await db.$executeRawUnsafe("TRUNCATE crm_lead_reminder_outbox,crm_lead_reminder_state,crm_reminder_rollout,opportunities,sync_checkpoints,stage_transitions,crm_records,\"VerifiedNumber\"");
  for (const p of roster) await db.$executeRaw`
    INSERT INTO "VerifiedNumber"(id,name,phone_number,twenty_user_id,email) VALUES (${p.id},${p.name},${p.phone},${p.member},NULL)`;
}
async function scenario(name, run) {
  await reset();
  try { await run(); report.passed.push(name); console.log("PASS " + name); }
  catch (error) { report.failed.push({ name, error: error.message }); console.error("FAIL " + name + ": " + error.message); }
}

try {
  // Override connection configuration before importing any application module.
  // The HTTPS fake origin is translated only to our loopback recorder. All other
  // non-loopback fetches throw before networking, including email/OpenAI calls.
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: "/dev/null", DOTENV_CONFIG_QUIET: "true", REMINDER_SECRET: key,
    OPENAI_API_KEY: key, RESEND_API_KEY: key, TWENTY_CRM_API_KEY: key,
    CRM_LEAD_REMINDERS_ENABLED: "true", CRM_REMINDER_NEW_LEADS_FROM: cutoff,
    CRM_REMINDER_BETA_EMPLOYEE_IDS: "12,19,1,2,5", CRM_REMINDER_ESCALATION_EMPLOYEE_IDS: "2,5",
    CRM_REMINDER_ESCALATION_EXEMPT_EMPLOYEE_IDS: "2,5",
    CRM_REMINDER_ASSIGNEE_MAP: JSON.stringify(Object.fromEntries(roster.slice(0, 5).map(p => [p.name.toUpperCase(), p.id]))),
    RAMESH_API_URL: "https://ramesh.dry-run.invalid", RAMESH_AUTOMATION_API_KEY: key,
  });
  globalThis.fetch = async (input, options = {}) => {
    let url = new URL(input instanceof Request ? input.url : input);
    if (url.origin === "https://ramesh.dry-run.invalid") url = new URL(url.pathname + url.search, rameshBase);
    if (!allowedOrigins.has(url.origin)) {
      report.externalFetchAttempts++;
      throw new Error("DRY_RUN_BLOCKED_EXTERNAL_FETCH");
    }
    return realFetch(url, { ...options, redirect: "error" });
  };

  pg = await PGlite.create();
  const databaseMarker = randomUUID();
  await pg.exec("CREATE TABLE __crm_dry_run_guard (marker text NOT NULL)");
  await pg.query("INSERT INTO __crm_dry_run_guard VALUES ($1)", [databaseMarker]);
  await pg.exec(await readFile(new URL("./fixtures/reminder-dry-run-schema.sql", import.meta.url), "utf8"));
  await pg.exec(await readFile(new URL("../migrations/20261008_crm_records.sql", import.meta.url), "utf8"));
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0, maxConnections: 1 });
  await socket.start();
  const connection = new URL("postgresql://postgres:postgres@" + socket.getServerConn() + "/postgres");
  assert.equal(connection.hostname, "127.0.0.1");
  connection.searchParams.set("connection_limit", "1");
  connection.searchParams.set("sslmode", "disable");
  process.env.DATABASE_URL = connection.href;
  ({ default: db } = await import("../src/lib/prisma.js"));
  // Refuse all Prisma writes unless the connection reaches this exact disposable
  // database. This also guards against accidental future configuration changes.
  const [guard] = await db.$queryRaw`SELECT marker FROM __crm_dry_run_guard`;
  assert.equal(guard?.marker, databaseMarker, "Prisma must connect only to this dry-run DB");
  const { migrateLeadReminders } = await import("./migrate-lead-reminders.js");
  await migrateLeadReminders(db);

  twentyServer = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "GET");
      assert.equal(req.headers.authorization, "Bearer " + key);
      const url = new URL(req.url, "http://127.0.0.1");
      if (sourceFailure) return json(res, 503, { error: "synthetic source outage" });
      const [, , object, id] = url.pathname.split("/");
      if (object === failedStream) return json(res, 503, { error: "synthetic stream outage" });
      if (id) {
        const record = overrides.has(id) ? overrides.get(id) : live.get(id);
        return record ? json(res, 200, { data: { opportunity: record } }) : json(res, 404, {});
      }
      const records = [...({ opportunities: live, notes, tasks }[object] || new Map()).values()];
      const cursor = url.searchParams.get("starting_after");
      const offset = cursor ? records.findIndex(r => r.id === cursor) + 1 : 0;
      const batch = records.slice(offset, offset + Number(url.searchParams.get("limit") || 60));
      return json(res, 200, { data: { [object]: batch }, pageInfo: {
        hasNextPage: offset + batch.length < records.length, endCursor: batch.at(-1)?.id || null } });
    } catch { json(res, 500, { error: "synthetic stub assertion failed" }); }
  });
  twentyBase = await listen(twentyServer);
  process.env.TWENTY_CRM_BASE_URL = twentyBase;

  rameshServer = createServer(async (req, res) => {
    try {
      assert.equal(req.headers["x-ramesh-api-key"], key);
      if (req.method === "GET") {
        const id = req.url.split("/").at(-1);
        assert.ok([...accepted.values()].some(r => r.messageId === id));
        return json(res, 200, { messageId: id, state: providerState });
      }
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/v1/outbound-messages");
      const payload = await bodyOf(req);
      assert.ok(phoneToId.has(payload.to), "only synthetic recipients allowed");
      assert.equal(payload.expiresInSeconds, 900);
      assert.ok(payload.text.length <= 4000);
      const idempotencyKey = req.headers["idempotency-key"];
      assert.match(idempotencyKey, /^crm-beta-[0-9a-f-]{36}$/);
      requests.push({ idempotencyKey, recipientId: phoneToId.get(payload.to), payload });
      report.simulatedRequests++;
      if (providerMode === "503") return json(res, 503, {});
      const previous = accepted.get(idempotencyKey);
      if (previous) assert.deepEqual(payload, previous.payload, "retry must keep payload frozen");
      const messageId = previous?.messageId || randomUUID();
      if (!previous) { accepted.set(idempotencyKey, { messageId, payload }); report.simulatedAccepted++; }
      if (providerMode === "accept_then_drop") { providerMode = "ok"; req.socket.destroy(); return; }
      return json(res, 202, { messageId, status: previous ? "duplicate" : "queued" });
    } catch { json(res, 422, { error: "synthetic stub assertion failed" }); }
  });
  rameshBase = await listen(rameshServer);
  const { default: app } = await import("../src/app.js");
  appServer = createServer(app);
  appBase = await listen(appServer);
  mock.timers.enable({ apis: ["Date"], now: Date.parse(baseTime) });

  await scenario("HTTP authentication, dispatch kill switch and read-only preview", async () => {
    const record = lead(); live.set(record.id, record);
    assert.equal((await api("/lead-reminders", {}, "wrong")).status, 401);
    assert.equal((await api("/lead-reminders", { dispatch: "true" })).status, 400);
    process.env.CRM_LEAD_REMINDERS_ENABLED = "false";
    assert.equal((await sync()).status, "disabled");
    assert.equal((await tick()).body.status, "disabled");
    const before = await db.$queryRaw`SELECT (SELECT count(*) FROM crm_lead_reminder_state)::int AS states,(SELECT count(*) FROM crm_reminder_rollout)::int AS rollout,(SELECT count(*) FROM crm_lead_reminder_outbox)::int AS outbox`;
    const preview = await api("/lead-reminders");
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.cache, "no-store");
    assert.equal(preview.body.notifications.length, 1);
    assert.equal(preview.body.notifications[0].recipientId, 12);
    assert.match(preview.body.notifications[0].text, /Outreach draft/);
    assert.equal(requests.length, 0);
    assert.deepEqual(await db.$queryRaw`SELECT (SELECT count(*) FROM crm_lead_reminder_state)::int AS states,(SELECT count(*) FROM crm_reminder_rollout)::int AS rollout,(SELECT count(*) FROM crm_lead_reminder_outbox)::int AS outbox`, before);
  });

  await scenario("all five users receive 0/2/4h; only three non-founders escalate at 8h", async () => {
    for (const p of roster.slice(0, 5)) { const record = lead(p.name.toUpperCase()); live.set(record.id, record); }
    for (const [hours, expected] of [[0, 5], [2, 5], [4, 5], [8, 6]]) {
      at(hours);
      const result = await sync();
      assert.equal(result.queued, expected, JSON.stringify(result));
      const saved = await rows();
      report.timeline.push({ hours, queuedToRecorder: result.queued, totalUnique: accepted.size,
        recipients: saved.filter(r => r.step === String(hours)).map(r => r.recipient_id) });
      assert.equal((await tick()).body.queued, 0);
    }
    const saved = await rows();
    assert.equal(saved.length, 21);
    for (const p of roster.slice(0, 5)) {
      assert.deepEqual(saved.filter(r => r.recipient_id === p.id && r.step !== "8").map(r => r.step).sort(), ["0", "2", "4"]);
    }
    for (const founder of roster.filter(p => [2, 5].includes(p.id))) {
      assert.equal(saved.filter(r => r.recipient_id === founder.id && r.step === "8").length, 3);
      assert.ok(requests.filter(r => r.recipientId === founder.id && r.payload.text.startsWith("CRM follow-up"))
        .every(r => r.payload.text.includes("no management escalation")));
    }
  });

  await scenario("2,000 historical leads stay excluded after fresh assignment and stage edits", async () => {
    for (let i = 0; i < 2000; i++) {
      const record = lead("MANEESH", { createdAt: "2026-01-01T00:00:00Z" }); live.set(record.id, record);
    }
    const fresh = lead(); live.set(fresh.id, fresh);
    const excluded = lead("OTHER"); live.set(excluded.id, excluded);
    const result = await sync();
    assert.equal(result.examined, 2);
    assert.equal(result.queued, 1);
    assert.equal(await db.opportunity.count(), 2002);
    assert.deepEqual((await rows()).map(r => r.opportunity_id), [fresh.id]);
    const old = [...live.values()][0];
    live.clear(); live.set(old.id, old); live.set(fresh.id, fresh); live.set(excluded.id, excluded);
    at(2); update(old, { assignedTo: ["RAGHAV"], stage: "RFQ_RECEIVED" });
    assert.equal((await sync()).queued, 1);
    assert.ok((await rows()).every(r => r.opportunity_id === fresh.id));
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM crm_lead_reminder_state`)[0].n, 2);
  });

  await scenario("missing assignee notifies actual owner once; assignment starts its clock later", async () => {
    const record = lead(null, { ownerId: "member-1" }); live.set(record.id, record);
    assert.equal((await sync()).queued, 1);
    assert.deepEqual((await rows()).map(r => [r.recipient_id, r.step]), [[1, "owner"]]);
    at(4); assert.equal((await sync()).queued, 0);
    update(record, { assignedTo: ["NIHAS"] });
    assert.equal((await sync()).queued, 1);
    const [state] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${record.id}`;
    assert.equal(state.state.assignments[0].assignedAt, new Date().toISOString());
    at(6); assert.equal((await sync()).queued, 1);
    assert.match(requests.at(-1).payload.text, /2 working hours/);
  });

  await scenario("midnight IST cutoff excludes historical reassignments and keeps enrolling future leads", async () => {
    const historical = lead("MANEESH", { createdAt: "2026-10-26T18:29:59.999Z" });
    const midnight = lead("NIHAS", { createdAt: cutoff });
    live.set(historical.id, historical); live.set(midnight.id, midnight);
    assert.equal((await sync()).queued, 1);
    assert.deepEqual((await rows()).map(r => r.opportunity_id), [midnight.id]);
    at(2); update(historical, { assignedTo: ["RAGHAV"], stage: "RFQ_RECEIVED" });
    assert.equal((await sync()).queued, 1); // Only the eligible lead's 2h reminder.
    at(24); // 09:00 IST the next day: eligibility does not roll forward daily.
    const tomorrow = lead("RAGHAV"); live.set(tomorrow.id, tomorrow);
    assert.equal((await sync()).queued, 3); // Two overdue escalations plus one new assignment.
    const saved = await rows();
    assert.ok(saved.every(r => r.opportunity_id !== historical.id));
    assert.deepEqual(saved.filter(r => r.opportunity_id === tomorrow.id).map(r => [r.recipient_id, r.step]), [[1, "0"]]);
    assert.equal(saved.filter(r => r.opportunity_id === midnight.id && r.step === "8").length, 2);
    const [original] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${midnight.id}`;
    assert.equal(original.state.assignments[0].assignedAt, baseTime);
    assert.equal((await db.$queryRaw`SELECT count(*)::int AS n FROM crm_lead_reminder_state WHERE opportunity_id=${historical.id}`)[0].n, 0);
  });

  await scenario("missing owner is reported; creator and non-beta owner are never fallback recipients", async () => {
    const missing = lead(null, { createdBy: { workspaceMemberId: "member-1" } });
    const excluded = lead(null, { ownerId: "member-99" });
    live.set(missing.id, missing); live.set(excluded.id, excluded);
    const result = await sync("partial");
    assert.equal(result.status, "partial"); assert.equal(result.routingIssues, 1);
    assert.equal(requests.length, 0);
  });

  await scenario("contact update or intake exit stops later reminders through the sync path", async () => {
    const contacted = lead(), progressed = lead("RAGHAV");
    live.set(contacted.id, contacted); live.set(progressed.id, progressed);
    assert.equal((await sync()).queued, 2);
    at(1); update(contacted, { lastContacted: new Date().toISOString() });
    update(progressed, { stage: "PROPOSAL_SHARED" });
    for (const h of [2, 4, 8]) { at(h); assert.equal((await sync()).queued, 0); }
    assert.equal(accepted.size, 2);
  });

  await scenario("old contact, ordinary edits and linked notes do not complete the assignment", async () => {
    const record = lead("MANEESH", { lastContacted: "2026-10-26T06:30:00Z" }); live.set(record.id, record);
    await sync(); at(1); update(record, { description: "A new note is not evidence of client contact" });
    const note = { id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      updatedBy: { source: "MANUAL" }, bodyV2: { markdown: "Internal research" },
      noteTargets: [{ targetOpportunityId: record.id }] };
    notes.set(note.id, note);
    at(2); assert.equal((await sync()).queued, 1);
    assert.match(requests.at(-1).payload.text, /2 working hours/);
    at(8); assert.equal((await sync()).queued, 2);
  });

  await scenario("a pre-existing future contact value cannot silently complete a later assignment", async () => {
    const record = lead("MANEESH", { lastContacted: "2026-10-27T05:30:00.000Z" }); live.set(record.id, record);
    assert.equal((await sync()).queued, 1);
    at(2); assert.equal((await sync()).queued, 1);
    at(4); assert.equal((await sync()).queued, 1);
    at(8); assert.equal((await sync()).queued, 2);
  });

  await scenario("reassignment keeps unchanged clocks and stops the removed person's sequence", async () => {
    const record = lead(); live.set(record.id, record); await sync();
    at(1); update(record, { assignedTo: ["MANEESH", "RAGHAV"] });
    assert.equal((await sync()).queued, 1);
    at(2); assert.equal((await sync()).queued, 1);
    assert.equal(requests.at(-1).recipientId, 12);
    update(record, { assignedTo: ["RAGHAV"] }); await sync();
    at(3); assert.equal((await sync()).queued, 1); assert.equal(requests.at(-1).recipientId, 1);
    const [row] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${record.id}`;
    assert.equal(row.state.assignments.length, 2);
    assert.equal(row.state.assignments[0].assignedAt, baseTime);
    assert.equal(row.state.assignments[1].assignedAt, "2026-10-27T04:30:00.000Z");
    assert.ok(row.state.assignments[0].removedAt);
  });

  await scenario("live completion or deletion overrides a stale mirror immediately before send", async () => {
    const contacted = lead(), deleted = lead("NIHAS");
    live.set(contacted.id, contacted); live.set(deleted.id, deleted); await sync();
    at(2);
    overrides.set(contacted.id, { ...contacted, lastContacted: "2026-10-27T04:30:00Z" });
    overrides.set(deleted.id, null);
    assert.equal((await sync()).queued, 0);
    assert.equal(accepted.size, 2);
  });

  await scenario("live reassignment cannot be undone by an older mirror on a later tick", async () => {
    const record = lead(); live.set(record.id, record); await sync();
    at(2); overrides.set(record.id, { ...record, assignedTo: ["RAGHAV"] });
    assert.equal((await sync()).queued, 1);
    at(2 + 1 / 6); assert.equal((await tick()).body.queued, 0);
    const [row] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${record.id}`;
    assert.equal(row.state.assignments.length, 2);
    assert.equal(row.state.assignments[1].assignedAt, "2026-10-27T05:30:00.000Z");
  });

  await scenario("8h escalations exclude a founder who owns or shares assignment of the deal", async () => {
    const owned = lead("MANEESH", { ownerId: "member-2" });
    const shared = lead("MANEESH", { assignedTo: ["MANEESH", "JAYANTH"] });
    live.set(owned.id, owned); live.set(shared.id, shared); await sync();
    at(8); assert.equal((await sync()).queued, 2);
    const escalations = (await rows()).filter(r => r.step === "8");
    assert.deepEqual(escalations.filter(r => r.opportunity_id === owned.id).map(r => r.recipient_id), [5]);
    assert.deepEqual(escalations.filter(r => r.opportunity_id === shared.id).map(r => r.recipient_id), [2]);
  });

  await scenario("working-hour clock pauses overnight and resumes at 08:00 IST", async () => {
    at(10); const record = lead(); live.set(record.id, record); // 19:00 IST
    assert.equal((await sync()).queued, 1);
    at(12); assert.equal((await sync()).queued, 0); // 21:00
    at(23); assert.equal((await sync()).queued, 0); // 08:00 next day: one working hour
    at(24); assert.equal((await sync()).queued, 1); // 09:00: two working hours
    at(26); assert.equal((await sync()).queued, 1); // 11:00: four working hours
    at(30); assert.equal((await sync()).queued, 2); // 15:00: eight working hours
  });

  await scenario("accepted-but-disconnected POST retries the same key and frozen text once", async () => {
    const record = lead(); live.set(record.id, record);
    providerMode = "accept_then_drop";
    assert.equal((await sync("partial")).status, "partial");
    assert.equal(accepted.size, 1);
    at(1 / 6); update(record, { name: "Changed synthetic lead" });
    const preview = await api("/lead-reminders");
    assert.equal(preview.body.notifications[0].text, requests[0].payload.text);
    assert.equal(requests.length, 1);
    assert.equal((await sync()).queued, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(accepted.size, 1);
  });

  await scenario("a four-hour outage coalesces missed messages and supersedes the old attempt", async () => {
    const record = lead(); live.set(record.id, record); providerMode = "503";
    assert.equal((await sync("partial")).status, "partial");
    providerMode = "ok"; at(4);
    assert.equal((await sync()).queued, 1);
    assert.match(requests.at(-1).payload.text, /4 working hours/);
    assert.deepEqual((await rows()).map(r => [r.step, r.status]), [["0", "superseded"], ["4", "terminal"]]);
  });

  await scenario("uncertain provider outcome is recorded without a blind resend", async () => {
    const record = lead(); live.set(record.id, record); providerState = "UNCERTAIN";
    assert.equal((await sync("partial")).deliveryFailures, 1);
    assert.equal((await tick()).body.queued, 0);
    assert.equal(requests.length, 1);
    assert.equal((await rows())[0].provider_state, "UNCERTAIN");
  });

  await scenario("concurrent HTTP ticks use one database lease and do not duplicate enqueue", async () => {
    const record = lead(); live.set(record.id, record);
    process.env.CRM_LEAD_REMINDERS_ENABLED = "false"; await sync();
    process.env.CRM_LEAD_REMINDERS_ENABLED = "true";
    const results = await Promise.all([tick(), tick()]);
    assert.equal(results.reduce((sum, r) => sum + (r.body.queued || 0), 0), 1);
    assert.equal(requests.length, 1);
    assert.ok(results.every(r => ["ok", "locked"].includes(r.body.status)));
  });

  await scenario("database reconnect preserves assignment clocks and previous delivery records", async () => {
    const record = lead(); live.set(record.id, record); await sync();
    for (let i = 0; i < 3; i++) {
      await db.$disconnect();
      // Prisma disconnect can resolve before the one-connection test server has
      // observed TCP close. Wait for cleanup, rather than racing its connection cap.
      const deadline = performance.now() + 5000;
      while (socket.getStats().activeConnections && performance.now() < deadline) await delay(10);
      assert.equal(socket.getStats().activeConnections, 0, "test DB must finish disconnecting before reconnect");
      await db.$connect();
      assert.equal((await db.$queryRaw`SELECT marker FROM __crm_dry_run_guard`)[0].marker, databaseMarker);
    }
    at(2); assert.equal((await sync()).queued, 1);
    assert.match(requests.at(-1).payload.text, /2 working hours/);
    assert.equal((await tick()).body.queued, 0);
    const [row] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${record.id}`;
    assert.equal(row.state.assignments.length, 1);
    assert.equal(row.state.assignments[0].assignedAt, baseTime);
    assert.equal(accepted.size, 2);
  });

  await scenario("source outages and an immutable cutoff fail closed without new sends", async () => {
    const record = lead(); live.set(record.id, record); await sync();
    at(2); sourceFailure = true;
    assert.equal((await api("/sync")).status, 503);
    assert.equal((await tick()).body.status, "source_unavailable");
    assert.equal(requests.length, 1);
    sourceFailure = false; await sync();
    const before = requests.length;
    process.env.CRM_REMINDER_NEW_LEADS_FROM = "2026-10-27T01:00:00+05:30";
    assert.equal((await tick()).status, 503);
    assert.equal(requests.length, before);
  });

  await scenario("notes or tasks failure does not delay a healthy lead assignment clock", async () => {
    const record = lead(); live.set(record.id, record);
    failedStream = "notes";
    const first = await api("/sync");
    assert.equal(first.status, 503); // The failed notes stream is still reported.
    assert.equal(first.body.streams.opportunities.failures, 0);
    assert.equal(first.body.reminders?.queued, 1);
    const [row] = await db.$queryRaw`SELECT state FROM crm_lead_reminder_state WHERE opportunity_id=${record.id}`;
    assert.equal(row.state.assignments[0].assignedAt, baseTime);
    at(2); failedStream = "tasks";
    const next = await api("/sync");
    assert.equal(next.status, 503);
    assert.equal(next.body.reminders?.queued, 1);
    assert.match(requests.at(-1).payload.text, /2 working hours/);
  });

  await scenario("sync reports delivery and reminder configuration failures to HTTP callers", async () => {
    const record = lead(); live.set(record.id, record); providerMode = "503";
    const unavailable = await api("/sync");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.status, "partial");
    assert.equal(unavailable.body.reminders.status, "partial");
    assert.equal(unavailable.body.streams.opportunities.failures, 0);
    process.env.CRM_REMINDER_NEW_LEADS_FROM = "2020-01-01T00:00:00Z";
    const invalid = await api("/sync");
    assert.equal(invalid.status, 503);
    assert.equal(invalid.body.reminders.status, "error");
    assert.equal(requests.length, 1);
  });

  await scenario("a failed owner alert resumes after quiet hours without changing its key or text", async () => {
    at(10); const record = lead(null, { ownerId: "member-1" }); live.set(record.id, record);
    providerMode = "accept_then_drop";
    assert.equal((await sync("partial")).failures, 1);
    const original = structuredClone(requests[0]);
    at(12); providerMode = "ok";
    assert.equal((await sync()).queued, 0);
    assert.equal(requests.length, 1);
    at(23); assert.equal((await sync()).queued, 1);
    assert.deepEqual(requests.at(-1), original);
    assert.equal(accepted.size, 1);
  });

  await scenario("missing employee phone is surfaced without depending on email", async () => {
    await db.$executeRaw`UPDATE "VerifiedNumber" SET phone_number='' WHERE id=12`;
    const record = lead(); live.set(record.id, record);
    const result = await sync("partial");
    assert.equal(result.routingIssues, 1); assert.equal(result.queued, 0);
    at(8); assert.equal((await sync("partial")).queued, 2);
    assert.deepEqual(requests.map(r => r.recipientId).sort(), [2, 5]);
  });

  assert.equal(report.externalFetchAttempts, 0);
} catch (error) {
  report.failed.push({ name: "harness setup or safety assertion", error: error.message });
  console.error(error.stack);
} finally {
  mock.timers.reset();
  for (const server of [appServer, twentyServer, rameshServer]) {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  await db?.$disconnect();
  await socket?.stop();
  await pg?.close();
  globalThis.fetch = realFetch;
  const reportPath = process.argv.find(a => a.startsWith("--report="))?.slice(9) || "/tmp/crm-reminder-e2e-report.json";
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed.length, failed: report.failed.length,
    externalFetchAttempts: report.externalFetchAttempts, realMessagesSent: 0, reportPath }));
  if (report.failed.length || report.externalFetchAttempts) process.exitCode = 1;
}
