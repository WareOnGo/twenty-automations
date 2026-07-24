import prisma from "../lib/prisma.js";
import { sendMail } from "./email.service.js";
import { getSalesRecipients } from "../lib/recipients.js";
import {
  IST,
  SLA_RULES,
  CARD_STAGES,
  TABLE_STAGES,
  EXCLUDED_STAGES,
  COLORS,
  SEVERITY,
  escapeHtml,
  daysSince,
  slaColorFor,
  slaDeadline,
  formatINR,
  formatSft,
  maskPhone,
  pocFullName,
  priorityStars,
  shortDate,
  isIstDayOffset,
} from "../lib/sla.js";

// ---------------------------------------------------------------------------
// Mail 1 — personalised morning briefing (per sales person, 7:30 AM IST).
// Stages 1–5 render as SLA-coloured cards; Negotiation / Agreement / Money as
// a plain 3-column table. Builder is pure (given rows); sending is orchestrated
// by sendMorningBriefings().
// ---------------------------------------------------------------------------

const DASHBOARD_URL = "https://dashboard.wareongo.com";

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

function daysSinceContactLabel(opp, now) {
  const ref = opp.lastContacted || opp.lastMeaningfulUpdateAt;
  const d = daysSince(ref, now);
  if (d == null) return "never";
  if (d === 0) return "today";
  return `${d}d ago`;
}

// Deal name per wireframe: "Bangalore - 10,000 sft (Nelamangala, Grade B)"
function dealTitle(opp) {
  const data = opp.data || {};
  const sft = formatSft(data.requirementInSft);
  const head = sft ? `${escapeHtml(opp.city || "")} - ${escapeHtml(sft)}` : escapeHtml(opp.city || "");
  const paren = [];
  if (data.microMarket) paren.push(escapeHtml(data.microMarket));
  if (opp.grade) paren.push(`Grade ${escapeHtml(opp.grade)}`);
  const suffix = paren.length
    ? ` <span style="color:#6b7280;font-weight:400;">(${paren.join(", ")})</span>`
    : "";
  return (head || escapeHtml(opp.companyName) || "Deal") + suffix;
}

function dealCard(opp, now) {
  const data = opp.data || {};
  const color = COLORS[opp._sla] || COLORS.GREEN;
  const poc = pocFullName(data.pocName);
  const phone = maskPhone(data.pocPhoneNumber);
  const contact = [poc && escapeHtml(poc), phone && escapeHtml(phone)].filter(Boolean).join(" · ");
  const stars = priorityStars(opp.priority);
  const note = opp.lastNoteText ? escapeHtml(opp.lastNoteText.replace(/\s+/g, " ").slice(0, 180)) : null;
  const shortId = escapeHtml(opp.opportunityId.slice(0, 8));

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 10px; border-collapse:separate;">
    <tr>
      <td style="width:4px; background:${color.bar}; border-radius:6px 0 0 6px;"></td>
      <td style="background:${color.bg}; border:1px solid #eee; border-left:none; border-radius:0 6px 6px 0; padding:12px 14px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size:14px; font-weight:600; color:#111827;">${dealTitle(opp)}</td>
            <td align="right" style="white-space:nowrap; vertical-align:top;">
              <span style="display:inline-block; background:${color.chip}; color:#fff; font-size:11px; font-weight:700; padding:2px 8px; border-radius:10px;">${opp._sla}</span>
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:4px; font-size:13px; color:#374151;">
              <strong>${escapeHtml(opp.companyName || "—")}</strong>${contact ? ` &nbsp;·&nbsp; ${contact}` : ""}
              ${stars ? ` &nbsp; <span style="color:#f59e0b; font-size:12px;">${stars}</span>` : ""}
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:8px;">
              <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:12px;">
                <tr>
                  <td style="padding-right:18px; color:#6b7280;">SLA <span style="color:${color.text}; font-weight:600;">${escapeHtml(slaDeadline(opp.stage, opp.stageEnteredAt, now))}</span></td>
                  <td style="padding-right:18px; color:#6b7280;">Last contact <span style="color:#111827; font-weight:600;">${escapeHtml(daysSinceContactLabel(opp, now))}</span></td>
                  <td style="color:#6b7280;">Next <span style="color:#111827; font-weight:600;">${opp.nextFollowUp ? escapeHtml(shortDate(opp.nextFollowUp)) : "—"}</span></td>
                </tr>
              </table>
            </td>
          </tr>
          ${note ? `<tr><td colspan="2" style="padding-top:8px; font-size:12px; color:#4b5563; font-style:italic; border-top:1px dashed #e5e7eb;">“${note}${opp.lastNoteText.length > 180 ? "…" : ""}”</td></tr>` : ""}
          <tr><td colspan="2" style="padding-top:6px; font-size:11px; color:#9ca3af;">#${shortId}</td></tr>
        </table>
      </td>
    </tr>
  </table>`;
}

function cardSection(stageKey, deals, now, capPerStage) {
  if (!deals.length) return "";
  const rule = SLA_RULES[stageKey];
  const shown = capPerStage ? deals.slice(0, capPerStage) : deals;
  const more = deals.length - shown.length;
  const counts = { RED: 0, YELLOW: 0, GREEN: 0 };
  for (const d of deals) counts[d._sla]++;

  return `
  <tr><td style="padding:20px 32px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:15px; font-weight:700; color:#111827;">${escapeHtml(rule.label)}
        <span style="color:#9ca3af; font-weight:500;"> · ${deals.length}</span></td>
      <td align="right" style="font-size:11px; color:#6b7280;">
        <span style="color:${COLORS.RED.chip}; font-weight:700;">● ${counts.RED}</span> &nbsp;
        <span style="color:${COLORS.YELLOW.chip}; font-weight:700;">● ${counts.YELLOW}</span> &nbsp;
        <span style="color:${COLORS.GREEN.chip}; font-weight:700;">● ${counts.GREEN}</span>
      </td>
    </tr></table>
  </td></tr>
  <tr><td style="padding:6px 32px 0;">
    ${shown.map((d) => dealCard(d, now)).join("")}
    ${more > 0 ? `<div style="font-size:12px; color:#6b7280; padding:2px 0 6px;">+ ${more} more in ${escapeHtml(rule.label)}</div>` : ""}
  </td></tr>`;
}

function bottomTable(byStage) {
  const cols = TABLE_STAGES.map(([key, label]) => {
    const deals = byStage[key] || [];
    const items = deals
      .map((o) => {
        const rev = formatINR((o.data || {}).amount);
        const sft = formatSft((o.data || {}).requirementInSft);
        const bits = [escapeHtml(o.companyName || "—"), sft && escapeHtml(sft), rev && escapeHtml(rev)]
          .filter(Boolean)
          .join(" · ");
        return `<div style="font-size:12px; color:#374151; padding:4px 0; border-bottom:1px solid #f3f4f6;">${bits}</div>`;
      })
      .join("");
    return `<td valign="top" style="width:33.3%; padding:0 8px; vertical-align:top;">
      <div style="font-size:13px; font-weight:700; color:#111827; padding-bottom:6px; border-bottom:2px solid #e5e7eb; margin-bottom:4px;">${escapeHtml(label)} <span style="color:#9ca3af; font-weight:500;">· ${deals.length}</span></div>
      ${items || '<div style="font-size:12px;color:#9ca3af;padding:4px 0;">—</div>'}
    </td>`;
  }).join("");

  return `
  <tr><td style="padding:24px 32px 8px;">
    <div style="font-size:15px; font-weight:700; color:#111827;">Later-stage deals</div>
    <div style="font-size:11px; color:#9ca3af; padding-top:2px;">Negotiation · Agreement · Money Collection — no SLA timer in v1</div>
  </td></tr>
  <tr><td style="padding:6px 24px 8px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cols}</tr></table>
  </td></tr>`;
}

/**
 * Build the morning-briefing HTML for one recipient.
 * @param {object} args
 * @param {string} args.name
 * @param {object[]} args.opps - mirror rows owned/assigned to them
 * @param {Date}   [args.now]
 * @param {number} [args.capPerStage] - preview cap per card stage (0 = no cap)
 * @param {boolean}[args.bodyOnly] - inner HTML only (for local preview pages)
 * @returns {{ html: string, total: number, slaCounts: object }}
 */
export function buildMorningBriefing({ name, opps, now = new Date(), capPerStage = 0, bodyOnly = false }) {
  const byStage = {};
  for (const o of opps) {
    if (EXCLUDED_STAGES.includes(o.stage)) continue;
    o._sla = slaColorFor(o.stage, o.stageEnteredAt, now);
    (byStage[o.stage] ??= []).push(o);
  }
  // Card stages: RED→YELLOW→GREEN, then FIFO (oldest in stage first).
  for (const s of CARD_STAGES) {
    (byStage[s] || []).sort((a, b) => {
      const sev = SEVERITY[a._sla] - SEVERITY[b._sla];
      if (sev !== 0) return sev;
      return new Date(a.stageEnteredAt || 0) - new Date(b.stageEnteredAt || 0);
    });
  }

  const active = [...CARD_STAGES, ...TABLE_STAGES.map((t) => t[0])].flatMap((s) => byStage[s] || []);
  const total = active.length;
  const updatedYtd = active.filter((o) => isIstDayOffset(o.lastMeaningfulUpdateAt, 1, now)).length;
  const slaCounts = { RED: 0, YELLOW: 0, GREEN: 0 };
  for (const s of CARD_STAGES) for (const o of byStage[s] || []) slaCounts[o._sla]++;
  const slaTotal = slaCounts.RED + slaCounts.YELLOW + slaCounts.GREEN || 1;
  const pct = (n) => Math.round((n / slaTotal) * 100);

  const dateLabel = now.toLocaleDateString("en-IN", {
    timeZone: IST,
    weekday: "long",
    day: "2-digit",
    month: "long",
  });
  const cardSections = CARD_STAGES.map((s) => cardSection(s, byStage[s] || [], now, capPerStage)).join("");

  const inner = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:720px; margin:0 auto; background:#fff; border:1px solid #e5e7eb; border-radius:10px;">
    <tr><td style="padding:24px 32px 8px; border-bottom:1px solid #f3f4f6;">
      <div style="font-size:12px; color:#6b7280; letter-spacing:.04em; text-transform:uppercase;">Morning briefing · ${escapeHtml(dateLabel)}</div>
      <h1 style="margin:6px 0 2px; font-size:20px; font-weight:700; color:#111827;">Good morning, ${escapeHtml(name)}</h1>
      <p style="margin:0; font-size:13px; color:#6b7280;">You own <strong>${total}</strong> active deals. Work top-to-bottom — red first.</p>
    </td></tr>
    <tr><td style="padding:16px 32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb; border-radius:8px;">
        <tr>
          <td style="padding:14px 16px; text-align:center; border-right:1px solid #eee;">
            <div style="font-size:22px; font-weight:800; color:#111827;">${total}</div>
            <div style="font-size:11px; color:#6b7280;">Active deals</div>
          </td>
          <td style="padding:14px 16px; text-align:center; border-right:1px solid #eee;">
            <div style="font-size:22px; font-weight:800; color:#111827;">${updatedYtd}</div>
            <div style="font-size:11px; color:#6b7280;">Updated yesterday</div>
          </td>
          <td style="padding:14px 16px; text-align:center;">
            <div style="font-size:13px; font-weight:700;">
              <span style="color:${COLORS.RED.chip};">${slaCounts.RED} red</span> ·
              <span style="color:${COLORS.YELLOW.chip};">${slaCounts.YELLOW} yellow</span> ·
              <span style="color:${COLORS.GREEN.chip};">${slaCounts.GREEN} green</span>
            </div>
            <div style="font-size:11px; color:#6b7280;">${pct(slaCounts.RED)}% / ${pct(slaCounts.YELLOW)}% / ${pct(slaCounts.GREEN)}% of SLA-tracked</div>
          </td>
        </tr>
      </table>
    </td></tr>
    ${cardSections}
    ${bottomTable(byStage)}
    <tr><td style="padding:20px 32px 26px; border-top:1px solid #f3f4f6;">
      <a href="${DASHBOARD_URL}" style="color:#2563eb; text-decoration:none; font-size:14px; font-weight:600;">Open your deals in the CRM →</a>
      <p style="margin:12px 0 0; font-size:11px; color:#9ca3af;">Phone numbers are masked in this preview. Automated briefing from Wareongo CRM.</p>
    </td></tr>
  </table>`;

  const html = bodyOnly
    ? `<div style="background:#f3f4f6; padding:24px 12px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">${inner}</div>`
    : `<!doctype html><html><body style="margin:0; padding:24px; background:#f3f4f6; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; color:#111827;">${inner}</body></html>`;

  return { html, total, slaCounts };
}

// Exact-membership test against the comma-joined assigneeEmail (case-insensitive).
// Avoids substring over-matching, e.g. contains("raj@..") wrongly matching
// "neeraj@..". assigneeEmail is already stored lowercased by the sync.
function ownsDeal(opp, email) {
  const target = email.trim().toLowerCase();
  return (opp.assigneeEmail || "")
    .split(",")
    .some((e) => e.trim().toLowerCase() === target);
}

/**
 * Fetch a recipient's deals from the mirror (exact assignee match) and build.
 * `contains` is used only as a cheap DB pre-filter; ownsDeal does the exact test.
 */
export async function buildMorningBriefingFor(email, { name, capPerStage = 0, bodyOnly = false } = {}) {
  const candidates = await prisma.opportunity.findMany({
    where: { assigneeEmail: { contains: email.trim().toLowerCase() }, deletedAt: null },
  });
  const opps = candidates.filter((o) => ownsDeal(o, email));
  return buildMorningBriefing({ name: name || email.split("@")[0], opps, capPerStage, bodyOnly });
}

/**
 * Orchestrator: send a morning briefing to every sales recipient with at least
 * one active deal. Called by the /morning-briefing endpoint (pg_cron, 7:30 IST).
 * @param {object} [opts]
 * @param {string} [opts.dryRunEmail] - if set, ALL mail is redirected here
 * @returns {{ sent: number, skipped: number, recipients: number }}
 */
export async function sendMorningBriefings({ dryRunEmail } = {}) {
  const recipients = await getSalesRecipients();
  let sent = 0;
  let skipped = 0;

  for (const { email, name } of recipients) {
    try {
      const { html, total } = await buildMorningBriefingFor(email, { name });
      if (total === 0) {
        skipped++;
        continue;
      }
      const subject = `Your morning briefing — ${total} active deals`;
      await sendWithRetry({ to: dryRunEmail || email, subject, html, text: `You have ${total} active deals. Open ${DASHBOARD_URL}` });
      sent++;
    } catch (err) {
      // One recipient failing (build or send) must not abort the whole run.
      console.error(`[morning-briefing] failed for ${email}:`, err.message);
    }
  }

  console.log(`[morning-briefing] done sent=${sent} skipped=${skipped} recipients=${recipients.length}`);
  return { sent, skipped, recipients: recipients.length };
}
