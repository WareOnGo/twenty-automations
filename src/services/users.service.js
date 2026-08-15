import prisma from "../lib/prisma.js";

// Normalize a phone string to E.164 (the format stored in VerifiedNumber).
// Accepts the common shapes we expect to see — Twilio's `whatsapp:+91...`,
// bare 10-digit Indian numbers, country-code-prefixed digits without a `+`.
// Returns null if the input doesn't fit any recognized shape.
export function normalizePhone(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/^whatsapp:/i, "");
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+")) {
    return /^\+\d{10,15}$/.test(s) ? s : null;
  }
  if (/^91\d{10}$/.test(s)) return "+" + s;
  if (/^\d{10}$/.test(s)) return "+91" + s;
  return null;
}

// Look up a team member by phone. Returns the full VerifiedNumber row
// (id, phone_number, name, twenty_user_id, email, is_active, ...) or null.
export async function findUserByPhone(input) {
  const phone = normalizePhone(input);
  if (!phone) return null;
  return prisma.verifiedNumber.findUnique({
    where: { phone_number: phone },
  });
}
