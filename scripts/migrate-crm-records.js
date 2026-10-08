import 'dotenv/config';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

// Idempotent additive migration. Unknown pre-existing tables are never replaced.
export async function migrateCrmRecords(db) {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET LOCAL lock_timeout='3s'");
    const existing = await tx.$queryRaw`
      SELECT obj_description(oid,'pg_class') AS marker FROM pg_class
      WHERE oid=to_regclass('public.crm_records')`;
    if (existing.length) {
      if (!existing[0].marker?.startsWith('wareongo.crm-sync.v1:')) {
        throw new Error('Refusing to reuse an unrecognized crm_records table');
      }
      return { alreadyApplied: true };
    }
    const sql = fs.readFileSync(new URL('../migrations/20261008_crm_records.sql', import.meta.url),'utf8');
    for (const statement of sql.split('-- statement-breakpoint')) {
      if (statement.trim()) await tx.$executeRawUnsafe(statement);
    }
    return { applied: true };
  }, { timeout: 30000 });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const db = new PrismaClient();
  migrateCrmRecords(db).then(r => console.log(JSON.stringify(r)))
    .catch(e => { console.error(JSON.stringify({error:'CRM_MIGRATION_FAILED',code:e.code,sqlState:e.meta?.code})); process.exitCode=1; })
    .finally(() => db.$disconnect());
}
