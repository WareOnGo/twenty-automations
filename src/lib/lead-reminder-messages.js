import { workingDeadline } from "./lead-reminder-policy.js";

function text(value, max = 180) {
  return typeof value === "string" || typeof value === "number"
    ? String(value).replace(/[\r\n\t\u0000-\u001f]+/g, " ").trim().slice(0, max) : "";
}
function time(value) {
  return new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata",
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true }) + " IST";
}
function contact(record) {
  const p = record.pocPhoneNumber || {};
  return [p.primaryPhoneCallingCode, p.primaryPhoneNumber].filter(Boolean).map(v => text(v, 24)).join(" ");
}

export function buildReminderMessage(record, notification, config) {
  const name = text(record.name) || "New lead";
  const client = [record.pocName?.firstName, record.pocName?.lastName].filter(Boolean).join(" ");
  const requirement = text(record.requirementInSft, 80);
  const details = [
    "Lead: " + name,
    record.companyName && "Company: " + text(record.companyName),
    client && "Contact: " + text(client, 100),
    contact(record) && "Phone: " + contact(record),
    record.companyEmail && "Client email: " + text(record.companyEmail),
    (record.city || record.microMarket) && "Location: " +
      [record.city, record.microMarket].filter(Boolean).map(v => text(v, 100)).join(" / "),
    requirement && "Requirement: " + requirement + " sq ft",
    record.budget && "Budget: " + text(record.budget, 100),
    record.occupancyTimeline && "Timeline: " + text(record.occupancyTimeline, 100),
    record.leadSource && "Source: " + text(record.leadSource, 80),
    record.description && "Brief: " + text(record.description, 320),
    "CRM: " + config.crmUrl + "/object/opportunity/" + encodeURIComponent(record.id),
  ].filter(Boolean).join("\n");
  const action = "After contacting the client, update Last contacted in CRM. Moving the lead out of New Lead/RFQ Received also stops this sequence.";
  if (notification.step === "owner") {
    return "This new CRM lead has no assignee. Please assign a salesperson so they can start following up.\n\n" + details;
  }
  if (notification.step === "8") {
    const people = notification.assignments.map(a => text(a.key, 60)).join(", ");
    return "CRM escalation: 8 working hours have passed since assignment was observed for " + people +
      ". No qualifying contact has been recorded; this does not establish whether outreach happened outside CRM.\n" +
      "Please check the blocker and agree the next action.\n\n" + details;
  }
  const a = notification.assignments[0];
  const deadline = time(workingDeadline(a.assignedAt, 8));
  const exempt = (config.escalationExemptIds || []).includes(a.employeeId);
  const escalation = exempt ? "Your reminder sequence has no management escalation." :
    "If still unresolved, this will be escalated at " + deadline +
    " to management.";
  if (notification.step !== "0") {
    return "CRM follow-up: " + notification.step + " working hours since assignment.\n" +
      "Please contact the client and record the outcome. " + escalation + "\n\n" + details + "\n\n" + action;
  }
  const salesperson = text(notification.recipient.name, 80);
  const greeting = client ? "Hi " + text(client, 80) : "Hi";
  const location = [record.microMarket, record.city].filter(Boolean).map(v => text(v, 60)).join(", ");
  const summary = [requirement && requirement + " sq ft", location].filter(Boolean).join(" in ");
  const acknowledgement = greeting + ", I'm " + salesperson +
    " from WareOnGo and I'll be your point of contact for your warehouse requirement" +
    (summary ? " (" + summary + ")" : "") +
    ". Could we have a quick call to confirm the brief and agree the next steps?";
  const warm = ["GODAMWALE", "BROKER", "CLIENT_OWNER_REFERRAL", "GW_REACTIVATION"].includes(record.leadSource);
  const clarification = warm
    ? "I have your initial requirement. Could we schedule a short qualification call to confirm the details and discuss suitable options?"
    : "Could you confirm the required area, preferred micro-market, move-in timeline, clear height, docks, compliance needs and budget? Please share only anything we have not already covered.";
  const teaser = "Options to review: [verified option 1 + key specs], [verified option 2 + key specs]" +
    " [optional third]. [State any assumptions.] Which looks closest to your requirement, and would [slot 1] or [slot 2] work for a walkthrough?";
  return "A new lead has been assigned to you on CRM.\n\n" + details +
    "\n\nOutreach draft — review and send:\n" + acknowledgement +
    "\n\n" + (warm ? "Qualification-call draft" : "Clarification draft — remove questions already answered") +
    ":\n" + clarification +
    "\n\nTeaser template — fill with verified options before sending:\n" + teaser +
    "\n\nMake an intro call within 2 working hours. After sharing a teaser, call within 30 working minutes to discuss it.\n" +
    escalation + "\n" + action;
}
