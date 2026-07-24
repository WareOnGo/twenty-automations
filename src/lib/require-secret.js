// Shared X-Auth shared-secret guard for pg_cron-triggered endpoints. pg_cron
// sends the secret in the X-Auth header (see sql/*.sql). Defaults to
// REMINDER_SECRET so no new prod config is required; pass a different env var
// name to use a dedicated secret.
export function requireSecret(envVar = "REMINDER_SECRET") {
  return (req, res, next) => {
    const expected = process.env[envVar];
    if (!expected) {
      console.error(`[auth] ${envVar} not set — refusing all requests`);
      return res.status(503).json({ error: "Server not configured" });
    }
    if (req.header("x-auth") !== expected) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };
}
