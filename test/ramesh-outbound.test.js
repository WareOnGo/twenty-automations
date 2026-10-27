import test from "node:test";
import assert from "node:assert/strict";
import { createRameshClient } from "../src/services/ramesh-outbound.client.js";

const id = "00000000-0000-8000-a000-000000000001";
const payload = { to: "+919000000012", text: "Synthetic reminder", expiresInSeconds: 900 };
test("transport keeps the exact key and payload on retry and uses only the dedicated credential", async () => {
  const calls = [];
  const client = createRameshClient({ apiUrl: "https://ramesh.example", apiKey: "synthetic-key",
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      if (calls.length === 1) throw new Error("provider body with secrets");
      return new Response(JSON.stringify({ messageId: id, status: "duplicate" }), { status: 202 });
    } });
  await assert.rejects(client.enqueue(id, payload), /RAMESH_REQUEST_UNCERTAIN/);
  await client.enqueue(id, payload);
  assert.equal(calls[0].body, calls[1].body);
  assert.equal(calls[0].headers["Idempotency-Key"], calls[1].headers["Idempotency-Key"]);
  assert.equal(calls[0].headers["X-Ramesh-Api-Key"], "synthetic-key");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(calls[0].redirect, "error");
});

test("errors never contain provider bodies and ambiguous response does not claim success", async () => {
  const client = createRameshClient({ apiUrl: "https://ramesh.example", apiKey: "synthetic-key",
    fetchImpl: async () => new Response("private data", { status: 503 }) });
  await assert.rejects(client.enqueue(id, payload), error => error.status === 503 && error.message === "RAMESH_HTTP_503");
  const malformed = createRameshClient({ apiUrl: "https://ramesh.example", apiKey: "synthetic-key",
    fetchImpl: async () => new Response(JSON.stringify({ messageId: "bad", status: "queued" }), { status: 202 }) });
  await assert.rejects(malformed.enqueue(id, payload), /INVALID_RESPONSE/);
});

test("SENT and UNCERTAIN are transport outcomes, not CRM completion", async () => {
  for (const state of ["SENT", "UNCERTAIN", "FAILED", "EXPIRED"]) {
    const client = createRameshClient({ apiUrl: "https://ramesh.example", apiKey: "synthetic-key",
      fetchImpl: async () => new Response(JSON.stringify({ messageId: id, state })) });
    assert.equal((await client.status(id)).state, state);
  }
});
