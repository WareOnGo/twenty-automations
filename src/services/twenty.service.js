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

/**
 * Yield one validated page at a time. Only IDs/cursors survive between pages;
 * consumers must finish the iterator before checkpointing or reconciling deletions.
 * A later malformed page or HTTP failure throws even after earlier pages were saved.
 */
export async function* listRecordPages(object, {
  sinceISO = null, depth = 1, pageLimit = 60,
  fetchImpl = globalThis.fetch, maxPages = 5000, pageTimeoutMs = 30_000,
} = {}) {
  const baseUrl = process.env.TWENTY_CRM_BASE_URL;
  const apiKey = process.env.TWENTY_CRM_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Twenty credentials are not configured");
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(object)) throw new Error("Invalid Twenty object");
  const headers = { Authorization: `Bearer ${apiKey}` };
  const seenIds = new Set();
  const seenCursors = new Set();
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/rest/${object}`);
    url.searchParams.set("order_by", "updatedAt[AscNullsFirst]");
    url.searchParams.set("limit", String(pageLimit));
    url.searchParams.set("depth", String(depth));
    if (sinceISO) url.searchParams.set("filter", `updatedAt[gte]:${sinceISO}`);
    if (cursor) url.searchParams.set("starting_after", cursor);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), pageTimeoutMs);
    let body;
    try {
      const response = await fetchImpl(url, { headers, signal: ac.signal });
      if (!response.ok) throw new Error(`Twenty list ${object}: HTTP ${response.status}`);
      // Keep the timeout active while reading/parsing the response body too.
      body = await response.json();
    } finally {
      clearTimeout(timer);
    }
    const batch = body?.data?.[object];
    const pageInfo = body?.pageInfo;
    if (!Array.isArray(batch) || typeof pageInfo?.hasNextPage !== "boolean") {
      throw new Error(`Twenty list ${object}: malformed page`);
    }
    if (batch.length > pageLimit) throw new Error(`Twenty list ${object}: oversized page`);
    for (const record of batch) {
      if (!record || typeof record.id !== "string" || !record.id ||
          !record.updatedAt || Number.isNaN(Date.parse(record.updatedAt))) {
        throw new Error(`Twenty list ${object}: invalid record`);
      }
      if (seenIds.has(record.id)) throw new Error(`Twenty list ${object}: duplicate record across pages`);
      seenIds.add(record.id);
    }
    if (pageInfo.hasNextPage && (!batch.length || typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor || seenCursors.has(pageInfo.endCursor))) {
      throw new Error(`Twenty list ${object}: incomplete pagination`);
    }
    yield batch;
    if (!pageInfo.hasNextPage) return;
    cursor = pageInfo.endCursor;
    seenCursors.add(cursor);
  }
  throw new Error(`Twenty list ${object}: page limit exceeded`);
}

// Compatibility for small callers that explicitly need one array. The mirror
// uses listRecordPages directly so it never retains complete source snapshots.
export async function listRecordsSince(object, options = {}) {
  const records = [];
  for await (const page of listRecordPages(object, options)) records.push(...page);
  return records;
}
