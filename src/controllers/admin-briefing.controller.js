import { sendAdminBriefing } from "../services/admin-briefing.service.js";

let running = false;

export async function adminBriefing(req, res) {
  const dryRunEmail = req.body?.dryRunEmail;
  if (running) return res.status(202).json({ status: "already_running" });
  running = true;
  try {
    const result = await sendAdminBriefing({ dryRunEmail });
    res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    console.error("[admin-briefing] run failed:", err.message);
    res.status(500).json({ status: "error", error: "Internal server error" });
  } finally {
    running = false;
  }
}
