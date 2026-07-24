import prisma from "../lib/prisma.js";
import { listRecordsSince } from "./twenty.service.js";

// ---------------------------------------------------------------------------
// Polling-based sync: mirrors Twenty opportunities/notes/tasks into Postgres
// and computes each deal's "meaningful update" clock ourselves.
//
// Why we compute our own clock instead of trusting Twenty's `updatedAt`:
//   1. Adding a note/task does NOT bump the opportunity's updatedAt (they are
//      separate objects), so we poll notes/tasks as their own streams and link
//      them back via targetOpportunityId.
//   2. Our own API writebacks (e.g. followupcount) DO bump updatedAt. Twenty
//      tags every change with updatedBy.source = MANUAL | API — we count only
//      MANUAL changes as "meaningful".
//
// See COMPLIANCE.md for the full rule set. This module is the only writer of
// the polling columns (last_meaningful_update_at, last_note_*, stage_entered_at,
// stage_transitions, sync_checkpoints). It never touches the deprecated
// reminder_* columns, which the legacy webhook/reminder pipeline still owns.
// ---------------------------------------------------------------------------

// Opportunity fields whose change counts as a meaningful (human) update.
// Allowlist, not denylist: the REST record carries many system fields
// (searchVector, position, timelineActivities, favorites, updatedAt...) that
// must never count. Reassignment (assignedTo/ownerId) is intentionally excluded
// — it is not sales activity on the deal.
const QUALIFYING_OPP_FIELDS = [
  "stage",
  "name",
  "description",
  "pocName",
  "pocPhoneNumber",
  "companyName",
  "companyEmail",
  "pointOfContactId",
  "companyId",
  "amount",
  "duration",
  "budget",
  "city",
  "microMarket",
  "requirementInSft",
  "priority",
  "leadSource",
  "repeatClient",
  "industryVertical",
  "occupancyTimeline",
  "supplyLead",
  "closeDate",
  "lastContacted",
  "nextFollowUp",
];

// Heavy/noisy fields dropped from the stored snapshot to keep the JSONB lean
// and diffs stable. Diffing uses the allowlist above, so this never affects
// meaningful-change detection.
const SNAPSHOT_DROP_FIELDS = ["searchVector", "timelineActivities", "favorites", "position"];

// Re-poll a small window before the watermark so records straddling the
// boundary are never missed. Re-processing is idempotent.
const OVERLAP_MS = 2 * 60 * 1000;
const NOTE_TEXT_MAX = 2000;
// Full-reconcile soft-delete safety valve: never soft-delete more than this
// fraction of the active mirror in one run (guards against a truncated Twenty
// response wiping live deals). Also never delete when nothing came back.
const MAX_DELETE_FRACTION = 0.2;
const MAX_DELETE_FLOOR = 50;

function isManual(record) {
  return record?.updatedBy?.source === "MANUAL";
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Latest of two dates, tolerating nulls. Used so a clock only ever moves forward.
function maxDate(a, b) {
  const da = toDate(a);
  const db = toDate(b);
  if (!da) return db;
  if (!db) return da;
  return da >= db ? da : db;
}

function stripSnapshot(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    if (SNAPSHOT_DROP_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

// A stored snapshot written by THIS module is REST-shaped (camelCase
// `updatedAt`). The legacy webhook writes a different shape (`last_updated`,
// "POC Name"). We can only field-diff REST-vs-REST, so on the first sync of a
// webhook-era row we fall back to seeding from updatedBy.source instead.
function isRestSnapshot(data) {
  return !!data && typeof data === "object" && "updatedAt" in data;
}

function changedQualifyingFields(prev, next) {
  const changed = [];
  for (const f of QUALIFYING_OPP_FIELDS) {
    if (JSON.stringify(prev?.[f]) !== JSON.stringify(next?.[f])) changed.push(f);
  }
  return changed;
}

// Derive who "owns" this deal for briefing/compliance purposes: the people it
// is ASSIGNED to (Twenty `assignedTo`). The owner/creator (synonymous here —
// the first-touch POC who logged the deal) is used ONLY as a fallback when
// there are no assignees, so creating a deal alone never lands it in your
// briefing. Everything is resolved through the roster maps and lowercased to one
// canonical email per person; assignees with no roster match fall back to the
// <firstname>@wareongo.com slug. Deduped.
function deriveAssigneeEmail(record, { byId, byFirstName }) {
  const emails = [];
  const push = (e) => {
    if (e) emails.push(String(e).trim().toLowerCase());
  };

  for (const name of record?.assignedTo ?? []) {
    const key = String(name).trim().toUpperCase();
    const slug = String(name).replace(/\s+/g, "").toLowerCase();
    push(byFirstName.get(key) || (slug ? `${slug}@wareongo.com` : null));
  }

  // Fallback only when nobody is assigned: attribute to the owner/creator.
  // `ownerId` is often null on the record while createdBy is populated, so try
  // both (they resolve to the same person).
  if (emails.length === 0) {
    push(byId.get(record?.ownerId) || byId.get(record?.createdBy?.workspaceMemberId));
  }

  const seen = new Set();
  const out = [];
  for (const e of emails) {
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out.length ? out.join(",") : null;
}

function noteText(record) {
  const md = record?.bodyV2?.markdown;
  if (typeof md === "string" && md.trim()) return md.trim().slice(0, NOTE_TEXT_MAX);
  return null;
}

// Load VerifiedNumber once per run into two lowercased lookups:
//   byId        : twenty workspace member id -> roster email
//   byFirstName : UPPERCASE first name       -> roster email
// Emails are lowercased so stored assigneeEmail is always canonical (the
// briefing/hygiene queries match case-sensitively). Resolving assignees through
// the roster (not synthesised slugs) keeps ONE identity per person, so owner,
// creator, and assignee collapse to the same email and never double-count.
async function loadMemberMaps() {
  const rows = await prisma.verifiedNumber.findMany({
    where: { email: { not: null } },
    select: { twenty_user_id: true, email: true, name: true },
  });
  const byId = new Map();
  const byFirstName = new Map();
  for (const r of rows) {
    const email = r.email.trim().toLowerCase();
    if (r.twenty_user_id) byId.set(r.twenty_user_id, email);
    if (r.name) byFirstName.set(r.name.trim().split(/\s+/)[0].toUpperCase(), email);
  }
  return { byId, byFirstName };
}

async function getCheckpoint(object) {
  return prisma.syncCheckpoint.findUnique({ where: { object } });
}

async function saveCheckpoint(object, { watermark, status, error }) {
  const data = {
    lastRunAt: new Date(),
    lastRunStatus: status,
    lastError: error ?? null,
  };
  // Only advance the watermark on success and only forwards.
  if (status === "ok" && watermark) data.lastUpdatedAt = watermark;
  await prisma.syncCheckpoint.upsert({
    where: { object },
    update: data,
    create: { object, ...data },
  });
}

// ---------------------------------------------------------------------------
// Opportunity stream
// ---------------------------------------------------------------------------
async function syncOpportunities({ sinceISO, memberMaps, full }) {
  const records = await listRecordsSince("opportunities", { sinceISO, depth: 1 });
  let watermark = null;
  const liveIds = full ? new Set() : null;

  // Bulk-load existing mirror rows for this batch in one query (avoids an N+1
  // findUnique per record).
  const existingById = new Map();
  if (records.length) {
    const rows = await prisma.opportunity.findMany({
      where: { opportunityId: { in: records.map((r) => r.id) } },
    });
    for (const row of rows) existingById.set(row.opportunityId, row);
  }

  let failures = 0;
  for (const rec of records) {
    // Record exists in Twenty even if we fail to process it — add to liveIds
    // BEFORE the try so a processing error can't cause it to be soft-deleted
    // during a full reconcile.
    if (liveIds) liveIds.add(rec.id);

    try {
    const existing = existingById.get(rec.id) ?? null;
    const prevData = existing?.data;
    const prevIsRest = isRestSnapshot(prevData);
    const prevStage = prevData?.stage ?? existing?.stage ?? null;

    // --- meaningful opportunity-field change ---
    let meaningful;
    if (!prevIsRest) {
      // First sync of this row (new, or webhook-shaped) — can't field-diff.
      // Seed from source: treat as meaningful iff the last edit was manual.
      meaningful = isManual(rec);
    } else {
      meaningful = changedQualifyingFields(prevData, rec).length > 0 && isManual(rec);
    }

    const updatedAt = toDate(rec.updatedAt);
    const createdAt = toDate(rec.createdAt);

    // --- stage transition ---
    // Only log a REAL observed move: an already-mirrored row whose known stage
    // changed. First-sight rows (existing == null) get a baseline stage but no
    // synthetic transition — the deal entered that stage long before we saw it,
    // so a null->stage row dated "now" would corrupt TAT analysis.
    const stageChanged = !!existing && prevStage != null && prevStage !== rec.stage && rec.stage != null;

    // stageEnteredAt: exact when we observe a transition; on a brand-new row use
    // createdAt; otherwise keep what we had, seeding with updatedAt only when we
    // have nothing (approximate for webhook-era rows, self-heals on next move).
    let stageEnteredAt = existing?.stageEnteredAt ?? null;
    if (stageChanged) stageEnteredAt = updatedAt;
    else if (!existing) stageEnteredAt = createdAt ?? updatedAt;
    else if (!stageEnteredAt) stageEnteredAt = updatedAt;

    const meaningfulAt = meaningful ? updatedAt : null;
    const newMeaningful = maxDate(existing?.lastMeaningfulUpdateAt, meaningfulAt);
    const advanced = meaningfulAt && (!existing?.lastMeaningfulUpdateAt || meaningfulAt > toDate(existing.lastMeaningfulUpdateAt));

    const shared = {
      data: stripSnapshot(rec),
      stage: rec.stage ?? null,
      name: rec.name ?? null,
      priority: rec.priority ?? null,
      city: rec.city ?? null,
      companyName: rec.companyName ?? null,
      assignedTo: rec.assignedTo ?? null,
      ownerId: rec.ownerId ?? null,
      assigneeEmail: deriveAssigneeEmail(rec, memberMaps),
      lastContacted: toDate(rec.lastContacted),
      nextFollowUp: toDate(rec.nextFollowUp),
      twentyCreatedAt: createdAt,
      twentyUpdatedAt: updatedAt,
      deletedAt: toDate(rec.deletedAt),
      stageEnteredAt,
      lastMeaningfulUpdateAt: newMeaningful,
      lastPolledAt: new Date(),
    };
    if (advanced) {
      shared.lastMeaningfulUpdateKind = stageChanged ? "stage" : "opportunity";
      shared.lastMeaningfulUpdateBy = rec.updatedBy?.name ?? null;
    }

    const upsert = prisma.opportunity.upsert({
      where: { opportunityId: rec.id },
      update: shared,
      create: { opportunityId: rec.id, ...shared },
    });

    if (stageChanged) {
      // Atomic: the transition row and the snapshot update commit together. If
      // the upsert fails, the transition is rolled back too — otherwise the
      // stale prevStage would re-fire and log a DUPLICATE transition next run.
      await prisma.$transaction([
        prisma.stageTransition.create({
          data: {
            opportunityId: rec.id,
            fromStage: prevStage,
            toStage: rec.stage,
            changedAt: updatedAt ?? new Date(),
          },
        }),
        upsert,
      ]);
    } else {
      await upsert;
    }

    // Advance the watermark only for records that fully succeed. Note: because
    // records are ascending by updatedAt, a LATER success still moves the
    // watermark past an earlier failed record, so that failed record is NOT
    // retried by the next delta run — the nightly full reconcile is its backstop.
    watermark = maxDate(watermark, rec.updatedAt);
    } catch (err) {
      failures++;
      console.error(`[sync] opportunity ${rec.id} failed: ${err.message}`);
    }
  }

  // Full reconcile also catches records that vanished from Twenty (hard-deleted
  // or filtered out) — soft-delete them locally. Guard against a truncated
  // Twenty response: never soft-delete when nothing came back, and never more
  // than MAX_DELETE_FRACTION of the active mirror in one run.
  let softDeleted = 0;
  if (full && liveIds) {
    const activeCount = await prisma.opportunity.count({ where: { deletedAt: null } });
    const staleCount = await prisma.opportunity.count({
      where: { deletedAt: null, opportunityId: { notIn: [...liveIds] } },
    });
    const limit = Math.max(MAX_DELETE_FLOOR, Math.floor(activeCount * MAX_DELETE_FRACTION));
    if (liveIds.size === 0 || staleCount > limit) {
      console.error(
        `[sync] SKIPPING soft-delete: would delete ${staleCount} of ${activeCount} active ` +
          `(fetched=${liveIds.size}, limit=${limit}) — looks like a partial fetch, not real deletions.`
      );
    } else if (staleCount > 0) {
      const res = await prisma.opportunity.updateMany({
        where: { deletedAt: null, opportunityId: { notIn: [...liveIds] } },
        data: { deletedAt: new Date() },
      });
      softDeleted = res.count;
    }
  }

  return { count: records.length, watermark, failures, softDeleted };
}

// ---------------------------------------------------------------------------
// Note / task streams: link back to the opportunity and update its clocks.
// `field` is the clock column ("Note" | "Task"); we set lastNoteAt/lastTaskAt
// for display (any source) and advance lastMeaningfulUpdateAt only for MANUAL.
// ---------------------------------------------------------------------------
async function syncLinkedObjects(object, { sinceISO, kind }) {
  const records = await listRecordsSince(object, { sinceISO, depth: 1 });
  const targetsKey = object === "notes" ? "noteTargets" : "taskTargets";

  // Aggregate per opportunity so each deal is written once.
  const perOpp = new Map(); // oppId -> { lastAt, text, meaningfulAt, by }
  let watermark = null;

  for (const rec of records) {
    watermark = maxDate(watermark, rec.updatedAt);
    const at = toDate(rec.updatedAt);
    const manual = isManual(rec);
    const text = object === "notes" ? noteText(rec) : null;

    for (const t of rec[targetsKey] ?? []) {
      const oppId = t.targetOpportunityId;
      if (!oppId) continue;
      const cur = perOpp.get(oppId) ?? { lastAt: null, text: null, textAt: null, meaningfulAt: null, by: null };
      // display clock: newest linked record wins (any source)
      if (!cur.lastAt || (at && at > cur.lastAt)) {
        cur.lastAt = at;
      }
      // note text: keep the newest note that actually HAS text, so a newer
      // empty-body note never blanks an older real note.
      if (text && (!cur.textAt || (at && at > cur.textAt))) {
        cur.text = text;
        cur.textAt = at;
      }
      // meaningful clock: newest MANUAL record
      if (manual && (!cur.meaningfulAt || (at && at > cur.meaningfulAt))) {
        cur.meaningfulAt = at;
        cur.by = rec.updatedBy?.name ?? null;
      }
      perOpp.set(oppId, cur);
    }
  }

  // Bulk-load the target opportunities in one query.
  const existingById = new Map();
  if (perOpp.size) {
    const rows = await prisma.opportunity.findMany({
      where: { opportunityId: { in: [...perOpp.keys()] } },
      select: { opportunityId: true, lastMeaningfulUpdateAt: true, lastNoteAt: true, lastTaskAt: true },
    });
    for (const row of rows) existingById.set(row.opportunityId, row);
  }

  let failures = 0;
  for (const [oppId, agg] of perOpp) {
    const existing = existingById.get(oppId);
    // Skip if the opportunity isn't mirrored yet; the nightly full sync will
    // create it, after which its notes/tasks re-link within the overlap window.
    if (!existing) continue;

    try {
      const data = {};
      if (object === "notes") {
        data.lastNoteAt = maxDate(existing.lastNoteAt, agg.lastAt);
        if (agg.text && (!existing.lastNoteAt || (agg.textAt && agg.textAt >= toDate(existing.lastNoteAt)))) {
          data.lastNoteText = agg.text;
        }
      } else {
        data.lastTaskAt = maxDate(existing.lastTaskAt, agg.lastAt);
      }

      if (agg.meaningfulAt) {
        const advanced = !existing.lastMeaningfulUpdateAt || agg.meaningfulAt > toDate(existing.lastMeaningfulUpdateAt);
        data.lastMeaningfulUpdateAt = maxDate(existing.lastMeaningfulUpdateAt, agg.meaningfulAt);
        if (advanced) {
          data.lastMeaningfulUpdateKind = kind;
          data.lastMeaningfulUpdateBy = agg.by;
        }
      }

      if (Object.keys(data).length) {
        await prisma.opportunity.update({ where: { opportunityId: oppId }, data });
      }
    } catch (err) {
      failures++;
      console.error(`[sync] ${object} apply for opp ${oppId} failed: ${err.message}`);
    }
  }

  return { count: records.length, watermark, failures };
}

function sinceFor(checkpoint, full) {
  if (full || !checkpoint?.lastUpdatedAt) return null;
  return new Date(toDate(checkpoint.lastUpdatedAt).getTime() - OVERLAP_MS).toISOString();
}

// Cross-process/instance mutex, stored as a row in sync_checkpoints. A plain
// conditional UPDATE (row-locked by Postgres) is safe over the pgBouncer pooler,
// unlike session-scoped pg advisory locks. Guards against two runs overlapping
// (e.g. a slow full reconcile still going when the next delta fires, or a manual
// run racing cron) even across multiple app instances. TTL reclaims a stale lock
// left by a crashed run.
const SYNC_LOCK_KEY = "__sync_lock__";
const LOCK_TTL_MS = 20 * 60 * 1000;

async function acquireSyncLock() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LOCK_TTL_MS);
  const res = await prisma.syncCheckpoint.updateMany({
    where: {
      object: SYNC_LOCK_KEY,
      OR: [{ lastRunStatus: "idle" }, { lastRunStatus: null }, { lastRunAt: { lt: staleBefore } }],
    },
    data: { lastRunAt: now, lastRunStatus: "locked" },
  });
  if (res.count === 1) return true;
  // First run ever: create the lock row already held.
  try {
    await prisma.syncCheckpoint.create({ data: { object: SYNC_LOCK_KEY, lastRunAt: now, lastRunStatus: "locked" } });
    return true;
  } catch {
    return false; // row exists and is actively held by another run
  }
}

async function releaseSyncLock() {
  await prisma.syncCheckpoint.updateMany({ where: { object: SYNC_LOCK_KEY }, data: { lastRunStatus: "idle" } });
}

/**
 * Run one sync cycle.
 * @param {object} [opts]
 * @param {boolean} [opts.full] - ignore watermarks, fetch everything, reconcile deletes
 * @returns {Promise<object>} per-stream summary
 */
export async function runSync({ full = false } = {}) {
  const startedAt = Date.now();
  if (!(await acquireSyncLock())) {
    console.warn("[sync] another run holds the lock — skipping this cycle");
    return { skipped: true, reason: "locked" };
  }

  try {
  const memberMaps = await loadMemberMaps();
  const summary = { full, streams: {} };

  // Opportunities first so notes/tasks can link to freshly-created rows.
  const opCk = await getCheckpoint("opportunities");
  try {
    const r = await syncOpportunities({ sinceISO: sinceFor(opCk, full), memberMaps, full });
    await saveCheckpoint("opportunities", { watermark: r.watermark, status: "ok" });
    summary.streams.opportunities = r;
  } catch (err) {
    await saveCheckpoint("opportunities", { status: "error", error: err.message });
    summary.streams.opportunities = { error: err.message };
    console.error("[sync] opportunities stream failed:", err.message);
  }

  for (const object of ["notes", "tasks"]) {
    const ck = await getCheckpoint(object);
    try {
      const r = await syncLinkedObjects(object, {
        sinceISO: sinceFor(ck, full),
        kind: object === "notes" ? "note" : "task",
      });
      await saveCheckpoint(object, { watermark: r.watermark, status: "ok" });
      summary.streams[object] = r;
    } catch (err) {
      await saveCheckpoint(object, { status: "error", error: err.message });
      summary.streams[object] = { error: err.message };
      console.error(`[sync] ${object} stream failed:`, err.message);
    }
  }

  summary.durationMs = Date.now() - startedAt;
  console.log(`[sync] done full=${full} ${JSON.stringify(summary.streams)} in ${summary.durationMs}ms`);
  return summary;
  } finally {
    await releaseSyncLock();
  }
}
