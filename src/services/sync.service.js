import prisma from "../lib/prisma.js";
import { listRecordPages } from "./twenty.service.js";
import { createSyncEngine } from "./sync-engine.js";
import { runLeadReminders } from "./lead-reminder.service.js";

const engine = createSyncEngine({ prisma, listRecordPages });

export async function runSync(options) {
  const summary = await engine.runSync(options);
  if (!summary.skipped) {
    // The reminder source checks opportunity freshness itself. Unrelated notes
    // or tasks failures must not postpone assignment observation and its clock.
    try { summary.reminders = await runLeadReminders({ preview: false }); }
    catch { summary.reminders = { status: "error", reason: "REMINDER_RUN_FAILED" }; }
    if (["partial", "source_unavailable", "error"].includes(summary.reminders.status)) summary.status = "partial";
  }
  return summary;
}
