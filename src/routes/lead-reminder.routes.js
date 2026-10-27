import { Router } from "express";
import { requireSecret } from "../lib/require-secret.js";
import { runLeadReminders } from "../services/lead-reminder.service.js";

export function createLeadReminderRouter(run = runLeadReminders) {
  const router = Router();
  router.use(requireSecret());
  router.post("/", async (req, res) => {
    if ((req.body != null && (Array.isArray(req.body) || typeof req.body !== "object")) ||
        Object.keys(req.body || {}).some(key => key !== "dispatch") ||
        (req.body?.dispatch !== undefined && typeof req.body.dispatch !== "boolean")) {
      return res.status(400).json({ error: "Use an optional boolean dispatch field" });
    }
    try {
      const result = await run({ preview: req.body?.dispatch !== true });
      res.set("Cache-Control", "no-store");
      return res.status(["partial", "source_unavailable"].includes(result.status) ? 503 : 200).json(result);
    } catch {
      return res.status(503).json({ status: "error", error: "REMINDER_RUN_FAILED" });
    }
  });
  return router;
}
export default createLeadReminderRouter();
