import prisma from "../lib/prisma.js";
import { sendMail } from "./email.service.js";
import { IST, COLORS, escapeHtml, shortDate } from "../lib/sla.js";

// ---------------------------------------------------------------------------
// Mail 4 — deal closure checklist (trigger-based).
// Fires when a site visit is marked SUCCESS. Sends the owner a checklist with
// countdown timers driven off the site-visit-success time.
//
// PENDING TWENTY FIELDS (scaffold assumptions, TODO to create + map in sync):
//   - site visit outcome: data.siteVisitOutcome === "SUCCESS" | "FAILURE"
//   - (optional) client feedback logged-at: to start the 24h internal timer.
// Until the outcome field exists, scanClosureTriggers() returns [].
//
// Dedup of "already sent" is TODO — intended: an Opportunity.closureSentAt
// column (additive migration) set after a successful send. For now the trigger
// is idempotent only within a process run.
// ---------------------------------------------------------------------------

const HOURS = 3600000;
const DAYS = 86400000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function sendWithRetry(args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sendMail(args);
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

export function isSiteVisitSuccess(opp) {
  const data = opp.data || {};
  const outcome = data.siteVisitOutcome || data.site_visit_outcome || data.visitOutcome;
  return opp.stage === "SITE_VISIT" && String(outcome).toUpperCase() === "SUCCESS";
}

// The checklist + its deadline timers, relative to when the visit succeeded.
function checklistItems(successAt) {
  const base = successAt ? new Date(successAt) : new Date();
  return [
    { label: "Fill in shortlisted site details (warehouse ID)", due: null },
    { label: "Log client feedback: target rate, duration, enhancements", due: null },
    { label: "Internal negotiation (WOG ↔ Owner)", due: new Date(base.getTime() + 24 * HOURS), note: "24h from client feedback" },
    { label: "Client ↔ Owner negotiation meeting", due: new Date(base.getTime() + 3 * DAYS), note: "3 days from site-visit success" },
    { label: "Move deal to Agreement Work stage", due: new Date(base.getTime() + 5 * DAYS), note: "5 days from site-visit success" },
  ];
}

/** Build the closure-checklist HTML for one opportunity. Pure. */
export function buildClosureChecklist(opp, now = new Date()) {
  const successAt = opp.stageEnteredAt; // approx: when the deal entered SITE_VISIT
  const items = checklistItems(successAt);
  const rows = items
    .map((it) => {
      const overdue = it.due && it.due.getTime() < now.getTime();
      const dueLabel = it.due
        ? `<span style="color:${overdue ? COLORS.RED.text : "#111827"}; font-weight:600;">${overdue ? "overdue · " : "due "}${escapeHtml(shortDate(it.due))}</span>`
        : `<span style="color:#9ca3af;">—</span>`;
      return `<tr>
        <td style="padding:10px 12px; font-size:13px; color:#111827; border-bottom:1px solid #f3f4f6;">☐ ${escapeHtml(it.label)}${it.note ? `<div style="color:#9ca3af; font-size:11px;">${escapeHtml(it.note)}</div>` : ""}</td>
        <td style="padding:10px 12px; font-size:12px; text-align:right; border-bottom:1px solid #f3f4f6; white-space:nowrap;">${dueLabel}</td>
      </tr>`;
    })
    .join("");

  const inner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:10px;">
    <tr><td style="padding:24px 32px 8px; border-bottom:1px solid #f3f4f6;">
      <div style="font-size:12px; color:${COLORS.GREEN.text}; font-weight:700; text-transform:uppercase; letter-spacing:.04em;">✓ Site visit successful</div>
      <h1 style="margin:6px 0 2px; font-size:19px; font-weight:700; color:#111827;">Closure checklist — ${escapeHtml(opp.companyName || "Deal")}</h1>
      <p style="margin:0; font-size:13px; color:#6b7280;">${escapeHtml(opp.city || "")} · #${escapeHtml(opp.opportunityId.slice(0, 8))} · visit ${escapeHtml(shortDate(successAt))}</p>
    </td></tr>
    <tr><td style="padding:12px 32px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee; border-radius:8px; overflow:hidden;">${rows}</table>
      <p style="margin:14px 0 0; font-size:11px; color:#9ca3af;">Complete these to keep the deal on track to Agreement Work within 5 days. Automated from Wareongo CRM.</p>
    </td></tr>
  </table>`;

  return `<!doctype html><html><body style="margin:0; padding:24px; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#111827;">${inner}</body></html>`;
}

/** Send the checklist for a single opportunity to its owner(s). */
export async function sendClosureChecklistFor(opportunityId, { dryRunEmail } = {}) {
  const opp = await prisma.opportunity.findUnique({ where: { opportunityId } });
  if (!opp) {
    const err = new Error("opportunity not found in mirror");
    err.status = 404;
    throw err;
  }
  const html = buildClosureChecklist(opp);
  const to = dryRunEmail || opp.assigneeEmail;
  if (!to) return { sent: false, reason: "no recipient" };

  await sendWithRetry({
    to,
    subject: `Site visit success — closure checklist for ${opp.companyName || "deal"}`,
    html,
    text: `Site visit marked successful for ${opp.companyName}. Complete the closure checklist; move to Agreement Work within 5 days.`,
  });

  // Stamp so the trigger scan never sends this deal's checklist twice. Skipped
  // on dry runs (no real recipient) so previews don't suppress the real send.
  if (!dryRunEmail) {
    await prisma.opportunity.update({
      where: { opportunityId },
      data: { closureSentAt: new Date() },
    });
  }
  return { sent: true, to };
}

/**
 * Find deals whose site visit is marked SUCCESS and whose checklist has not
 * already been sent (closureSentAt is null).
 */
export async function scanClosureTriggers() {
  const opps = await prisma.opportunity.findMany({
    where: { deletedAt: null, stage: "SITE_VISIT", closureSentAt: null },
    select: { opportunityId: true, stage: true, data: true },
  });
  return opps.filter(isSiteVisitSuccess).map((o) => o.opportunityId);
}
