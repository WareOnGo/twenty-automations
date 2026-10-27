export function createReminderSource(db, { fetchImpl = globalThis.fetch, env = process.env } = {}) {
  return {
    async healthy(now) {
      const checkpoint = await db.syncCheckpoint.findUnique({ where: { object: "opportunities" } });
      const lock = await db.syncCheckpoint.findUnique({ where: { object: "__sync_lock__" } });
      const age = +now - +new Date(checkpoint?.lastRunAt || 0);
      return checkpoint?.lastRunStatus === "ok" && age >= 0 && age <= 20 * 60_000 &&
        !(lock?.lastRunStatus === "locked" && +now - +new Date(lock.lastRunAt) < 20 * 60_000);
    },
    roster() {
      return db.verifiedNumber.findMany({ select: { id: true, name: true, is_active: true,
        phone_number: true, twenty_user_id: true } });
    },
    async *pages(cutoff, now) {
      let cursor;
      while (true) {
        const rows = await db.opportunity.findMany({
          where: { twentyCreatedAt: { gte: new Date(cutoff), lte: now } },
          orderBy: { opportunityId: "asc" }, take: 60,
          ...(cursor ? { cursor: { opportunityId: cursor }, skip: 1 } : {}),
          select: { opportunityId: true, data: true, lastPolledAt: true, deletedAt: true },
        });
        if (!rows.length) return;
        yield rows.filter(row => row.lastPolledAt && +now >= +row.lastPolledAt && +now - +row.lastPolledAt <= 20 * 60_000)
          .map(row => ({ ...row, data: { ...row.data, deletedAt: row.deletedAt || row.data.deletedAt } }));
        cursor = rows.at(-1).opportunityId;
      }
    },
    async current(id) {
      if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)) throw new Error("INVALID_LEAD_ID");
      if (!env.TWENTY_CRM_API_KEY) throw new Error("MISSING_TWENTY_KEY");
      const url = new URL("/rest/opportunities/" + encodeURIComponent(id), env.TWENTY_CRM_BASE_URL);
      url.searchParams.set("depth", "1");
      try {
        const response = await fetchImpl(url, { headers: { Authorization: "Bearer " + env.TWENTY_CRM_API_KEY },
          redirect: "error", signal: AbortSignal.timeout(10_000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("SOURCE_READ_FAILED");
        const raw = await response.text();
        if (raw.length > 524288) throw new Error("SOURCE_READ_FAILED");
        const record = JSON.parse(raw)?.data?.opportunity;
        if (!record || record.id !== id || typeof record.stage !== "string") throw new Error("SOURCE_READ_FAILED");
        return record;
      } catch { throw new Error("SOURCE_READ_FAILED"); }
    },
  };
}
