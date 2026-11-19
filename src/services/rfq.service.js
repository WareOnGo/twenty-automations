import OpenAI from "openai";
import { listRecordsSince } from "./twenty.service.js";
import { resolveAssigneeNames } from "../lib/crm-assignments.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Allowed intake aliases, resolved against live Workspace Members before writing.
const ASSIGNABLE_USERS = String(process.env.ASSIGNABLE_USERS || "")
  .split(",")
  .map((u) => u.trim().toUpperCase())
  .filter(Boolean);
const ASSIGNABLE_LOOKUP = new Map(ASSIGNABLE_USERS.map((u) => [u.toLowerCase(), u]));

const opportunitySchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Format: 'Company - Space - Area, City'. E.g. 'Acme Corp - 5,000 sqft - HSR Layout, Bangalore'. Use TBD for unknown parts." },
    amount: {
      type: "object",
      properties: {
        amountMicros: { type: "string", description: "Total deal size as a plain number string. E.g. Rs 2,20,000 → \"220000\". 5 lakhs → \"500000\". Use \"0\" if total deal size is not explicitly mentioned." },
        currencyCode: { type: "string", enum: ["INR", "USD", "EUR"] },
      },
      required: ["amountMicros", "currencyCode"],
      additionalProperties: false,
    },
    stage: { type: "string", enum: ["NEW_LEAD", "RFQ_RECEIVED", "RFQ_NOT_RELEVANT", "PROPOSAL_SHARED", "FOLLOW_UP"] },
    leadSource: { type: "string", enum: ["GODAMWALE", "BROKER", "WHATSAPP_INBOUND"] },
    duration: { type: "string", enum: ["LONG_TERM", "SHORT_TERM"] },
    city: { type: "string", description: "City mentioned in the RFQ. Use empty string if not mentioned." },
    repeatCustomer: { type: "boolean" },
    companyName: { type: "string", description: "Company or business name of the client. Use empty string if not mentioned." },
    pocName: {
      type: "object",
      properties: {
        firstName: { type: "string", description: "First name of the point of contact. Use empty string if not mentioned." },
        lastName: { type: "string", description: "Last name of the point of contact. Use empty string if not mentioned." },
      },
      required: ["firstName", "lastName"],
      additionalProperties: false,
    },
    pocPhoneNumber: {
      type: "object",
      properties: {
        primaryPhoneNumber: { type: "string", description: "Phone number without country code. Use empty string if not mentioned." },
        primaryPhoneCallingCode: { type: "string", description: "Calling code. Default \"+91\" for Indian numbers." },
        primaryPhoneCountryCode: { type: "string", description: "ISO country code. Default \"IN\" for Indian numbers." },
      },
      required: ["primaryPhoneNumber", "primaryPhoneCallingCode", "primaryPhoneCountryCode"],
      additionalProperties: false,
    },
    budget: { type: "string", description: "Budget per square foot as a plain number string. E.g. Rs 25/sqft → \"25\". Use empty string if not mentioned." },
    assignTo: {
      type: "array",
      items: { type: "string" },
      description: "First names of teammates the RFQ explicitly asks to be assigned (e.g. 'assign to jayanth', 'dhaval please handle this'). Empty array if no explicit assignment intent.",
    },
  },
  required: ["name", "amount", "stage", "leadSource", "duration", "city", "repeatCustomer", "companyName", "pocName", "pocPhoneNumber", "budget", "assignTo"],
  additionalProperties: false,
};

export async function parseRfq(rfqText) {
  const today = new Date().toISOString().split("T")[0];

  const completion = await openai.chat.completions.create({
    model: process.env.RFQ_MODEL || "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are an expert RFQ parser for a warehousing and logistics CRM (WareOnGo). Your job is to extract structured opportunity data from natural language RFQ messages — these may come from emails, WhatsApp, broker calls, or internal notes. They are often informal, may be in Hinglish, and may contain incomplete information.

Today's date is ${today}.

CRITICAL RULES:
- Only extract information that is EXPLICITLY stated or can be directly inferred from the text.
- If a field's value cannot be determined from the RFQ, use the designated empty sentinel: "" for strings, "0" for amountMicros, false for booleans.
- NEVER guess, hallucinate, or fill in plausible-sounding data. Missing data is better than wrong data.

FIELD INSTRUCTIONS:
- name: Format STRICTLY as "Company - Space - Area, City". E.g. "Acme Corp - 5,000 sqft - HSR Layout, Bangalore". Space is the area/capacity requested with Indian number formatting (use range if given, e.g. "5,000-10,000 sqft"). Area is the specific locality/area within the city. Use "TBD" for any unknown part.
- amount.amountMicros: The TOTAL deal size as a plain number string — no multiplication. E.g. Rs 2,20,000 → "220000". 5 lakhs → "500000". 1.5 crore → "15000000". ONLY use this if the total deal value is explicitly mentioned. Use "0" if not mentioned. Do NOT derive this from per-sqft rates.
- amount.currencyCode: Almost always "INR" unless USD/EUR is explicitly stated.
- stage: Default to "RFQ_RECEIVED". Valid stages are NEW_LEAD, RFQ_RECEIVED, RFQ_NOT_RELEVANT, PROPOSAL_SHARED, FOLLOW_UP. If the text explicitly mentions a matching keyword — even misspelled or informal (e.g. "proposal sent"/"proposal shared" → PROPOSAL_SHARED, "following up"/"follow up done" → FOLLOW_UP, "not relevant"/"irrelevant"/"spam" → RFQ_NOT_RELEVANT, "new lead" → NEW_LEAD) — map it to that enum value. Do NOT infer a stage from context; only match when the user explicitly states one.
- leadSource: "GODAMWALE" if Godamwale/platform is mentioned, "BROKER" if a broker/agent/referral is mentioned, "WHATSAPP_INBOUND" if the client reached out directly or source is unclear.
- duration: "LONG_TERM" if lock-in/duration is 1 year or above, or if duration is not mentioned. "SHORT_TERM" only if explicitly under 1 year, spot, or one-time.
- city: Exact city name. Use "" if not mentioned.
- repeatCustomer: true ONLY if the text explicitly says existing client, repeat customer, or similar. Default false.
- companyName: The company or business name of the client/requester. Use "" if not mentioned.
- pocName.firstName: First name of the point of contact. Use "" if not mentioned.
- pocName.lastName: Last name of the point of contact. Use "" if not mentioned. If only a single name is given, use it as firstName and leave lastName as "".
- pocPhoneNumber.primaryPhoneNumber: Phone number digits (without country code). Use "" if not mentioned.
- pocPhoneNumber.primaryPhoneCallingCode: Default "+91" (Indian numbers) unless a different country code is explicitly mentioned.
- pocPhoneNumber.primaryPhoneCountryCode: Default "IN" (India) unless a different country is explicitly mentioned.
- budget: Budget per square foot as a plain number string. E.g. Rs 25/sqft → "25". Use "" if not mentioned. Do NOT derive this from total deal size.
- assignTo: List of teammate first names the sender EXPLICITLY asks to assign this RFQ to. Trigger phrases include "assign to <name>", "assigned to <name>", "<name> please handle", "give to <name>", "for <name>". DO NOT include names that appear for any other reason (greetings, signatures, mentions of who the lead is from, who the POC is, etc.). When in doubt, leave it empty. The output is a list of LOWERCASE first names only (e.g. ["jayanth", "dhaval"]). Empty array [] if no explicit assignment intent.`,
      },
      { role: "user", content: rfqText },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "opportunity",
        strict: true,
        schema: opportunitySchema,
      },
    },
  });

  let parsed;
  try {
    parsed = JSON.parse(completion.choices[0].message.content);
  } catch {
    throw new Error("Failed to parse AI response as JSON");
  }

  // Always use the raw RFQ text as the description
  parsed.description = rfqText;

  // Strip fields the AI couldn't determine (empty sentinels)
  if (!parsed.city) delete parsed.city;
  if (!parsed.companyName) delete parsed.companyName;
  if (!parsed.budget) delete parsed.budget;
  if (parsed.amount?.amountMicros === "0") delete parsed.amount;

  // Strip empty poc fields
  if (!parsed.pocName?.firstName && !parsed.pocName?.lastName) {
    delete parsed.pocName;
  }
  if (!parsed.pocPhoneNumber?.primaryPhoneNumber) {
    delete parsed.pocPhoneNumber;
  }

  // Validate the LLM-extracted assignTo names against the configured intake
  // aliases. Anything that doesn't map is dropped silently — better to miss an
  // assignment than to assign the wrong person, per the "be careful" rule.
  const requested = Array.isArray(parsed.assignTo) ? parsed.assignTo : [];
  const seen = new Set();
  const canonical = [];
  for (const raw of requested) {
    const key = String(raw || "").trim().toLowerCase();
    const enumValue = ASSIGNABLE_LOOKUP.get(key);
    if (!enumValue || seen.has(enumValue)) continue;
    seen.add(enumValue);
    canonical.push(enumValue);
  }
  delete parsed.assignTo;
  Object.assign(parsed, resolveAssigneeNames(canonical, canonical.length
    ? await listRecordsSince("workspaceMembers", { depth: 0 }) : []));

  // Twenty's repeatClient is a multi-select enum ["OPTION1", "NO"] (OPTION1 = repeat
  // client, NO = not). The LLM gives us a boolean; map it and drop the boolean — Twenty
  // has no `repeatCustomer` field and would silently ignore it, losing the signal.
  const isRepeat = parsed.repeatCustomer === true;
  delete parsed.repeatCustomer;
  parsed.repeatClient = isRepeat ? ["OPTION1"] : ["NO"];

  return parsed;
}
