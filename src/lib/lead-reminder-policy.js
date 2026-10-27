import { createHash } from "node:crypto";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IST_OFFSET = 5.5 * HOUR;
export const INTAKE_STAGES = ["NEW_LEAD", "RFQ_RECEIVED"];
// Fixed rollout floor: 27 October 2026, 00:00 IST. Never recompute this on restart.
export const REMINDER_ROLLOUT_START = "2026-10-27T00:00:00+05:30";

function ids(value = "") {
  if (!value.trim()) return [];
  const parts = value.split(",").map(s => s.trim());
  if (parts.some(s => !/^[1-9]\d*$/.test(s) || !Number.isSafeInteger(Number(s)))) {
    throw new Error("INVALID_REMINDER_EMPLOYEE_IDS");
  }
  return [...new Set(parts.map(Number))];
}

export function reminderConfig(env = process.env, { forPreview = false } = {}) {
  if (!["true", "false", undefined, ""].includes(env.CRM_LEAD_REMINDERS_ENABLED)) {
    throw new Error("INVALID_REMINDER_ENABLED");
  }
  const enabled = env.CRM_LEAD_REMINDERS_ENABLED === "true";
  const betaIds = ids(env.CRM_REMINDER_BETA_EMPLOYEE_IDS);
  const escalationIds = ids(env.CRM_REMINDER_ESCALATION_EMPLOYEE_IDS);
  const escalationExemptIds = ids(env.CRM_REMINDER_ESCALATION_EXEMPT_EMPLOYEE_IDS);
  const cutoff = env.CRM_REMINDER_NEW_LEADS_FROM;
  if (!enabled && !forPreview) return { enabled, betaIds, escalationIds, escalationExemptIds, cutoff: cutoff || null };
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(cutoff || "") ||
      !Number.isFinite(Date.parse(cutoff))) throw new Error("INVALID_REMINDER_CUTOFF");
  if (Date.parse(cutoff) < Date.parse(REMINDER_ROLLOUT_START)) throw new Error("REMINDER_CUTOFF_BEFORE_ROLLOUT");
  if (!betaIds.length) throw new Error("EMPTY_REMINDER_BETA_LIST");
  if (!escalationIds.length) throw new Error("EMPTY_REMINDER_ESCALATION_LIST");
  const api = new URL(env.RAMESH_API_URL || "");
  if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash ||
      api.pathname !== "/") throw new Error("INVALID_RAMESH_API_URL");
  if (!forPreview && !env.RAMESH_AUTOMATION_API_KEY) throw new Error("MISSING_RAMESH_AUTOMATION_API_KEY");
  const crm = new URL(env.TWENTY_CRM_BASE_URL || "");
  if (!["http:", "https:"].includes(crm.protocol) || crm.username || crm.password) {
    throw new Error("INVALID_CRM_URL");
  }
  let aliases = {};
  try { aliases = JSON.parse(env.CRM_REMINDER_ASSIGNEE_MAP || "{}"); }
  catch { throw new Error("INVALID_REMINDER_ASSIGNEE_MAP"); }
  if (!aliases || Array.isArray(aliases) || typeof aliases !== "object" ||
      Object.entries(aliases).some(([key, id]) => !/^[A-Z][A-Z0-9_ ]*$/.test(key) ||
        !Number.isSafeInteger(id) || id <= 0)) throw new Error("INVALID_REMINDER_ASSIGNEE_MAP");
  return { enabled, betaIds, escalationIds, cutoff: new Date(cutoff).toISOString(),
    aliases, escalationExemptIds, apiUrl: api.origin, apiKey: env.RAMESH_AUTOMATION_API_KEY, crmUrl: crm.origin };
}

// PRD working clock: every day, 08:00–20:00 IST. No invented holiday calendar.
export function workingDeadline(start, hours) {
  let at = new Date(start).getTime() + IST_OFFSET;
  if (!Number.isFinite(at) || hours < 0) throw new Error("INVALID_REMINDER_TIME");
  let remaining = hours * HOUR;
  while (true) {
    const day = Math.floor(at / DAY) * DAY;
    at = Math.max(at, day + 8 * HOUR);
    if (at >= day + 20 * HOUR) { at = day + DAY + 8 * HOUR; continue; }
    const available = day + 20 * HOUR - at;
    if (remaining < available) return new Date(at + remaining - IST_OFFSET).toISOString();
    remaining -= available;
    at = day + DAY + 8 * HOUR;
  }
}

export function isWorkingTime(now) {
  const hour = ((new Date(now).getTime() + IST_OFFSET) % DAY + DAY) % DAY / HOUR;
  return hour >= 8 && hour < 20;
}

export function occurrenceId(...parts) {
  const h = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-8" + h.slice(13, 16) +
    "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
}

export function assigneeKeys(record) {
  if (record.assignedTo == null) return [];
  if (!Array.isArray(record.assignedTo) || record.assignedTo.some(x => typeof x !== "string" || !x.trim())) {
    throw new Error("INVALID_CRM_ASSIGNEES");
  }
  return [...new Set(record.assignedTo.map(x => x.trim().toUpperCase()))].sort();
}

export function rosterResolver(rows, config) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const unique = (field, value) => {
    const found = rows.filter(row => field(row) === value);
    return found.length === 1 ? found[0] : null;
  };
  return {
    byId,
    assignee(key) {
      if (Object.hasOwn(config.aliases || {}, key)) return byId.get(config.aliases[key]) || null;
      return unique(row => row.name?.trim().split(/\s+/)[0].toUpperCase(), key);
    },
    owner(record) {
      return record.ownerId ? unique(row => row.twenty_user_id, record.ownerId) : null;
    },
    canNotify(row, escalation = false) {
      return !!row?.is_active && (escalation ? config.escalationIds : config.betaIds).includes(row.id) &&
        typeof row.phone_number === "string" && /^\+[1-9]\d{7,14}$/.test(row.phone_number);
    },
  };
}

export function isNewLead(record, config) {
  const created = Date.parse(record.createdAt);
  return Number.isFinite(created) && created >= Date.parse(config.cutoff);
}

export function contactCompleted(record, assignment, observedAt) {
  const at = Date.parse(record.lastContacted);
  // An explicit contact timestamp is completion evidence, never updatedAt/note activity.
  if (!Number.isFinite(at) || at > +new Date(observedAt) ||
      at === Date.parse(assignment.contactBaseline)) return false;
  if (at >= Date.parse(assignment.assignedAt)) return true;
  // Twenty can expose date-only contact fields. A newly observed change to today's
  // contact date counts; a pre-assignment value or backdated correction does not.
  const assignedDay = Math.floor((Date.parse(assignment.assignedAt) + IST_OFFSET) / DAY);
  const contactDay = Math.floor((at + IST_OFFSET) / DAY);
  return /^\d{4}-\d{2}-\d{2}$/.test(record.lastContacted) &&
    record.lastContacted !== assignment.contactBaseline && contactDay >= assignedDay;
}

// State is independent of the email briefing's owner/creator fallback.
// Assignment times are observation times; generic Twenty updatedAt is never an assignment clock.
export function reconcileLead(previous, record, roster, config, observedAt) {
  const state = structuredClone(previous || { version: 1, generation: 0, assignments: [], unassigned: null });
  state.observedAt = observedAt;
  const keys = assigneeKeys(record);
  const applicable = !record.deletedAt && INTAKE_STAGES.includes(record.stage);
  for (const a of state.assignments) {
    if (!a.removedAt && !keys.includes(a.key)) a.removedAt = observedAt;
    if (!a.finished && !applicable) a.finished = { reason: "stage_exit", at: observedAt };
    if (!a.finished && contactCompleted(record, a, observedAt)) a.finished = { reason: "contact_recorded", at: observedAt };
  }
  for (const key of keys) {
    const member = roster.assignee(key);
    let a = state.assignments.find(a => a.key === key && !a.removedAt);
    // A changed identity binding is a routing issue, not a new assignment/reset.
    if (!a) {
      state.generation++;
      a = { id: occurrenceId(record.id, "assignment", state.generation), key,
        employeeId: member?.id || null, assignedAt: observedAt, timeSource: "observed",
        contactBaseline: record.lastContacted || null,
        admitted: applicable && !!member && config.betaIds.includes(member.id),
        removedAt: null, finished: applicable ? null : { reason: "stage_exit", at: observedAt } };
      state.assignments.push(a);
    }
  }
  const owner = roster.owner(record);
  if (keys.length || !applicable) state.unassigned = null;
  else if (!state.unassigned || state.unassigned.ownerId !== (record.ownerId || null)) {
    state.generation++;
    state.unassigned = { id: occurrenceId(record.id, "unassigned", state.generation),
      ownerId: record.ownerId || null, employeeId: owner?.id || null,
      admitted: !!owner && config.betaIds.includes(owner.id), openedAt: observedAt };
  }
  return state;
}

export function dueNotifications(state, record, roster, config, now) {
  if (!isNewLead(record, config) || record.deletedAt || !INTAKE_STAGES.includes(record.stage) ||
      !isWorkingTime(now)) return [];
  const keys = assigneeKeys(record);
  if (!keys.length) {
    const u = state.unassigned;
    const owner = roster.owner(record);
    return u?.admitted && u.employeeId === owner?.id && roster.canNotify(owner)
      ? [{ id: occurrenceId(u.id, "owner", owner.id), step: "owner", recipient: owner, assignments: [] }]
      : [];
  }
  const pending = state.assignments.filter(a => a.admitted && !a.removedAt && !a.finished &&
    keys.includes(a.key) && !contactCompleted(record, a, now) &&
    roster.assignee(a.key)?.id === a.employeeId &&
    roster.byId.get(a.employeeId)?.is_active && config.betaIds.includes(a.employeeId));
  const due = [];
  const overdue = [];
  for (const a of pending) {
    const step = [8, 4, 2, 0].find(h => Date.parse(workingDeadline(a.assignedAt, h)) <= +new Date(now));
    if (step == null) continue;
    if (step === 8) {
      if (!(config.escalationExemptIds || []).includes(a.employeeId)) overdue.push(a);
      continue;
    }
    if (roster.canNotify(roster.byId.get(a.employeeId))) {
      due.push({ id: occurrenceId(a.id, step, a.employeeId), step: String(step),
        recipient: roster.byId.get(a.employeeId), assignments: [a] });
    }
  }
  // One stable escalation per assignment episode and recipient. Removing a
  // co-assignee must not create a new escalation for someone already reported.
  const responsible = new Set(keys.map(k => roster.assignee(k)?.id).filter(Boolean));
  const owner = roster.owner(record);
  if (owner) responsible.add(owner.id);
  if (overdue.length) {
    for (const id of config.escalationIds) {
      const recipient = roster.byId.get(id);
      if (responsible.has(id) || !roster.canNotify(recipient, true)) continue;
      for (const a of overdue) {
        due.push({ id: occurrenceId(a.id, "escalation", id),
          step: "8", recipient, assignments: [a] });
      }
    }
  }
  return due;
}
