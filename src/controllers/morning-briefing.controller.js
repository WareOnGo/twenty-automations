import { sendMorningBriefings } from "../services/morning-briefing.service.js";

// Guard against overlapping runs (a slow send could exceed the schedule).
let running = false;

export async function sendMorningBriefing(req, res) {
  // Optional { "dryRunEmail": "x@wareongo.com" } redirects all mail to one box.
  const dryRunEmail = req.body?.dryRunEmail;

  if (running) return res.status(202).json({ status: "already_running" });
  running = true;
  try {
    const result = await sendMorningBriefings({ dryRunEmail });
    res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    console.error("[morning-briefing] run failed:", err.message);
    res.status(500).json({ status: "error", error: "Internal server error" });
  } finally {
    running = false;
  }
}
