// ---------------------------------------------------------------------------
// Single source of truth for CRM SLA rules, stage config, colours, and the
// shared formatting helpers used by every automated mail (morning briefing,
// admin briefing, closure checklist). Keep SLA logic here ONLY — grading and
// compliance correctness depend on there being one definition.
// ---------------------------------------------------------------------------

export const IST = "Asia/Kolkata";

// Time-in-stage SLA thresholds (days). days <= greenMax => GREEN,
// days <= yellowMax => YELLOW, else RED (breach).
export const SLA_RULES = {
  NEW_LEAD: { greenMax: 1, yellowMax: 2, label: "New Leads" },
  RFQ_RECEIVED: { greenMax: 1, yellowMax: 2, label: "RFQ Received" },
  PROPOSAL_SHARED: { greenMax: 3, yellowMax: 5, label: "Proposal Shared" },
  FOLLOW_UP: { greenMax: 3, yellowMax: 5, label: "Follow-ups" },
  SITE_VISIT: { greenMax: 1, yellowMax: 3, label: "Site Visit" },
};

// Stages rendered as SLA-coloured cards (in order).
export const CARD_STAGES = ["NEW_LEAD", "RFQ_RECEIVED", "PROPOSAL_SHARED", "FOLLOW_UP", "SITE_VISIT"];
// Later stages: no SLA timer in v1 — shown as a plain table.
export const TABLE_STAGES = [
  ["NEGOTIATION", "Negotiation"],
  ["AGREEMENT_WORK", "Agreement Work"],
  ["MONEY_COLLECTION", "Money Collection"],
];
// Dropped / terminal stages excluded from active tracking + briefings.
export const EXCLUDED_STAGES = ["RFQ_NOT_RELEVANT", "DEAL_LOST", "DEAL_CLOSED"];

// A deal is "active" (tracked for compliance) if it is in one of these.
export const ACTIVE_STAGES = [...CARD_STAGES, ...TABLE_STAGES.map((t) => t[0])];

export const COLORS = {
  RED: { bar: "#dc2626", bg: "#fef2f2", chip: "#dc2626", text: "#991b1b" },
  YELLOW: { bar: "#d97706", bg: "#fffbeb", chip: "#d97706", text: "#92400e" },
  GREEN: { bar: "#16a34a", bg: "#f0fdf4", chip: "#16a34a", text: "#166534" },
};
export const SEVERITY = { RED: 0, YELLOW: 1, GREEN: 2 };

// ---- helpers --------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function daysSince(value, now = new Date()) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

// IST calendar day string (YYYY-MM-DD) for a given instant.
export function istDay(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: IST }); // en-CA => YYYY-MM-DD
}

// True if `value` falls on the IST calendar day that is `offsetDays` from now
// (0 = today, 1 = yesterday).
export function isIstDayOffset(value, offsetDays, now = new Date()) {
  if (!value) return false;
  const target = istDay(new Date(now.getTime() - offsetDays * 86400000));
  return istDay(value) === target;
}

export function slaColorFor(stage, stageEnteredAt, now = new Date()) {
  const rule = SLA_RULES[stage];
  if (!rule) return null; // no SLA (later stages)
  const days = daysSince(stageEnteredAt, now);
  if (days == null) return "GREEN";
  if (days <= rule.greenMax) return "GREEN";
  if (days <= rule.yellowMax) return "YELLOW";
  return "RED";
}

// Human label for the current stage's SLA deadline (turns RED at yellowMax).
export function slaDeadline(stage, stageEnteredAt, now = new Date()) {
  const rule = SLA_RULES[stage];
  if (!rule || !stageEnteredAt) return "—";
  const deadline = new Date(new Date(stageEnteredAt).getTime() + rule.yellowMax * 86400000);
  const overdue = daysSince(deadline, now);
  if (overdue != null && overdue > 0) return `breached ${overdue}d ago`;
  return `by ${deadline.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short" })}`;
}

export function formatINR(amount) {
  const micros = amount?.amountMicros;
  if (micros == null) return null;
  const rupees = Number(micros) / 1_000_000;
  if (!isFinite(rupees) || rupees <= 0) return null;
  if (rupees >= 1e7) return `₹${(rupees / 1e7).toFixed(2)} Cr`;
  if (rupees >= 1e5) return `₹${(rupees / 1e5).toFixed(1)} L`;
  return `₹${Math.round(rupees).toLocaleString("en-IN")}`;
}

export function formatSft(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (isFinite(n) && n > 0) return `${n.toLocaleString("en-IN")} sft`;
  return null;
}

// Mask a phone to +91-XXxxxxxxx, mirroring the wireframe (+91-8xxxxxxx).
export function maskPhone(pocPhone) {
  const num = pocPhone?.primaryPhoneNumber;
  const cc = pocPhone?.primaryPhoneCallingCode || "+91";
  if (!num) return null;
  const digits = String(num).replace(/\D/g, "");
  if (digits.length < 3) return null;
  return `${cc}-${digits.slice(0, 2)}${"x".repeat(Math.max(0, digits.length - 2))}`;
}

export function pocFullName(pocName) {
  if (!pocName) return null;
  const n = [pocName.firstName, pocName.lastName].filter(Boolean).join(" ").trim();
  return n || null;
}

export function priorityStars(priority) {
  const m = /RATING_(\d+)/.exec(priority || "");
  if (!m) return "";
  const n = Math.max(0, Math.min(5, Number(m[1]))); // clamp: guard against RATING_>5 / RangeError
  return "★".repeat(n) + "☆".repeat(5 - n);
}

export function shortDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { timeZone: IST, day: "2-digit", month: "short" });
}
