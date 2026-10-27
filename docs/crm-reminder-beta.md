# Assignment reminder beta

This implements the agreed basic reminder slice of the CRM funnel PRD. Messages
go internally through Ramesh's outbound endpoint. Staff review the supplied
outreach text and contact the client themselves. There is no new email integration,
mailbox access, automatic client outreach, Day 5 action or Stage 3+ automation.

## Who receives what

The checked-in environment example uses these verified `VerifiedNumber.id` values:

| Employee | DB ID | Assignment / 2h / 4h | Escalation of their assignment at 8h |
|---|---:|---|---|
| Maneesh | 12 | Yes | Dhaval and Jayanth |
| Nihas | 19 | Yes | Dhaval and Jayanth |
| Raghav | 1 | Yes | Dhaval and Jayanth |
| Dhaval | 2 | Yes | None |
| Jayanth | 5 | Yes | None |

An escalation recipient is excluded if they own the lead or are one of its current
assignees. With mixed co-assignees, only the non-exempt person's overdue assignment
can escalate. Each person's assignment is independent: two overdue people on one
lead can produce two escalation cases per eligible recipient. A case escalates at
most once to each recipient, even if another assignee is subsequently removed.

The initial message includes the CRM link, available lead/contact/requirement
details, acknowledgement and clarification or warm-lead qualification drafts,
and a teaser template. Teaser placeholders must be filled with verified options;
the beta does not invent or select inventory. The 2h and 4h messages ask staff to
contact the client and update CRM. Non-exempt assignees see the escalation deadline;
Dhaval and Jayanth see no escalation warning for their sequences.

## Eligibility, clock and completion

- Only source Twenty `createdAt >= CRM_REMINDER_NEW_LEADS_FROM` is eligible. Older
  leads remain excluded after edits, reassignment or stage changes. The initial
  dispatch stores this cutoff in the database; changing it subsequently fails
  closed. It must be an explicit fixed ISO timestamp with a time zone, never a
  moving “now” value on every restart.
- This rollout starts on **27 October 2026 at 00:00 IST**
  (`2026-10-26T18:30:00.000Z`). Configuration cannot move the cutoff earlier;
  a later activation timestamp is allowed before the first dispatch. All future
  newly created leads can enroll as they are assigned. Eligible unresolved leads
  retain their clocks across days; the cutoff does not advance each midnight.
- Only `NEW_LEAD` and `RFQ_RECEIVED` run this sequence. Moving between these two
  stages preserves the same clock; leaving them stops it. The full Proposal Shared
  / Stage 2 cadence is future work.
- T0 is per assignee, when the poller first observes that person on the lead.
  **Twenty's current snapshot has no trustworthy assignment-event timestamp.**
  This is normally within one ten-minute sync interval of the actual assignment,
  plus sync duration; outages can delay observation further. Neither lead creation
  nor generic `updatedAt` is used as the assignment clock. Events that occur and
  disappear entirely between polls cannot be reconstructed. If assignment and
  contact both occur before the first poll, their order is unknown: the contact
  is captured as a baseline and may not stop this sequence. Exact assignment and
  contact events are needed to close that gap.
- Unchanged assignees keep T0 across edits and restarts. Newly added people receive
  their own T0; removing someone stops their sequence. Removing and later adding
  the same person creates a new assignment episode.
- The PRD's hour clock runs every day from **08:00 to 20:00 IST**. Overnight time
  does not count. A deadline at closing time is delivered from 08:00 next morning.
  An assignment outside this window receives its initial message next morning.
  No holiday calendar is assumed. Dispatch occurs on the next successful tick.
- An explicit `Last contacted` timestamp at/after T0 and not in the future, or an
  exit from the intake stages, completes the sequence. This is a CRM-recorded
  outcome, **not proof that an email/draft was sent**. Generic edits, notes and
  successful delivery of the internal reminder do not complete it. Contact is a
  lead-level field, so qualifying contact completes all earlier assignments on
  that lead. A pre-existing contact value does not count for a later assignment.
- If an API returns a date-only contact value, a newly observed change to the
  assignment day or a later day also counts. Re-saving an unchanged date is not
  observable; the future event integration must resolve that ambiguity.
- Completion is retained for the assignment episode. Returning the same assignee
  to an intake stage does not replay a completed sequence.
- Missed ticks coalesce to the latest due step, avoiding a burst of 0h/2h/4h
  messages after an outage. At 8h, only the escalation is due for non-exempt people.

## Unassigned and missing-information cases

A new eligible lead with no assignees generates one message to its actual Twenty
owner asking them to assign someone. No salesperson SLA starts until assignment.
The beta gate also applies to this owner notification; other employees are not
messaged during beta. A new owner or a new period without assignees opens a new case.

Employee email is not used. Routing uses an active `VerifiedNumber` row and its
verified E.164 phone number. Owner lookup uses `ownerId -> twenty_user_id`; creator
is never substituted. Assignment enum values use the explicit environment map;
unmapped values resolve only when the first name identifies exactly one DB user.

Missing/ambiguous identities, missing owners and missing phone numbers are visible
as `routingIssues`; no arbitrary fallback recipient is selected. An admitted
assignee with a missing phone can still produce an overdue escalation. Fixing
their phone does not reset T0. Adding someone to the whitelist later does not
retroactively enroll their previously observed assignments. Identity-map changes
must not silently transfer an existing case to another person.

## Configuration and rollout

Defaults are in [`.env.example`](../.env.example). Sending is **off by default**.
Keep secrets in the deployment environment, never in source control.

| Variable | Meaning |
|---|---|
| `CRM_LEAD_REMINDERS_ENABLED` | Exact `true` enables dispatch; `false` stops new enqueue attempts. |
| `CRM_REMINDER_NEW_LEADS_FROM` | Fixed source-creation cutoff: `2026-10-27T00:00:00+05:30` or a later activation timestamp. |
| `CRM_REMINDER_BETA_EMPLOYEE_IDS` | Beta assignees and eligible owners: `12,19,1,2,5`. |
| `CRM_REMINDER_ESCALATION_EMPLOYEE_IDS` | Escalation recipients: `2,5`. |
| `CRM_REMINDER_ESCALATION_EXEMPT_EMPLOYEE_IDS` | Assignee sequences that never escalate: `2,5`. |
| `CRM_REMINDER_ASSIGNEE_MAP` | Exact uppercase Twenty enum to stable DB ID map. |
| `RAMESH_API_URL` | HTTPS origin, currently `https://wareongo-ramesh.duckdns.org`. |
| `RAMESH_AUTOMATION_API_KEY` | Dedicated outbound API credential; not the interactive agent credential. |

The existing `DATABASE_URL`, `TWENTY_CRM_BASE_URL`, `TWENTY_CRM_API_KEY` and
`REMINDER_SECRET` are reused. The beta does not change existing email briefing jobs.

1. Install dependencies and keep `CRM_LEAD_REMINDERS_ENABLED=false` while deploying.
2. The main-branch deployment runs `npm run reminders:migrate` before restarting
   the app; manual deployments must run it with the DB owner connection. This transactional,
   idempotent migration adds only `crm_reminder_rollout`, `crm_lead_reminder_state`
   and `crm_lead_reminder_outbox`; all have RLS and revoked public/API-role access.
   Do not run `prisma db push` against the shared database.
3. Configure the recipient IDs, enum map, Ramesh origin and explicit cutoff. Use
   `2026-10-27T00:00:00+05:30` for the agreed rollout, or a later activation time.
   Earlier values are rejected, so historical records cannot be enrolled.
4. After a healthy sync, call authenticated `POST /lead-reminders` with `{}` or
   `{"dispatch":false}`. Preview works with sending disabled and requires no
   Ramesh API key. It reads the current source, returns message text/recipient IDs,
   and does **not** persist assignment clocks, lock the rollout or send messages.
   For an existing notification it shows the stored text, including the frozen
   payload of a pending retry, rather than regenerating different retry content.
   With no eligible new leads it correctly returns an empty preview. Do not move
   the cutoff backwards to obtain examples from historical customer records.
5. Supply the dedicated outbound credential and enable dispatch when activating
   the reviewed beta. Every non-skipped existing `/sync` run then invokes reminders;
   reminders independently require a healthy opportunity sync, so a notes/tasks
   failure does not postpone assignment clocks or block otherwise eligible sends.
   No additional cron job is required. `POST /lead-reminders` with
   `{"dispatch":true}` is also available for an explicit authenticated tick.
6. Check the nested `reminders` result in `/sync`, the preview endpoint and outbox
   outcomes. Disabling the flag stops future dispatch; retain the tables and fixed
   cutoff so a restart cannot replay old cases. Reminder failures make `/sync`
   return HTTP 503 with top-level `status: "partial"`, retaining per-stream results.

The preview endpoint uses the existing `X-Auth` guard and returns `Cache-Control:
no-store`. Its response includes `examined`, `queued`, `alreadyRecorded`,
`routingIssues`, `failures`, `deliveryFailures` and preview `notifications`.
`partial` and `source_unavailable` return HTTP 503. A disabled dispatch or a worker
already holding the lease returns the corresponding status without sending.
Failures do not include provider bodies, credentials or recipient phone numbers.

## Delivery and operations

The engine requires a successful recent opportunity sync and no active sync lock.
It re-reads a due lead from Twenty and refreshes the employee roster before enqueue,
so a known stale mirror cannot message a removed assignee or completed lead.
One invalid row is skipped; a failed live check suppresses that lead's sends while
preserving its observed T0. Private tables preserve state across worker restarts.
A database lease fences concurrent workers.

Ramesh receives `POST /v1/outbound-messages` with `X-Ramesh-Api-Key`, a stable
`Idempotency-Key`, and `{to,text,expiresInSeconds:900}`. The first payload is frozen
in the outbox; an ambiguous POST retry uses exactly the same key and payload.
Pending POST retries stop after 24 hours, well inside the provider's 30-day
idempotency retention, and are recorded as `RETRY_WINDOW_EXPIRED` for investigation.
If quiet hours or temporarily unavailable routing made an unaccepted intent no
longer due, it may resume when the same notification becomes due again. Its key,
payload and original 24-hour retry window are retained. Completed/removed
assignments and obsolete lower reminder steps do not become due again.
Rejected requests and terminal provider outcomes are recorded. `FAILED`, `EXPIRED`
and `UNCERTAIN` are not retried under a new key. Operators should inspect those
outcomes; a delivery failure is not evidence of salesperson non-compliance.

Ramesh `SENT` means its SDK accepted the internal WhatsApp send. It does not prove
delivery/read, client contact or email sending. GET status checks update the
outbox. A higher reminder step can still occur later if the CRM case is unresolved.

An accepted Ramesh message cannot currently be cancelled. A CRM update immediately
after the live check, or while a message is queued, can therefore leave one stale
reminder. The short expiry reduces this window while the connection is available;
Ramesh pauses expiry while disconnected, so it is **not** a wall-clock cancellation
guarantee. This limitation also applies when the dispatch flag is turned off.

## Verification

`npm test` includes policy, transport, source and route checks, plus the real
migration/repository SQL running in an isolated PGlite PostgreSQL database. The
tests cover founders' exemptions, forward-only enrollment, completion, reassignments,
stale mirrors, retries, frozen payloads, cutoff immutability and lease fencing.
All notification fixtures are synthetic; tests need no live DB or WhatsApp send.

`npm run reminders:dry-run` additionally exercises the real Express application,
`/sync` and `/lead-reminders`, Prisma over TCP, the actual reminder migration and
the outbound HTTP client. It creates an in-memory PGlite database, uses local
Twenty/Ramesh stand-ins and rejects external fetch destinations before networking.
It forces synthetic credentials and recipients, bypasses dotenv configuration,
and verifies a private in-memory DB marker before any Prisma migration or write.
The command needs permission to bind loopback ports; it does not require Docker or
a production DB connection. The Ramesh stand-in only records JSON; it cannot relay
messages. The clock is simulated so an entire working-day sequence finishes quickly.

Run `npm run reminders:dry-run -- --report=/tmp/crm-reminder-e2e-report.json` to save
the result at an explicit path. Exit status is nonzero if a scenario fails or an
external fetch is attempted. See [recorded E2E results](crm-reminder-e2e-results.md)
for the scenarios, corrections and limits of this verification.

See [future integrations](crm-reminders-future-integrations.md) for the deliberately
deferred mailbox, assignment-event and broader PRD work.
