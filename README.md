# CRM Automations

Backend service for WareOnGo. Two jobs, one Express app:

1. **RFQ intake** — parses natural-language RFQ messages from WhatsApp into structured opportunities (via OpenAI) and creates them in Twenty CRM.
2. **Sales compliance engine** — polls Twenty into a local Postgres mirror, computes per-deal SLA clocks, and emails SLA-graded briefings on a schedule.

There is no in-process scheduler. Supabase **`pg_cron` + `pg_net`** POST to HTTP endpoints on this service; Postgres is the clock, the app is the worker. Every scheduled endpoint is guarded by an `X-Auth` shared secret.

## Architecture

```
WhatsApp → Twilio → whatsapp-logistics-bot ──── POST /rfq ─────▶ this service
                                                                      │ creates
                                                                      ▼
                                                                  Twenty CRM
                                                                      │
                                        ┌─────────────────────────────┘
                                        │ snapshots refreshed every 10 min
                                        │ + nightly full reconcile
                                        ▼
                                POST /sync ──▶ opportunities mirror
                                               crm_records (raw notes/tasks)
                                               stage_transitions
                                               sync_checkpoints
                                               (Supabase Postgres)
                                                      │
                        ┌─────────────────────────────┼──────────────────────────┐
                        │ 07:30 IST                   │ 08:00 IST                │ on trigger
                        ▼                             ▼                          ▼
             POST /morning-briefing       POST /admin-briefing      POST /closure-checklist
                        └─────────────────────────────┴──────────────────────────┘
                                                      ▼
                                                Resend → email
```

Twenty webhooks are **not** used. They were retired in favour of polling: a webhook fires on the opportunity object only, so adding a note or task never signalled activity, and our own API writebacks fired spurious events. See "The meaningful-update clock" below.

## Repository layout

```
src/
  server.js            Entry point
  app.js               Express config (CORS, JSON, routes)
  routes/              One router per endpoint; scheduled ones mount requireSecret()
  controllers/         Thin request handlers
  services/
    rfq.service.js               OpenAI RFQ parsing + assignee inference
    twenty.service.js            Twenty REST: create opportunity, paginated list-since
    sync.service.js              Production Prisma/Twenty wiring
    sync-engine.js               Snapshot mirror + meaningful-update clock (see below)
    morning-briefing.service.js  Mail 1 — per-salesperson SLA briefing
    admin-briefing.service.js    Mail 2 — team hygiene + escalations
    closure-checklist.service.js Mail 4 — site-visit-success checklist
    email.service.js             Resend send (first recipient To:, rest Cc:)
    users.service.js             Phone → VerifiedNumber lookup
  lib/
    sla.js             SINGLE SOURCE OF TRUTH: SLA thresholds, stage config, colours, formatters
    recipients.js      Who receives which mail, from the VerifiedNumber roster
    require-secret.js  X-Auth shared-secret guard
    prisma.js          Prisma client singleton
prisma/
  schema.prisma        Introspected from the SHARED Supabase DB — most models belong to
                       other WareOnGo systems. Ours: Opportunity, StageTransition,
                       SyncCheckpoint, CrmRecord (+ VerifiedNumber, shared).
migrations/            Versioned, additive CRM-only SQL migrations
test/                  Sync retry/storage/pagination regressions (npm test)
sql/                   (gitignored) Local copy of the SQL run against Supabase
frontend/              Static HTML/JS form for manual RFQ submission
```

## The meaningful-update clock

The core of `sync.service.js`, and the reason it exists: **Twenty's `updatedAt` is not a usable activity signal.**

- Adding a note or task does *not* bump the opportunity's `updatedAt` — they're separate objects. So notes and tasks are polled as their own streams and linked back via `targetOpportunityId`.
- Our own API writebacks *do* bump it. Twenty tags every change with `updatedBy.source` = `MANUAL` | `API`; only `MANUAL` counts.
- Only an allowlist of ~25 business fields counts as a change (`QUALIFYING_OPP_FIELDS`). Reassignment is deliberately excluded — it isn't sales activity on the deal.

The result is `last_meaningful_update_at`, which everything downstream grades against. Supporting machinery: per-stream successful watermarks in `sync_checkpoints`, an append-only `stage_transitions` log for time-in-stage TAT, a cross-instance mutex (a `sync_checkpoints` row with a 20-min TTL — session-scoped advisory locks don't survive pgBouncer), and a soft-delete safety valve that refuses to remove more than max(50 records, 20% of the mirror) in one run.

## Raw CRM mirror and recovery

Each ten-minute run reads complete, paginated `depth=1` snapshots of opportunities,
notes and tasks. Related objects and new custom fields can change without a parent
`updatedAt` bump, so watermarks are health/progress metadata rather than fetch filters.
This intentionally uses more Twenty reads than the previous delta-only approach.

- `opportunities.data` retains **every field returned by REST**, including position,
  searchVector, timelineActivities, favorites and new custom fields when returned.
- `crm_records` stores complete note/task JSONB, native timestamps, deletion state and
  `opportunity_ids` for joins. Notes linked only to a company/person are retained too.
  `last_note_text` remains a 2,000-character display excerpt; raw note bodies are uncut.
- Every failed write prevents that stream's watermark advancing. Partial runs return
  HTTP 503, with per-stream counts; malformed pages, repeated cursors/IDs, timeouts and
  page caps fail closed. Other streams can still make progress.
- `full=true` additionally reconciles deletions after a successful complete fetch.
  Existing raw snapshots are retained with `deleted_at` set; empty/truncated-looking
  results trip the deletion guard. Missing parents are retried on every cycle.

This is a current REST mirror, not a historical backup of the entire Twenty workspace:
standalone people/companies and attachment bytes are not separate streams, and records
already deleted before ingestion cannot be reconstructed. Stage history records moves
observed by the poller, not a complete pre-sync audit trail.

Before deploying this change to the worker, run the additive migration against the
configured Supabase connection (do **not** run `prisma db push` on this shared database):

```bash
npm test
npm run sync:migrate
```

After the worker is deployed, backfill all current snapshots with:

```bash
npm run sync:backfill
```

Both scripts use the existing `.env`; they print counts/status only and do not send
briefings or change records in Twenty. The backfill shares the scheduled worker's
mutex and exits unsuccessfully if another run owns it. Run it again after that run
finishes. The migration is additive/idempotent and keeps the raw table private with
RLS and no public/API-role grants. Analyst access belongs on separately masked views.

## Scheduled jobs

Defined in `sql/pg_cron_cutover.sql`, running in Supabase:

| Job | Schedule (IST) | Endpoint |
|---|---|---|
| `crm-sync-delta` | every 10 min | `POST /sync` |
| `crm-sync-full` | 01:30 nightly | `POST /sync` `{"full":true}` |
| `crm-morning-briefing` | 07:30 | `POST /morning-briefing` |
| `crm-admin-briefing` | 08:00 | `POST /admin-briefing` |

`/closure-checklist` is trigger-based, not scheduled. Its safety-net scan is written but commented out — it depends on a Twenty field that doesn't exist yet (see Known gaps).

All four mail/sync endpoints accept `{"dryRunEmail": "you@wareongo.com"}` to redirect all output to one inbox.

## SLA rules

From `lib/sla.js` — change them there and nowhere else. Days in stage: `<= greenMax` GREEN, `<= yellowMax` YELLOW, else RED.

| Stage | Green | Yellow |
|---|---|---|
| New Lead | 1d | 2d |
| RFQ Received | 1d | 2d |
| Proposal Shared | 3d | 5d |
| Follow-ups | 3d | 5d |
| Site Visit | 1d | 3d |

Negotiation / Agreement Work / Money Collection have no SLA timer yet and render as a plain table. `RFQ_NOT_RELEVANT`, `DEAL_LOST`, `DEAL_CLOSED` and `DEAL_ON_HOLD` are excluded from active tracking entirely.

Deal ownership is **assignee-based** (`assignedTo`), with the owner/creator used only as a fallback when nobody is assigned — so creating a deal doesn't drop it into your briefing. Everyone resolves through the `VerifiedNumber` roster to one canonical lowercased email, so owner, creator and assignee collapse to the same person and never double-count.

## Setup

### Prerequisites

- Node.js v22+
- OpenAI API key
- Twenty CRM instance with API key
- Supabase project (PostgreSQL + `pg_cron` + `pg_net`)
- Resend API key

### Install

```bash
npm install
npx prisma generate
```

### Environment variables

Create a `.env` in the project root. See `.env.example` for the full list.

| Variable | Required | Notes |
|---|---|---|
| `PORT` | no | defaults to 3000 |
| `DATABASE_URL` | yes | Supabase Postgres URL |
| `OPENAI_API_KEY` | yes | for RFQ parsing |
| `RFQ_MODEL` | no | defaults to `gpt-4o` |
| `TWENTY_CRM_BASE_URL` | yes | e.g. `https://crm.wareongo.com` |
| `TWENTY_CRM_API_KEY` | yes | Twenty API key (long-lived JWT) |
| `RESEND_API_KEY` | yes | for briefing emails |
| `RESEND_FROM` | no | defaults to Resend's sandbox sender |
| `ASSIGNABLE_USERS` | yes | Comma-separated Twenty `assignedTo` enum values (uppercased first names). Validates names extracted from RFQ messages. Update + restart when the team changes. |
| `REMINDER_SECRET` | yes | Shared secret for the `X-Auth` header on every scheduled endpoint. Must match the value in `sql/pg_cron_*.sql`. Named for the retired reminder system; kept because renaming means changing the prod `.env` and every SQL job at once. |

### Run

```bash
npm run dev    # development with file watch
npm start      # production
```

## Deployment

Single AWS EC2 instance in `ap-south-1`, behind Caddy on `:80`, managed by pm2. Auto-deploys via GitHub Actions on push to `main`.

See [DEPLOYMENT.md](DEPLOYMENT.md) for instance IDs, SSH, secrets and troubleshooting.

## API reference

See [API.md](API.md).

## Frontend

`frontend/` is a static HTML/JS form for manual RFQ submission. Open `frontend/index.html` directly. Toggle `API_URL` in `frontend/app.js` between localhost and the deployed host.

## Known gaps

- **`/rfq` is unauthenticated** and the box is on a public IP over plain HTTP. It burns OpenAI quota and creates Twenty opportunities for anyone who finds it. Wants the same `X-Auth` guard the scheduled endpoints use, plus a rate limit.
- **Mail 2's "flagged for admin" section is always empty** — it depends on a `Flag for Admin` field that doesn't exist in Twenty yet. `collectFlagged()` reads a best-effort key and returns `[]`.
- **Mail 4 never fires on its own** — it depends on a site-visit-outcome field that doesn't exist in Twenty yet, so `scanClosureTriggers()` returns `[]` and its cron job is commented out. Sending for a specific deal by ID works today.
- **`sql/drop_legacy_reminder_columns.sql` is written but unrun.** The retired reminder columns still exist physically on `opportunities`; they're no longer modelled in `schema.prisma`.
- **`toMicros` falls through silently on decimals**, sending e.g. `"50000.50"` straight to Twenty for an opaque API error. The RFQ parser emits integers today, but nothing enforces it.
