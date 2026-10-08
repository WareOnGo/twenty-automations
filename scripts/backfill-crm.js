import 'dotenv/config';
import prisma from '../src/lib/prisma.js';
import { runSync } from '../src/services/sync.service.js';

// Reads Twenty and writes the mirror only; no briefing/email jobs are called.
runSync({full:true})
  .then(result => {
    console.log(JSON.stringify(result));
    if (result.skipped || result.status !== 'ok') process.exitCode=1;
  })
  .catch(e => { console.error(JSON.stringify({error:'CRM_BACKFILL_FAILED',code:e.code})); process.exitCode=1; })
  .finally(() => prisma.$disconnect());
