import "dotenv/config";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

export async function migrateLeadReminders(db) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    const existing = await tx.$queryRaw`
      SELECT relname, obj_description(oid,'pg_class') AS marker FROM pg_class
      WHERE oid IN (to_regclass('public.crm_reminder_rollout'),
        to_regclass('public.crm_lead_reminder_state'),to_regclass('public.crm_lead_reminder_outbox'))`;
    if (existing.length) {
      if (existing.length !== 3 || existing.some(r => !r.marker?.startsWith("wareongo.crm-reminders.v1:"))) {
        throw new Error("UNRECOGNIZED_REMINDER_SCHEMA");
      }
      return { alreadyApplied: true };
    }
    const sql = fs.readFileSync(new URL("../migrations/20261022_lead_reminders.sql", import.meta.url), "utf8");
    for (const statement of sql.split("-- statement-breakpoint")) {
      if (statement.trim()) await tx.$executeRawUnsafe(statement);
    }
    return { applied: true };
  }, { timeout: 30000 });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = new PrismaClient();
  migrateLeadReminders(db).then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(JSON.stringify({ error: "REMINDER_MIGRATION_FAILED", code: e.code })); process.exitCode = 1; })
    .finally(() => db.$disconnect());
}
