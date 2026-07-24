import { Router } from "express";
import { triggerSync } from "../controllers/sync.controller.js";

const router = Router();

// Same shared-secret guard as /send-reminder: pg_cron sends the secret in the
// X-Auth header. Reuses REMINDER_SECRET so no new prod config is required.
router.use((req, res, next) => {
  const expected = process.env.REMINDER_SECRET;
  if (!expected) {
    console.error("[sync] REMINDER_SECRET not set — refusing all requests");
    return res.status(503).json({ error: "Server not configured" });
  }
  if (req.header("x-auth") !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

router.post("/", triggerSync);

export default router;
