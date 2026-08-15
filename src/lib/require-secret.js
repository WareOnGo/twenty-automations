// Shared X-Auth shared-secret guard for the pg_cron-triggered endpoints
// (/sync, /morning-briefing, /admin-briefing, /closure-checklist). pg_cron sends
// the secret in the X-Auth header — see sql/pg_cron_*.sql. The env var is still
// named REMINDER_SECRET for historical reasons (renaming it means touching the
// prod .env and every SQL job at once); pass a different name for a dedicated
// secret.
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
