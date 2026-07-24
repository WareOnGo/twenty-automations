import prisma from "../lib/prisma.js";
import { sendMail } from "./email.service.js";
import { getSalesRecipients, getAdminRecipients } from "../lib/recipients.js";
import {
  IST,
  ACTIVE_STAGES,
  CARD_STAGES,
  SLA_RULES,
  COLORS,
  escapeHtml,
  daysSince,
  slaColorFor,
  slaDeadline,
  isIstDayOffset,
  shortDate,
} from "../lib/sla.js";

// ---------------------------------------------------------------------------
// Mail 2 — admin morning briefing (8:00 AM IST, to admins).
// Part 1: team CRM-adoption hygiene (per-person % of deals updated yesterday).
// Part 2: key escalations (RED SLA breaches + deals flagged for admin).
//
// NOTE: the "Flag for Admin" Twenty field does not exist yet — collectFlagged()
// reads a best-effort field and returns [] until it is added. See TODO below.
// HTML is functional/draft; final styling to follow the approved Mail-1 design.
// ---------------------------------------------------------------------------

const ESCALATION_CAP = 40;

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

// Fetch all active, non-deleted deals once.
async function fetchActiveDeals() {
  return prisma.opportunity.findMany({
    where: { deletedAt: null, stage: { in: ACTIVE_STAGES } },
    select: {
      opportunityId: true,
      stage: true,
      city: true,
      companyName: true,
      assigneeEmail: true,
      priority: true,
      stageEnteredAt: true,
      lastContacted: true,
      lastMeaningfulUpdateAt: true,
      data: true,
    },
  });
}

// Part 1 — per-person adoption. A deal counts toward every assignee email on it.
function computeHygiene(deals, roster, now) {
  const byEmail = new Map(); // email -> { total, updated }
  for (const { email } of roster) byEmail.set(email, { total: 0, updated: 0 });

  for (const d of deals) {
    const emails = (d.assigneeEmail || "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const wasUpdated = isIstDayOffset(d.lastMeaningfulUpdateAt, 1, now);
    for (const e of emails) {
      if (!byEmail.has(e)) byEmail.set(e, { total: 0, updated: 0 });
      const rec = byEmail.get(e);
      rec.total++;
      if (wasUpdated) rec.updated++;
    }
  }

  const nameByEmail = new Map(roster.map((r) => [r.email, r.name]));
  const rows = [...byEmail.entries()]
    .filter(([, v]) => v.total > 0)
    .map(([email, v]) => {
      const pct = Math.round((v.updated / v.total) * 100);
      const color = pct <= 50 ? "RED" : pct < 80 ? "YELLOW" : "GREEN";
      return { email, name: nameByEmail.get(email) || email.split("@")[0], ...v, pct, color };
    })
    .sort((a, b) => a.pct - b.pct); // worst first

  const totalActive = deals.length;
  const updatedYesterday = deals.filter((d) => isIstDayOffset(d.lastMeaningfulUpdateAt, 1, now)).length;
  return { rows, totalActive, updatedYesterday };
}

// Part 2a — RED SLA breaches across the whole team (card stages only).
function collectBreaches(deals, now) {
  const breaches = [];
  for (const d of deals) {
    if (!CARD_STAGES.includes(d.stage)) continue;
    if (slaColorFor(d.stage, d.stageEnteredAt, now) !== "RED") continue;
    breaches.push({ ...d, _overdue: daysSince(d.stageEnteredAt, now) ?? 0 });
  }
  return breaches.sort((a, b) => b._overdue - a._overdue);
}

// Part 2b — deals manually flagged for admin.
// TODO: add a "Flag for Admin" boolean custom field in Twenty; sync mirrors it
// into `data`. Until then this reads a best-effort key and returns [].
function collectFlagged(deals) {
  return deals.filter((d) => {
    const data = d.data || {};
    return data.flagForAdmin === true || data.flagAdmin === true || data.flag_for_admin === true;
  });
}

function hygieneRowHtml(r) {
  const color = COLORS[r.color];
  const tint = r.color === "GREEN" ? "#fff" : color.bg;
  const badge = r.color === "GREEN" ? "✓" : "⚠";
  return `<tr style="background:${tint};">
    <td style="padding:8px 12px; font-size:13px; color:#111827; border-bottom:1px solid #f3f4f6;">${escapeHtml(r.name)}</td>
    <td style="padding:8px 12px; font-size:13px; color:#374151; border-bottom:1px solid #f3f4f6;">${r.updated} of ${r.total}</td>
    <td style="padding:8px 12px; font-size:13px; font-weight:700; color:${color.text}; border-bottom:1px solid #f3f4f6;">${r.pct}% ${badge}</td>
  </tr>`;
}

function breachRowHtml(d, now) {
  const rule = SLA_RULES[d.stage];
  return `<tr>
    <td style="padding:8px 12px; font-size:12px; color:#111827; border-bottom:1px solid #f3f4f6;">${escapeHtml(d.companyName || "—")}<div style="color:#9ca3af;">${escapeHtml(d.city || "")} · #${escapeHtml(d.opportunityId.slice(0, 8))}</div></td>
    <td style="padding:8px 12px; font-size:12px; color:#374151; border-bottom:1px solid #f3f4f6;">${escapeHtml(rule?.label || d.stage)}</td>
    <td style="padding:8px 12px; font-size:12px; color:${COLORS.RED.text}; font-weight:700; border-bottom:1px solid #f3f4f6;">${escapeHtml(slaDeadline(d.stage, d.stageEnteredAt, now))}</td>
    <td style="padding:8px 12px; font-size:12px; color:#6b7280; border-bottom:1px solid #f3f4f6;">${escapeHtml((d.assigneeEmail || "").split(",")[0])}</td>
  </tr>`;
}

/** Build the admin briefing HTML. Pure given computed inputs. */
export function buildAdminBriefing({ hygiene, breaches, flagged, now = new Date() }) {
  const dateLabel = now.toLocaleDateString("en-IN", { timeZone: IST, weekday: "long", day: "2-digit", month: "long" });
  const overallPct = hygiene.totalActive
    ? Math.round((hygiene.updatedYesterday / hygiene.totalActive) * 100)
    : 0;
  const shownBreaches = breaches.slice(0, ESCALATION_CAP);
  const moreBreaches = breaches.length - shownBreaches.length;

  const inner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:760px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:10px;">
    <tr><td style="padding:24px 32px 8px; border-bottom:1px solid #f3f4f6;">
      <div style="font-size:12px; color:#6b7280; text-transform:uppercase; letter-spacing:.04em;">Admin briefing · ${escapeHtml(dateLabel)}</div>
      <h1 style="margin:6px 0 2px; font-size:20px; font-weight:700; color:#111827;">Team CRM hygiene &amp; escalations</h1>
      <p style="margin:0; font-size:13px; color:#6b7280;">Yesterday: <strong>${hygiene.updatedYesterday} of ${hygiene.totalActive}</strong> active deals updated (${overallPct}%).</p>
    </td></tr>

    <tr><td style="padding:20px 32px 4px; font-size:15px; font-weight:700; color:#111827;">1 · Adoption by person</td></tr>
    <tr><td style="padding:6px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee; border-radius:8px; overflow:hidden;">
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Team member</th>
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Updated yesterday</th>
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Compliance</th>
        </tr>
        ${hygiene.rows.map(hygieneRowHtml).join("")}
      </table>
      <div style="font-size:11px; color:#9ca3af; padding-top:6px;">Amber &lt; 80% · Red ≤ 50% of that person's active deals updated yesterday.</div>
    </td></tr>

    <tr><td style="padding:20px 32px 4px; font-size:15px; font-weight:700; color:#111827;">2 · Escalations
      <span style="color:${COLORS.RED.chip};"> · ${breaches.length} SLA breaches</span>${flagged.length ? ` · <span style="color:#7c3aed;">${flagged.length} flagged</span>` : ""}</td></tr>
    <tr><td style="padding:6px 32px 8px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee; border-radius:8px; overflow:hidden;">
        <tr style="background:#f9fafb;">
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Deal</th>
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Stage</th>
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">SLA</th>
          <th style="padding:8px 12px; text-align:left; font-size:11px; color:#6b7280;">Owner</th>
        </tr>
        ${shownBreaches.map((d) => breachRowHtml(d, now)).join("")}
      </table>
      ${moreBreaches > 0 ? `<div style="font-size:12px; color:#6b7280; padding:6px 0;">+ ${moreBreaches} more breached deals</div>` : ""}
      ${flagged.length === 0 ? `<div style="font-size:11px; color:#9ca3af; padding-top:6px;">No deals flagged for admin. (Flag-for-Admin field pending in Twenty.)</div>` : ""}
    </td></tr>

    <tr><td style="padding:16px 32px 26px; border-top:1px solid #f3f4f6; font-size:11px; color:#9ca3af;">Automated admin briefing from Wareongo CRM.</td></tr>
  </table>`;

  return `<!doctype html><html><body style="margin:0; padding:24px; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#111827;">${inner}</body></html>`;
}

/**
 * Orchestrator: compute + build + send to admins. pg_cron 8:00 IST.
 * @param {object} [opts]
 * @param {string}  [opts.dryRunEmail] - redirect all mail to one box
 * @param {boolean} [opts.buildOnly] - return { html, ...stats } without sending
 */
export async function sendAdminBriefing({ dryRunEmail, buildOnly = false } = {}) {
  const now = new Date();
  const [deals, roster, admins] = await Promise.all([
    fetchActiveDeals(),
    getSalesRecipients(),
    getAdminRecipients(),
  ]);

  const hygiene = computeHygiene(deals, roster, now);
  const breaches = collectBreaches(deals, now);
  const flagged = collectFlagged(deals);
  const html = buildAdminBriefing({ hygiene, breaches, flagged, now });

  if (buildOnly) {
    return { html, recipients: 0, breaches: breaches.length, flagged: flagged.length, ...hygiene };
  }

  const to = dryRunEmail ? [dryRunEmail] : admins.map((a) => a.email);
  const subject = `Admin briefing — ${breaches.length} SLA breaches, ${hygiene.updatedYesterday}/${hygiene.totalActive} updated`;
  try {
    await sendWithRetry({ to: to.join(","), subject, html, text: `${breaches.length} SLA breaches. ${hygiene.updatedYesterday}/${hygiene.totalActive} deals updated yesterday.` });
  } catch (err) {
    console.error("[admin-briefing] send failed:", err.message);
    throw err;
  }

  console.log(`[admin-briefing] sent to=${to.length} breaches=${breaches.length} flagged=${flagged.length}`);
  return { recipients: to.length, breaches: breaches.length, flagged: flagged.length, ...hygiene };
}
