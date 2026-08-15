# API Reference

**Public base URL:** `http://ec2-13-206-110-74.ap-south-1.compute.amazonaws.com` (subject to change on instance restart — see DEPLOYMENT.md)

All endpoints accept and return JSON.

Six endpoints, in two groups:

| Endpoint | Auth | Caller |
|---|---|---|
| `GET /health` | none | deploy health check, uptime probes |
| `POST /rfq` | none *(gap — see README)* | whatsapp-logistics-bot, `frontend/` |
| `POST /sync` | `X-Auth` | pg_cron (`crm-sync-delta`, `crm-sync-full`) |
| `POST /morning-briefing` | `X-Auth` | pg_cron (`crm-morning-briefing`) |
| `POST /admin-briefing` | `X-Auth` | pg_cron (`crm-admin-briefing`) |
| `POST /closure-checklist` | `X-Auth` | manual / trigger |

## Authentication

The four scheduled endpoints require an `X-Auth` header matching `REMINDER_SECRET` in the service env.

| Response | Meaning |
|---|---|
| `401 {"error":"Unauthorized"}` | header missing or wrong |
| `503 {"error":"Server not configured"}` | `REMINDER_SECRET` unset on the server — all requests refused |

---

## `GET /health`

Liveness probe.

**Response** `200 OK`

```json
{ "status": "ok", "timestamp": "2026-08-15T10:30:00.000Z" }
```

---

## `POST /rfq`

Parses a natural-language RFQ message into a structured opportunity and creates it in Twenty CRM. The opportunity is attributed to the WhatsApp sender when known, and assignees are set when the message explicitly asks for them.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `rfq` | string | Yes | The raw RFQ message text |
| `senderNumber` | string | No | E.164 phone of the WhatsApp sender (e.g. `+918076708542`). When matched against `VerifiedNumber`, the created opportunity's `createdBy` is set to that workspace member. Falls back to the API key creator when unmatched. |

**Example request**

```json
{
  "rfq": "Need 5000 sqft warehouse in Bangalore. assign to jayanth",
  "senderNumber": "+918076708542"
}
```

**Response** `201 Created`

```json
{
  "parsed": {
    "name": "TBD - 5,000 sqft - TBD, Bangalore",
    "stage": "RFQ_RECEIVED",
    "leadSource": "WHATSAPP_INBOUND",
    "duration": "LONG_TERM",
    "city": "Bangalore",
    "repeatClient": ["NO"],
    "description": "Need 5000 sqft warehouse in Bangalore. assign to jayanth",
    "assignedTo": ["JAYANTH"],
    "createdBy": {
      "source": "MANUAL",
      "workspaceMemberId": "f22c1ae4-2b4b-4408-bd9e-e7d4674cf011",
      "name": "Raghav"
    }
  },
  "crm": {
    "data": {
      "createOpportunity": { "id": "cc53ed26-3928-48f4-82ea-af406a122d07" }
    }
  }
}
```

### Parsed fields

| Field | Type | Description |
|---|---|---|
| `name` | string | `Company - Space - Area, City`. `TBD` for unknown parts. |
| `stage` | enum | Defaults to `RFQ_RECEIVED`. Set only when the message explicitly states one. |
| `leadSource` | enum | `GODAMWALE`, `BROKER`, or `WHATSAPP_INBOUND`. |
| `duration` | enum | `LONG_TERM` (default) or `SHORT_TERM` (only if explicitly < 1 year). |
| `city` | string | Omitted if not mentioned. |
| `repeatClient` | string[] | Twenty multi-select: `["OPTION1"]` for a repeat client, `["NO"]` otherwise. |
| `companyName` | string | Omitted if not mentioned. |
| `budget` | string | Per-sqft rate as a number string. Omitted if not mentioned. |
| `description` | string | Raw RFQ text verbatim. |
| `amount` | object | `{ amountMicros, currencyCode }`. Omitted unless total deal size is explicitly mentioned. Converted to micros before the Twenty call. |
| `pocName` | object | `{ firstName, lastName }`. Omitted if not mentioned. |
| `pocPhoneNumber` | object | `{ primaryPhoneNumber, primaryPhoneCallingCode, primaryPhoneCountryCode }`. Omitted if not mentioned. |
| `assignedTo` | string[] | Set only when the message explicitly asks ("assign to X", "X please handle"). Each value is a Twenty enum (uppercased first name), validated against `ASSIGNABLE_USERS`; unknown names are dropped silently. Field omitted entirely if there's no explicit assignment intent. |
| `createdBy` | object | Set only when `senderNumber` resolved against `VerifiedNumber`. Otherwise Twenty defaults to the API key. |

### Stage enum

The parser emits: `NEW_LEAD`, `RFQ_RECEIVED` *(default)*, `RFQ_NOT_RELEVANT`, `PROPOSAL_SHARED`, `FOLLOW_UP`.

Twenty's full set, which the mirror and briefings handle: the five above plus `SITE_VISIT`, `NEGOTIATION`, `AGREEMENT_WORK`, `MONEY_COLLECTION`, `DEAL_LOST`, `DEAL_CLOSED`, `DEAL_ON_HOLD`.

### `assignedTo` enum

Sourced from the `ASSIGNABLE_USERS` env var. Currently: `DHAVAL`, `JAYANTH`, `NIKESH`, `RANITA`, `MANEESH`, `ARNAV`, `MANOHARI`, `NIHAS`, `RAGHAV`.

---

## `POST /sync`

Runs one poll cycle against Twenty: mirrors opportunities, notes and tasks into Postgres, advances the meaningful-update clocks, and logs stage transitions. Called by pg_cron every 10 minutes (delta) and nightly (full).

Overlapping runs are prevented twice over — an in-process flag, and a DB-row mutex with a 20-minute TTL that also holds across app instances.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `full` | boolean | No | `true` ignores the stored watermarks, re-reads every record, and soft-deletes mirror rows that have vanished from Twenty. Defaults to `false` (delta since last watermark, minus a 2-minute overlap). Also accepted as `?full=true`. |

**Response** `200 OK`

```json
{
  "status": "ok",
  "full": false,
  "streams": {
    "opportunities": { "count": 3, "watermark": "2026-08-15T04:55:08.000Z", "failures": 0, "softDeleted": 0 },
    "notes":         { "count": 1, "watermark": "2026-08-15T04:51:22.000Z", "failures": 0 },
    "tasks":         { "count": 0, "watermark": null, "failures": 0 }
  },
  "durationMs": 1840
}
```

A stream that fails is reported inline as `{"error": "..."}` without aborting the others; its checkpoint records the error and its watermark is not advanced.

**Response** `202 Accepted` — a run is already in flight, this call was skipped.

```json
{ "status": "already_running" }
```

If the DB-level mutex is held instead, you get `200` with `{"skipped": true, "reason": "locked"}`.

---

## `POST /morning-briefing`

Mail 1. Builds and sends one personalised briefing per sales recipient — their own active deals, stages 1–5 as SLA-coloured cards, later stages as a table. Recipients with zero active deals are skipped, not mailed.

One recipient failing (build or send) is logged and does not abort the run.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `dryRunEmail` | string | No | Redirects **all** briefings to this one inbox. Use before any change to the mail. |

**Response** `200 OK`

```json
{ "status": "ok", "sent": 6, "skipped": 3, "recipients": 9 }
```

`202 {"status":"already_running"}` if a run is in flight.

---

## `POST /admin-briefing`

Mail 2. One digest to all admin recipients (`VerifiedNumber.adminAccess`, falling back to Jayanth + Dhaval if none are flagged). Part 1 is per-person CRM adoption — what share of each person's active deals saw a meaningful update yesterday (IST), worst first, RED at ≤50% and GREEN at ≥80%. Part 2 is RED SLA breaches across the team, plus deals flagged for admin.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `dryRunEmail` | string | No | Sends to this inbox instead of the admins. |

**Response** `200 OK`

```json
{
  "status": "ok",
  "recipients": 2,
  "breaches": 11,
  "flagged": 0,
  "rows": [{ "email": "x@wareongo.com", "name": "X", "total": 12, "updated": 4, "pct": 33, "color": "RED" }],
  "totalActive": 84,
  "updatedYesterday": 29
}
```

> `flagged` is currently always `0` — it depends on a "Flag for Admin" field that doesn't exist in Twenty yet.

---

## `POST /closure-checklist`

Mail 4. Sends a deal-closure checklist with countdown deadlines (internal negotiation 24h, client↔owner meeting 3d, move to Agreement Work 5d), measured from when the deal entered `SITE_VISIT`. Goes to the deal's assignees.

Two modes:

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `opportunityId` | string | one of | Send the checklist for this deal. |
| `scan` | boolean | one of | `true` finds every site-visit-success deal without a checklist already sent, and sends each. |
| `dryRunEmail` | string | No | Redirects mail to one inbox. On a dry run `closureSentAt` is **not** stamped, so a preview never suppresses the real send. |

A successful real send stamps `Opportunity.closureSentAt`, so `scan` never sends twice for the same deal.

**Response** `200 OK` — single deal:

```json
{ "status": "ok", "sent": true, "to": "raghav@wareongo.com" }
```

`{ "sent": false, "reason": "no recipient" }` when the deal has no assignee email.

**Response** `200 OK` — scan:

```json
{ "status": "ok", "scanned": 2, "results": [{ "id": "cc53ed26-…", "sent": true, "to": "…" }] }
```

> `scan` currently returns `0` — it depends on a site-visit-outcome field that doesn't exist in Twenty yet. Sending by `opportunityId` works today.

---

## Error responses

`400` — missing / malformed required field.

```json
{ "error": "Missing 'rfq' field in request body" }
```

`401` / `503` — see Authentication above.

`404` — `/closure-checklist` for an `opportunityId` not present in the mirror.

`5xx` — internal error (details logged server-side, not returned).

```json
{ "error": "Internal server error" }
```

Twenty upstream errors are forwarded with Twenty's status code. The controller logs Twenty's full rejection body; the client only gets:

```json
{ "error": "Twenty CRM API error: 400" }
```
