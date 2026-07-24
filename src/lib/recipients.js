import prisma from "./prisma.js";

// ---------------------------------------------------------------------------
// Resolves who receives which automated mail, from the VerifiedNumber roster
// (the same table the reminder/webhook code uses to map Twenty members -> email).
// Relevant columns: email, name, is_active, twenty_user_id, role, adminAccess.
// ---------------------------------------------------------------------------

// Admins get Mail 2 (team hygiene + escalations). Falls back to the two names
// the brief designates if nobody is flagged in the DB yet.
const ADMIN_FALLBACK = [
  { email: "jayanth@wareongo.com", name: "Jayanth" },
  { email: "dhaval@wareongo.com", name: "Dhaval" },
];

/**
 * Sales people who should receive a personal morning briefing: active roster
 * members that have an email and are linked to a Twenty workspace member.
 * @returns {Promise<Array<{email: string, name: string, twentyUserId: string}>>}
 */
export async function getSalesRecipients() {
  const rows = await prisma.verifiedNumber.findMany({
    where: { is_active: true, email: { not: null }, twenty_user_id: { not: null } },
    select: { email: true, name: true, twenty_user_id: true },
  });
  return rows.map((r) => ({ email: r.email.toLowerCase(), name: r.name, twentyUserId: r.twenty_user_id }));
}

/**
 * Admin recipients for the escalation digest.
 * @returns {Promise<Array<{email: string, name: string}>>}
 */
export async function getAdminRecipients() {
  const rows = await prisma.verifiedNumber.findMany({
    where: { is_active: true, adminAccess: true, email: { not: null } },
    select: { email: true, name: true },
  });
  if (!rows.length) return ADMIN_FALLBACK;
  return rows.map((r) => ({ email: r.email.toLowerCase(), name: r.name }));
}
