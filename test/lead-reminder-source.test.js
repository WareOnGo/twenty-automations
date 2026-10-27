import test from "node:test";
import assert from "node:assert/strict";
import { createReminderSource } from "../src/services/lead-reminder-source.js";

const now = new Date("2026-10-27T03:30:00Z");
const env = { TWENTY_CRM_BASE_URL: "https://crm.example", TWENTY_CRM_API_KEY: "synthetic-secret" };
const id = "00000000-0000-4000-8000-000000000001";

test("only a recent successful and unlocked mirror can dispatch", async () => {
  for (const [status, age, locked, expected] of [
    ["ok", 0, false, true], ["error", 0, false, false], ["ok", 21, false, false],
    ["ok", -1, false, false], ["ok", 0, true, false],
  ]) {
    const db = { syncCheckpoint: { findUnique: async ({ where }) => where.object === "opportunities"
      ? { lastRunStatus: status, lastRunAt: new Date(+now - age * 60000) }
      : locked ? { lastRunStatus: "locked", lastRunAt: now } : null } };
    assert.equal(await createReminderSource(db).healthy(now), expected);
  }
});

test("pages filter by source creation cutoff, stream by cursor and reject stale or future snapshots", async () => {
  const calls = [];
  const rows = [
    { opportunityId: "a", lastPolledAt: now, data: { id: "a" } },
    { opportunityId: "b", lastPolledAt: new Date(+now - 21 * 60000), data: { id: "b" } },
    { opportunityId: "c", lastPolledAt: new Date(+now + 60000), data: { id: "c" } },
  ];
  const db = { opportunity: { findMany: async args => { calls.push(args); return calls.length === 1 ? rows : []; } } };
  const source = createReminderSource(db);
  const found = [];
  for await (const page of source.pages("2026-10-27T00:00:00+05:30", now)) found.push(...page);
  assert.deepEqual(found.map(r => r.data.id), ["a"]);
  assert.equal(calls[0].where.twentyCreatedAt.gte.toISOString(), "2026-10-26T18:30:00.000Z");
  assert.deepEqual(calls[1].cursor, { opportunityId: "c" });
  assert.equal(calls[1].skip, 1);
});

test("live preflight authenticates to the specific opportunity endpoint and validates its envelope", async () => {
  const record = { id, stage: "NEW_LEAD", assignedTo: ["MANEESH"] };
  const source = createReminderSource({}, { env, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, "/rest/opportunities/" + id);
    assert.equal(url.searchParams.get("depth"), "1");
    assert.equal(options.headers.Authorization, "Bearer synthetic-secret");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return new Response(JSON.stringify({ data: { opportunity: record } }));
  } });
  assert.deepEqual(await source.current(id), record);
  await assert.rejects(source.current("../other"), /INVALID_LEAD_ID/);
});

test("404 means removed; malformed, failed and mismatched live reads never return a lead", async () => {
  assert.equal(await createReminderSource({}, { env, fetchImpl: async () => new Response("", { status: 404 }) }).current(id), null);
  for (const response of [
    new Response("synthetic confidential provider detail", { status: 500 }),
    new Response(JSON.stringify({ data: { opportunity: { id: "wrong", stage: "NEW_LEAD" } } })),
    new Response("{}"),
  ]) {
    const source = createReminderSource({}, { env, fetchImpl: async () => response });
    await assert.rejects(source.current(id), error => error.message === "SOURCE_READ_FAILED");
  }
});
