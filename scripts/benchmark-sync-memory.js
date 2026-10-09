// Synthetic, local-only sync benchmark. No credentials, network or database.
// Run each version in a fresh process with the same Node version and heap limit.
// The adapters emulate JSON parsing/serialization but not Prisma's native memory.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';

const options = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split('=')));
const count = Number(options.records ?? 2000);
const cycles = Number(options.cycles ?? 8);
if (![count, cycles].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Positive --records and --cycles required');
const root = options.source ? pathToFileURL(`${resolve(options.source)}/`) : new URL('../', import.meta.url);
const { createSyncEngine } = await import(new URL('src/services/sync-engine.js', root));
const transport = await import(new URL('src/services/twenty.service.js', root));
process.env.TWENTY_CRM_BASE_URL = 'https://synthetic.invalid';
process.env.TWENTY_CRM_API_KEY = 'synthetic-only';
const sizes = { opportunities: count, notes: Math.ceil(count / 5), tasks: Math.ceil(count / 20) };
const at = '2026-10-09T00:00:00.000Z';
const checkpoints = new Map();
const writes = { opportunities: 0, notes: 0, tasks: 0 };
let largestRead = 0;
let sampledRss = 0;
const observe = () => { sampledRss = Math.max(sampledRss, process.memoryUsage().rss); };

function record(object, index) {
  const common = { id: `${object}-${index}`, createdAt: at, updatedAt: at, updatedBy: { source: 'API' } };
  if (object !== 'opportunities') return { ...common, bodyV2: { markdown: `Synthetic ${index} `.repeat(300) },
    [object === 'notes' ? 'noteTargets' : 'taskTargets']: [{ targetOpportunityId: `opportunities-${index % count}` }] };
  return { ...common, name: `Synthetic opportunity ${index}`, stage: 'NEW_LEAD', assignedTo: [],
    secondaryAssignee: 'SYNTHETIC', timelineActivities: Array.from({ length: 35 }, (_, item) => ({
      id: `activity-${index}-${item}`, createdAt: at, updatedAt: at,
      properties: { title: `Synthetic event ${index}-${item}`, detail: `Synthetic detail ${index}-${item} `.repeat(4) },
    })) };
}

const fetchImpl = async url => {
  const object = url.pathname.split('/').at(-1);
  const offset = Number(url.searchParams.get('starting_after') ?? 0);
  const limit = Number(url.searchParams.get('limit'));
  const end = Math.min(offset + limit, sizes[object]);
  await setImmediate();
  return { ok: true, json: async () => {
    const body = JSON.parse(JSON.stringify({ data: { [object]: Array.from({ length: end - offset }, (_, i) => record(object, offset + i)) },
      pageInfo: { hasNextPage: end < sizes[object], endCursor: String(end) } }));
    observe();
    return body;
  } };
};
const prisma = {
  verifiedNumber: { findMany: async () => [] },
  syncCheckpoint: {
    findUnique: async ({ where }) => checkpoints.get(where.object),
    create: async ({ data }) => { if (checkpoints.has(data.object)) throw new Error('lock exists'); checkpoints.set(data.object, data); },
    updateMany: async ({ where, data }) => {
      const row = checkpoints.get(where.object);
      if (!row || (where.OR && row.lastRunStatus === 'locked')) return { count: 0 };
      Object.assign(row, data); return { count: 1 };
    },
    upsert: async ({ where, create, update }) => checkpoints.set(where.object, { ...checkpoints.get(where.object), ...(checkpoints.has(where.object) ? update : create) }),
  },
  opportunity: {
    findMany: async ({ where, select }) => {
      largestRead = Math.max(largestRead, where.opportunityId.in.length);
      const rows = where.opportunityId.in.map(id => ({ opportunityId: id, stage: 'NEW_LEAD',
        ...(!select || select.data ? { data: JSON.parse(JSON.stringify(record('opportunities', Number(id.split('-').at(-1))))) } : {}),
        lastMeaningfulUpdateAt: null, lastNoteAt: null, lastTaskAt: null }));
      observe();
      return rows;
    },
    upsert: async ({ update }) => { JSON.parse(JSON.stringify(update)); writes.opportunities++; observe(); },
    update: async ({ data }) => { JSON.stringify(data); },
    count: async ({ where }) => where.opportunityId ? 0 : count,
    updateMany: async () => ({ count: 0 }),
  },
  $executeRaw: async (strings, ...values) => { JSON.parse(values[2]); writes[values[0]]++; observe(); return 1; },
  $queryRaw: async () => [{ active: 0, stale: 0 }],
};
const engine = createSyncEngine({ prisma, logger: { log() {}, warn() {}, error() {} },
  listRecordsSince: (object, opts) => transport.listRecordsSince(object, { ...opts, fetchImpl }),
  listRecordPages: (object, opts) => transport.listRecordPages(object, { ...opts, fetchImpl }),
});
const measurements = [];
const started = performance.now();
for (let cycle = 1; cycle <= cycles; cycle++) {
  const result = await engine.runSync({ full: cycle % 2 === 0 });
  assert.equal(result.status, 'ok');
  for (const object of Object.keys(sizes)) {
    assert.equal(result.streams[object].count, sizes[object]);
    assert.equal(writes[object], cycle * sizes[object]);
  }
  observe();
  measurements.push({ cycle, rssMiB: Math.round(process.memoryUsage().rss / 1048576), heapUsedMiB: Math.round(process.memoryUsage().heapUsed / 1048576) });
}
console.log(JSON.stringify({ node: process.version, recordsPerCycle: sizes, cycles,
  opportunityJsonKiB: Math.round(Buffer.byteLength(JSON.stringify(record('opportunities', 1000))) / 1024),
  largestMirrorRead: largestRead, maxSampledRssMiB: Math.round(sampledRss / 1048576),
  maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024),
  elapsedMs: Math.round(performance.now() - started), measurements }, null, 2));
