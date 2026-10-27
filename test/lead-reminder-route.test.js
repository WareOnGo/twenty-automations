import test from "node:test";
import assert from "node:assert/strict";
import { createLeadReminderRouter } from "../src/routes/lead-reminder.routes.js";

test("reminder route requires authentication, defaults to preview and accepts only explicit boolean dispatch", async () => {
  const previous = process.env.REMINDER_SECRET;
  process.env.REMINDER_SECRET = "synthetic-route-secret";
  try {
    const calls = [];
    const router = createLeadReminderRouter(async options => { calls.push(options); return { status: "ok", ...options }; });
    const invoke = (body, auth = "synthetic-route-secret") => new Promise((resolve, reject) => {
      const result = { status: 200, headers: {} };
      const res = { status(code) { result.status = code; return this; },
        set(name, value) { result.headers[name] = value; return this; },
        json(body) { resolve({ ...result, body }); } };
      router.handle({ url: "/", method: "POST", body, header: () => auth }, res, reject);
    });
    assert.equal((await invoke({}, "wrong")).status, 401);
    assert.equal((await invoke({ dispatch: "true" })).status, 400);
    assert.equal((await invoke([])).status, 400);
    assert.equal((await invoke({ dispatch: true, bypassWhitelist: true })).status, 400);
    assert.equal(calls.length, 0);
    const preview = await invoke({});
    assert.equal(preview.body.preview, true);
    assert.equal(preview.headers["Cache-Control"], "no-store");
    assert.equal((await invoke({ dispatch: false })).body.preview, true);
    assert.equal((await invoke({ dispatch: true })).body.preview, false);
    assert.deepEqual(calls, [{ preview: true }, { preview: true }, { preview: false }]);
  } finally {
    if (previous === undefined) delete process.env.REMINDER_SECRET;
    else process.env.REMINDER_SECRET = previous;
  }
});
