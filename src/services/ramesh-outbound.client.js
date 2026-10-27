const STATES = new Set(["READY_TO_SEND", "SENDING", "SENT", "EXPIRED", "FAILED", "UNCERTAIN"]);
const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function createRameshClient({ apiUrl, apiKey, fetchImpl = globalThis.fetch }) {
  async function request(path, options = {}) {
    try {
      const response = await fetchImpl(apiUrl + path, {
        ...options, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "X-Ramesh-Api-Key": apiKey, ...options.headers },
      });
      if (!response.ok) {
        const error = new Error("RAMESH_HTTP_" + response.status);
        error.status = response.status;
        throw error;
      }
      const body = await response.text();
      if (body.length > 8192) throw new Error("RAMESH_INVALID_RESPONSE");
      return JSON.parse(body);
    } catch (error) {
      if (/^RAMESH_HTTP_\d+$/.test(error.message)) throw error;
      // Never propagate provider bodies, URLs, credentials or recipient data.
      throw new Error("RAMESH_REQUEST_UNCERTAIN");
    }
  }
  return {
    async enqueue(id, payload) {
      const result = await request("/v1/outbound-messages", { method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "crm-beta-" + id },
        body: JSON.stringify(payload) });
      if (!ID.test(result.messageId) || !["queued", "duplicate"].includes(result.status)) {
        throw new Error("RAMESH_INVALID_RESPONSE");
      }
      return result;
    },
    async status(id) {
      if (!ID.test(id)) throw new Error("RAMESH_INVALID_MESSAGE_ID");
      const result = await request("/v1/outbound-messages/" + id);
      if (result.messageId !== id || !STATES.has(result.state)) throw new Error("RAMESH_INVALID_RESPONSE");
      return result;
    },
  };
}
