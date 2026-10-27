# CRM reminder end-to-end dry-run results

Run on 2026-10-27. **24 scenarios passed; 0 failed. No external HTTP request was
attempted and no real WhatsApp/email message was sent.** The normal test suite also
passes (82 tests), including regression tests for the issues discovered below.

## What was exercised

The harness loads the actual Express application and calls authenticated `/sync`
and `/lead-reminders` over HTTP. It uses the production sync, source, policy,
repository and outbound-client code without replacing their implementations.
The real Prisma client connects over TCP to a disposable PGlite PostgreSQL server.
The actual additive reminder migration is applied through Prisma.

Only the external services are substitutes: a loopback Twenty server returns
synthetic leads, while a loopback Ramesh server records outbound JSON, validates
authentication/idempotency/payload and simulates queue/status/error responses.
The test process forces synthetic configuration before application imports,
bypasses dotenv configuration, and checks a unique in-memory DB marker before any
Prisma migration or write. It rejects non-allowlisted fetch destinations before
opening a connection. No relay or real sender exists in the recording server.

## Five-user timeline

Five unresolved synthetic leads were assigned at 09:00 IST, one per beta employee.
Every employee record had a null email address. Repeated ticks after each step
produced no duplicate enqueue.

| Elapsed working hours | Newly recorded requests | Recipients |
|---:|---:|---|
| 0 | 5 | Maneesh, Nihas, Raghav, Dhaval, Jayanth; details and outreach drafts |
| 2 | 5 | The same five employees |
| 4 | 5 | The same five employees |
| 8 | 6 | Dhaval and Jayanth each receive three escalations, one for each non-founder |

There were 21 distinct recorded notifications in this scenario. Dhaval and
Jayanth's own assignment sequences generated no escalation. Their reminder text
did not threaten an escalation. Separate cases confirmed that a founder who owns
or shares assignment of someone else's lead is excluded as an escalation recipient.

## Other passing scenarios

- Authentication rejects an incorrect secret and a non-boolean dispatch flag.
  Disabled dispatch performs no send. Preview returns drafts without creating
  rollout, assignment-state or outbox rows.
- A complete paginated sync of 2,000 historical leads plus two new leads produced
  exactly one initial reminder: only the new beta-assigned lead qualified. The
  new non-beta lead and all historical leads remained excluded. Editing an old
  lead's assignee/stage did not enroll it.
- The fixed rollout boundary is 27 October 2026, 00:00 IST. A lead created one
  millisecond earlier stayed excluded after reassignment; a lead created exactly
  at the boundary qualified. New leads continued enrolling the following day,
  while the previous day's eligible assignment kept its clock and escalated when
  overdue. Unit checks reject configuration earlier than the rollout boundary.
- An unassigned lead notified its real owner once; assigning Nihas four hours
  later started his own clock, with the next reminder two hours after assignment.
- Missing owners were reported as routing issues. Creator identity and a non-beta
  owner were not used as fallback recipients.
- A qualifying Last contacted change and a move to Proposal Shared each stopped
  the later reminders and escalation through the real sync path.
- An old contact value, an ordinary edit and a separately synced internal note
  did not count as contact completion.
- A pre-existing future contact value did not complete the assignment when the
  clock caught up, after the correction below.
- Adding/removing assignees preserved the unchanged person's clock, started a
  clock for the new person and stopped the removed person's sequence.
- Live contact/deletion state overrode stale mirror data immediately before enqueue.
  A cached reassignment snapshot could not replay the initial message or reset T0.
- A 19:00 IST assignment paused overnight: its 2h reminder arrived at 09:00,
  4h at 11:00 and 8h escalation at 15:00 the next day.
- A simulated acceptance followed by a dropped HTTP connection retried with the
  same idempotency key and frozen payload despite an intervening lead-name edit.
  The preview showed that same stored payload. The recording server retained one
  distinct notification.
- A four-hour outage coalesced reminders to the 4h step and superseded the old
  pending attempt instead of sending an initial/2h/4h burst.
- An `UNCERTAIN` provider outcome was recorded without a blind resend.
- Concurrent authenticated HTTP ticks produced one enqueue using the DB lease.
- Three disconnect/reconnect cycles of the real Prisma client preserved the original
  assignment clock and delivery records, with no replay of the initial message.
- Source failure and an attempted cutoff change suppressed new sends.
- Notes/tasks failures still returned HTTP 503 but did not suppress reminders from
  a healthy opportunity sync or postpone the assignment clock.
- Transport failures and reminder configuration errors made `/sync` return HTTP
  503 with top-level `partial`, retaining the individual stream results.
- A failed owner alert paused overnight and resumed with the original key/text
  next morning, without duplicating an accepted-but-disconnected request.
- A missing employee phone was visible as a routing issue; the overdue case still
  reached the two eligible founders. Email availability played no role.

Across all scenarios the stub recorded 77 POST attempts and 73 distinct accepted
notifications. These counts include deliberately retried/failed test requests and
are not real message deliveries. External fetch attempts: **0**.

## Issues found and corrected

1. **Pre-existing future contact value:** the old comparison allowed a contact
   value that predated assignment observation to become completion evidence when
   wall time reached it. Completion now rejects a value equal to the assignment's
   captured baseline, comparing parsed timestamps so format-only changes cannot
   bypass the check. A subsequent qualifying new contact value still completes it.
2. **Equal-timestamp stale snapshot:** the stale-mirror guard used strictly newer
   timestamps. If a live reassignment and the cached mirror shared timestamp
   precision, another tick could re-create assignment episodes. Equal timestamps
   now trigger a live refresh before reconciliation. The regression verifies no
   duplicate initial message and no T0 reset.
3. **Temporary suppression discarded retries:** quiet hours or a temporarily
   missing phone made a prepared intent `NO_LONGER_DUE`, after which it could
   never retry. A notification that qualifies again now resumes its original
   key/payload. Unit regressions cover phone restoration and confirm that the
   original 24-hour retry window is not restarted. Terminal failures and changed
   recipients are not reactivated by this change.
4. **Unrelated sync failures blocked reminders:** the hook required all three
   streams to succeed. It now invokes reminders after any non-skipped sync; the
   reminder source independently checks opportunity health and the sync lock.
5. **Reminder failure looked like successful sync:** nested reminder failures did
   not affect the HTTP result. They now set top-level `partial` and HTTP 503, so
   callers can detect them without discarding successfully synced stream results.
6. **Preview did not match a pending retry:** it regenerated text from current
   lead fields although dispatch correctly retained the first payload. Preview
   now returns the stored text for an existing notification.

The reconnect test also exposed a race in the one-connection PGlite test server:
Prisma disconnect could complete before the server processed socket closure. The
harness now waits for the server to report zero connections before reconnecting,
with a bounded timeout and an assertion; it does not retry failed application
operations. This is test-harness cleanup, not a production retry policy.

The review removed one redundant completion check immediately after capturing the
same contact value as a new assignment's baseline. Durable state, lease fencing
and the outbox remain necessary for restart and duplicate prevention. No new
runtime service, scheduler or production dependency was added by these fixes.

## Reproduce and scope

```bash
npm install
npm run reminders:dry-run -- --report=/tmp/crm-reminder-e2e-report.json
npm test
```

The dry run never uses production database credentials or the real Ramesh sender.
It validates application behavior and HTTP contract handling, not live WhatsApp
delivery, deployed credentials, production network access or PgBouncer/failover
behavior. The concurrent-request scenario shares one local Prisma connection pool;
PGlite is not a substitute for a production multi-instance load test.

The implementation still starts T0 when assignment is observed by polling,
normally within ten minutes plus sync duration. Contact recorded before that first
observation may be captured as a pre-existing baseline rather than completion;
the snapshot cannot establish assignment/contact ordering. Exact assignment-event timing and
cancellation of already accepted outbound messages remain the documented future
integrations. Sending remains disabled until the separate rollout is activated.
