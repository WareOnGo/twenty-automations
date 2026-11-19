import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import { createSyncEngine } from '../src/services/sync-engine.js';
import { listRecordPages } from '../src/services/twenty.service.js';
const { runSync } = createSyncEngine({ prisma, listRecordPages });

// Mirror-only backfill: bypass the scheduled service wrapper, which also dispatches reminders.
runSync({full:true})
  .then(result => {
    console.log(JSON.stringify(result));
    if (result.skipped || result.status !== 'ok') process.exitCode=1;
  })
  .catch(e => { console.error(JSON.stringify({error:'CRM_BACKFILL_FAILED',code:e.code})); process.exitCode=1; })
  .finally(() => prisma.$disconnect());
