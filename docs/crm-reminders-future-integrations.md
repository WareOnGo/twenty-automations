# Future CRM reminder integrations

These are follow-on integrations, not part of the basic WhatsApp reminder beta.
The beta contract and activation instructions are in [crm-reminder-beta.md](crm-reminder-beta.md).

## Exact assignment events

Add a durable assignment-change event carrying opportunity ID, assignee DB ID,
source occurrence time and unique event ID. Capture it for every supported write
path, including direct Twenty UI edits, imports and API writes. A CRM API gateway
alone would miss direct UI assignments; investigate Twenty's supported event/audit
surface before choosing the implementation.

Use that source timestamp for T0 and deduplicate events. Keep poll reconciliation
as a recovery mechanism and retain both source and observed timestamps. Do not
infer assignment time from unrelated `updatedAt` changes or lead creation. Retain
the fixed new-lead cutoff and do not enroll historical entries when events arrive
late or integrations are connected later.

Also order contact events against the assignment event. In the polling beta,
assignment and contact can both happen before the first observation; the captured
contact baseline cannot establish which happened first and may miss completion.

## Reminder context in subsequent WhatsApp replies

Ramesh stores automation sends under phone-number chat IDs, while incoming replies
may use a LID for the same employee. Its current history readers and durable-memory
keys do not join those aliases, even when employee identity resolves correctly.
Bind both aliases through verified identity mappings before depending on a reply
such as “help me with this lead” to retain the reminder context. Also test first-use
and reset memory boundaries, which can exclude earlier messages. This integration
is separate from deterministic reminder generation and delivery.

## Employee mailbox connection and case management

Keep the employee's stable DB ID as identity, independent of email. Model connection
state explicitly: `missing_email`, `not_connected`, `connected`, `reauth_required`
and `access_revoked`. A missing address is different from a connected mailbox whose
token has expired. Route setup tasks to the affected employee through their verified
WhatsApp number; avoid repeatedly creating the same setup case.

When no mailbox is connected, continue providing plain-text drafts and the manual
CRM completion path. Do not tell the employee a Gmail draft exists. A missing
client address should create a separate lead-data task and allow a phone/WhatsApp
action where appropriate. Missing employee phone/identity and missing lead owner
need explicit routing cases with a configured operations owner; that fallback is
not invented by the current beta.

Setup/integration failures should be visible separately from salesperson action
overdue. Founder escalation should identify the reason: no assigned salesperson,
unrecorded outreach, missing contact details, unavailable integration or failed
reminder delivery. Connecting Gmail must not retroactively claim that older drafts
were sent or restart existing assignment clocks.

## Draft creation and proof of sending

With employee authorization, create drafts in their connected mailbox and save the
correlation: employee ID, opportunity ID, assignment episode, mailbox identity,
draft ID, message/thread IDs where available, intended recipients and creation time.
The existing Context Engine draft tool is a candidate integration, but draft
creation alone supplies no sent-status observer.

Observe the authenticated sender's mailbox for a matching sent message. Prefer a
durable, unique correlation header/message identifier where the provider supports
it, then verify sender, intended recipients, opportunity and send time. Subject
matching or thread existence alone is not reliable proof. Edits, deleted drafts,
multiple drafts in one thread and sends outside the integration need explicit
handling. Do not count a draft merely disappearing as sent.

For Gmail, sending removes the draft and creates a new sent message with the
`SENT` label; draft ID and sent-message ID are different concepts. Build against
the [Gmail draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts)
and retrieve the sent message through
[messages.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get).

Use mailbox change notifications plus durable history cursors and periodic
reconciliation. Handle watch renewal, duplicates, gaps, revoked access and history
expiration. Gmail explicitly requires handling missed/delayed notifications; see
[push notification guidance](https://developers.google.com/workspace/gmail/api/guides/push).
Do not assume a notification means the draft was sent.

Expose evidence distinctly: `draft_created`, `sent_verified`, `contact_recorded`
and `client_replied`. Provider acceptance, delivery, read receipt and commercial
progress are different events. A reply should pause follow-ups and create the
appropriate next-action task once reply matching is supported.

## Escalation evidence and task acknowledgement

Today the 8-hour condition means an eligible assignment remains in intake without
a qualifying CRM contact update. It does not measure whether the employee read
the reminder or actually contacted the client outside CRM.

Future escalation cases should include assignment age in working hours, last
recorded contact, verified sent/reply evidence, draft state, reminder transport
outcomes and unresolved setup blockers. Keep founder exemptions and the exclusion
of an escalation recipient's own deals configurable by DB ID.

Add a scoped completion/acknowledgement/snooze action only after agreeing what each
means. “Acknowledged” must not equal “client contacted.” Link it to the exact lead
and assignment episode, authenticate the employee and append an audit event. Any
manual override should preserve who made it and why. A live source check and queued
message cancellation/revalidation in Ramesh would reduce stale reminders after
completion; the current outbound API has no cancellation operation.

## Remaining Stage 1 and Stage 2 PRD work

The founder removed Stage 1 Day 5 logic; implement any additional approved Stage 1
actions within the agreed 1–2-day window. The current beta uses the same 0/2/4/8
working-hour sequence across sources and only varies draft text for warm leads.

Future work requires separate acceptance criteria for source/age-aware warm-lead
ladders, verified warehouse shortlists and teaser generation, human draft approval,
client reply detection, qualification-call outcomes, proposal-sent evidence, site
visit booking and the Stage 2 follow-up cadence. Define the actual CRM stage/field
mapping for each before building it. Proposal Shared currently ends this beta
sequence rather than starting a new campaign.

Before any automatic customer-facing send, implement the PRD's channel/touch
limits, allowed contact hours, reply pause and human approval. Internal reminder
delivery is not a customer touch. Keep Stage 3+ excluded until its PRD is refined.
