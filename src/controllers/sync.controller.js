import { runSync } from "../services/sync.service.js";

// Guards against overlapping runs: pg_cron fires every 10 min, but a full
// reconcile (or a slow Twenty) could exceed that. If a run is already in
// flight we return 202 and skip rather than double-processing.
let running = false;

export async function triggerSync(req, res) {
  const full = req.body?.full === true || req.query?.full === "true";

  if (running) {
    return res.status(202).json({ status: "already_running" });
  }

  running = true;
  try {
    const summary = await runSync({ full });
    res.status(200).json({ status: "ok", ...summary });
  } catch (err) {
    console.error("[sync] run failed:", err.message);
    res.status(500).json({ status: "error", error: "Internal server error" });
  } finally {
    running = false;
  }
}
