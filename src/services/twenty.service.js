const MICROS_MULTIPLIER = 1_000_000n;

function toMicros(amountValue) {
  const normalizedAmount = String(amountValue).replace(/,/g, "").trim();

  if (!/^-?\d+$/.test(normalizedAmount)) {
    return amountValue;
  }

  return String(BigInt(normalizedAmount) * MICROS_MULTIPLIER);
}

export async function createOpportunityFromData(data) {
  const baseUrl = process.env.TWENTY_CRM_BASE_URL;
  const apiKey = process.env.TWENTY_CRM_API_KEY;

  const payload = { ...data };

  // Convert amount to micros
  if (payload.amount?.amountMicros != null) {
    payload.amount = { ...payload.amount, amountMicros: toMicros(payload.amount.amountMicros) };
  }

  // Strip empty assignedTo
  if (payload.assignedTo === "" || payload.assignedTo == null) {
    delete payload.assignedTo;
  }

  const response = await fetch(`${baseUrl}/rest/opportunities`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const body = await response.json();

  if (!response.ok) {
    const error = new Error(`Twenty CRM API error: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function updateOpportunity(id, patch) {
  const baseUrl = process.env.TWENTY_CRM_BASE_URL;
  const apiKey = process.env.TWENTY_CRM_API_KEY;

  const response = await fetch(`${baseUrl}/rest/opportunities/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(patch),
  });

  const body = await response.json();

  if (!response.ok) {
    const error = new Error(`Twenty CRM API error: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

export async function getOpportunity(id) {
  const baseUrl = process.env.TWENTY_CRM_BASE_URL;
  const apiKey = process.env.TWENTY_CRM_API_KEY;

  const response = await fetch(`${baseUrl}/rest/opportunities/${id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  const body = await response.json();

  if (!response.ok) {
    const error = new Error(`Twenty CRM API error: ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body?.data?.opportunity ?? null;
}

/**
 * List all records of a Twenty object changed since a timestamp, following
 * cursor pagination to completion. Used by the polling sync (sync.service.js).
 *
 * Records are returned oldest-changed first (`updatedAt` ascending) so the
 * caller can advance its watermark incrementally and resume safely after a
 * mid-run failure. Cursor pagination (`starting_after` + `pageInfo.endCursor`)
 * and the `updatedAt[gte]` filter are both verified against the live REST API.
 *
 * @param {string} object - plural object name: "opportunities" | "notes" | "tasks"
 * @param {object} [opts]
 * @param {string|null} [opts.sinceISO] - only records with updatedAt >= this ISO string; null = all
 * @param {number} [opts.depth] - Twenty relation depth (0 or 1)
 * @param {number} [opts.pageLimit] - page size (max 60)
 * @returns {Promise<object[]>}
 */
export async function listRecordsSince(object, { sinceISO = null, depth = 1, pageLimit = 60 } = {}) {
  const baseUrl = process.env.TWENTY_CRM_BASE_URL;
  const apiKey = process.env.TWENTY_CRM_API_KEY;
  const headers = { Authorization: `Bearer ${apiKey}` };

  const filter = sinceISO ? `&filter=updatedAt[gte]:${encodeURIComponent(sinceISO)}` : "";
  const out = [];
  let cursor = null;

  // Per-page network timeout. Without this a hung Twenty request would block the
  // poller indefinitely and (via the controller's in-flight guard) wedge every
  // future sync run.
  const PAGE_TIMEOUT_MS = 30_000;

  // Hard cap on page count as a runaway guard (60 * 5000 = 300k records).
  for (let page = 0; page < 5000; page++) {
    const after = cursor ? `&starting_after=${encodeURIComponent(cursor)}` : "";
    const url =
      `${baseUrl}/rest/${object}?order_by=updatedAt[AscNullsFirst]` +
      `&limit=${pageLimit}&depth=${depth}${filter}${after}`;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PAGE_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { headers, signal: ac.signal });
    } catch (err) {
      throw new Error(`Twenty list ${object} fetch failed (page ${page}): ${err.name === "AbortError" ? `timeout after ${PAGE_TIMEOUT_MS}ms` : err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const body = await response.json();

    if (!response.ok) {
      const error = new Error(`Twenty CRM list ${object} error: ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    const batch = body?.data?.[object] ?? [];
    out.push(...batch);

    const pageInfo = body?.pageInfo;
    if (!pageInfo?.hasNextPage || batch.length === 0) break;
    cursor = pageInfo.endCursor;
  }

  return out;
}
