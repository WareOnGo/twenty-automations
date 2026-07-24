import { upsertOpportunity } from "../services/webhook.service.js";

// Twenty CRM posts JSON bodies but with Content-Type: application/x-www-form-urlencoded
// (upstream bug). On top of that it pretty-prints the JSON, so multi-line string values
// (e.g. an opportunity's description) contain literal LF/CR/TAB that strict JSON rejects.
//
// app.js mounts express.text({ type: "*/*" }) on this route, so req.body is the raw
// request string. We sanitize the control chars and JSON.parse it directly — this
// sidesteps the urlencoded parser entirely, which previously broke whenever a field
// contained '&' or '=' (split into multiple form keys) or a newline (parse failure).

// Escape literal control chars that appear unescaped inside JSON string literals.
// Tracks string state so control chars between tokens (insignificant whitespace)
// are left alone.
function sanitizeJsonControls(s) {
  let out = "";
  let inStr = false;
  let escape = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      out += c;
      escape = false;
      continue;
    }
    if (c === "\\" && inStr) {
      out += c;
      escape = true;
      continue;
    }
    if (c === '"') {
      out += c;
      inStr = !inStr;
      continue;
    }
    if (inStr) {
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    }
    out += c;
  }
  return out;
}

// Parse the raw webhook body into an object. Throws on malformed input so the
// caller can log the raw payload rather than silently dropping it.
//
// Twenty sends the JSON as an application/x-www-form-urlencoded payload, which
// arrives percent-encoded (e.g. "%7B%0A++%22id%22..." with '+' for spaces and a
// trailing '='). Decode that form-encoding first. Some payloads arrive as literal
// JSON instead — those start with '{' and are parsed directly. In both cases the
// JSON may contain literal control chars (pretty-printed multi-line strings), so
// sanitize before JSON.parse.
function parseWebhookBody(raw) {
  // Defensive: if some upstream parser already produced an object, use it as-is.
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("empty or non-string body");
  }
  let s = raw.trim();
  if (!s.startsWith("{")) {
    // Percent-encoded form payload: the JSON is the (only) form key. URLSearchParams
    // handles '+'→space and %XX decoding. Internal '&'/'=' are encoded, so no split.
    const key = new URLSearchParams(s).keys().next().value;
    if (key) s = key.trim();
  }
  return JSON.parse(sanitizeJsonControls(s));
}

// REVOKED (dual-writer cutover): the polling sync (sync.service.js) is now the
// sole writer of the opportunities mirror. Processing this webhook would (a)
// overwrite the REST-shaped snapshot with a different webhook shape and (b) push
// followupcount back to Twenty as an API-sourced edit — both of which corrupt
// the poller's meaningful-update detection. Disabled by default; re-enable ONLY
// by setting WEBHOOK_TWENTY_ENABLED=true if rolling back to the webhook model.
const WEBHOOK_ENABLED = process.env.WEBHOOK_TWENTY_ENABLED === "true";

export async function handleTwentyWebhook(req, res) {
  // Respond immediately — never make Twenty wait (also avoids retry storms).
  res.status(200).json({ received: true, processed: WEBHOOK_ENABLED });

  if (!WEBHOOK_ENABLED) {
    console.log("[webhook] disabled (WEBHOOK_TWENTY_ENABLED!=true) — acked, not processed");
    return;
  }

  let body;
  try {
    body = parseWebhookBody(req.body);
  } catch (err) {
    const raw = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    console.error(`[webhook] Failed to parse body: ${err.message} — raw=${raw}`);
    return;
  }

  // Fire-and-forget: upsert in background
  try {
    await upsertOpportunity(body);
  } catch (err) {
    console.error("[webhook] Failed to upsert opportunity:", err.message);
  }
}
