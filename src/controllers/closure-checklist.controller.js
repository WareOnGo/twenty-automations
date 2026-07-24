import { sendClosureChecklistFor, scanClosureTriggers } from "../services/closure-checklist.service.js";

// POST /closure-checklist
//   { "opportunityId": "..." }  -> send checklist for that deal
//   { "scan": true }            -> find all site-visit-success deals and send each
//   optional "dryRunEmail" redirects mail to one box.
export async function closureChecklist(req, res) {
  const { opportunityId, scan, dryRunEmail } = req.body || {};

  try {
    if (scan) {
      const ids = await scanClosureTriggers();
      const results = [];
      for (const id of ids) {
        try {
          results.push({ id, ...(await sendClosureChecklistFor(id, { dryRunEmail })) });
        } catch (err) {
          results.push({ id, sent: false, error: err.message });
        }
      }
      return res.status(200).json({ status: "ok", scanned: ids.length, results });
    }

    if (!opportunityId) {
      return res.status(400).json({ error: "Provide 'opportunityId' or 'scan': true" });
    }
    const result = await sendClosureChecklistFor(opportunityId, { dryRunEmail });
    res.status(200).json({ status: "ok", ...result });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ status: "error", error: status >= 500 ? "Internal server error" : err.message });
  }
}
