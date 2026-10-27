// All mutations fence against the current run lease. Raw SQL allows additive rollout
// without replacing the Prisma client used by other services on the shared database.
export function createReminderRepository(db) {
  async function renew(tx, token) {
    const count = await tx.$executeRaw`
      UPDATE public.crm_reminder_rollout SET lease_until=now()+interval '60 seconds'
      WHERE id='assignment-beta-v1' AND lease_token=${token}::uuid AND lease_until>now()`;
    if (count !== 1) throw new Error("REMINDER_LEASE_LOST");
  }
  const fenced = (token, fn) => db.$transaction(async tx => { await renew(tx, token); return fn(tx); });
  return {
    async claim(cutoff, token) {
      return db.$transaction(async tx => {
        await tx.$executeRaw`
          INSERT INTO public.crm_reminder_rollout(id,new_leads_from)
          VALUES ('assignment-beta-v1',${new Date(cutoff)}) ON CONFLICT DO NOTHING`;
        const [policy] = await tx.$queryRaw`
          SELECT new_leads_from FROM public.crm_reminder_rollout WHERE id='assignment-beta-v1'`;
        if (+policy.new_leads_from !== +new Date(cutoff)) throw new Error("REMINDER_CUTOFF_CHANGED");
        const rows = await tx.$queryRaw`
          UPDATE public.crm_reminder_rollout SET lease_token=${token}::uuid,lease_until=now()+interval '60 seconds'
          WHERE id='assignment-beta-v1' AND (lease_until IS NULL OR lease_until<=now()) RETURNING id`;
        return rows.length === 1;
      });
    },
    async checkCutoff(cutoff) {
      const rows = await db.$queryRaw`
        SELECT new_leads_from FROM public.crm_reminder_rollout WHERE id='assignment-beta-v1'`;
      if (rows.length && +rows[0].new_leads_from !== +new Date(cutoff)) throw new Error("REMINDER_CUTOFF_CHANGED");
    },
    renew(token) { return renew(db, token); },
    async release(token) {
      await db.$executeRaw`
        UPDATE public.crm_reminder_rollout SET lease_token=NULL,lease_until=NULL
        WHERE id='assignment-beta-v1' AND lease_token=${token}::uuid`;
    },
    async state(id) {
      const rows = await db.$queryRaw`
        SELECT state FROM public.crm_lead_reminder_state WHERE opportunity_id=${id}`;
      return rows[0]?.state || null;
    },
    save(token, record, state) {
      return fenced(token, tx => tx.$executeRaw`
        INSERT INTO public.crm_lead_reminder_state(opportunity_id,source_created_at,state)
        VALUES (${record.id},${new Date(record.createdAt)},${JSON.stringify(state)}::jsonb)
        ON CONFLICT(opportunity_id) DO UPDATE SET state=EXCLUDED.state,updated_at=now()`);
    },
    prepare(token, record, n, payload) {
      return fenced(token, async tx => {
        // Quiet hours or unavailable routing can temporarily make an intent not
        // due. Resume only that intent, keeping its original payload and age.
        await tx.$executeRaw`
          INSERT INTO public.crm_lead_reminder_outbox(id,opportunity_id,recipient_id,step,payload)
          VALUES (${n.id}::uuid,${record.id},${n.recipient.id},${n.step},${JSON.stringify(payload)}::jsonb)
          ON CONFLICT (id) DO UPDATE SET status='prepared',reason=NULL,updated_at=now()
          WHERE crm_lead_reminder_outbox.status='superseded'
            AND crm_lead_reminder_outbox.reason='NO_LONGER_DUE'`;
        // Bound ambiguous retries well inside Ramesh's 30-day idempotency retention.
        // A recovered worker must not resend an old case after the provider forgets its key.
        await tx.$executeRaw`
          UPDATE public.crm_lead_reminder_outbox SET status='terminal',reason='RETRY_WINDOW_EXPIRED',updated_at=now()
          WHERE id=${n.id}::uuid AND status='prepared' AND created_at<now()-interval '24 hours'`;
        const [row] = await tx.$queryRaw`SELECT * FROM public.crm_lead_reminder_outbox WHERE id=${n.id}::uuid`;
        return row;
      });
    },
    async notification(id) {
      const rows = await db.$queryRaw`SELECT * FROM public.crm_lead_reminder_outbox WHERE id=${id}::uuid`;
      return rows[0] || null;
    },
    supersede(token, leadId, currentIds) {
      return fenced(token, tx => tx.$executeRaw`
        UPDATE public.crm_lead_reminder_outbox SET status='superseded',reason='NO_LONGER_DUE',updated_at=now()
        WHERE opportunity_id=${leadId} AND status='prepared' AND id::text NOT IN
          (SELECT jsonb_array_elements_text(${JSON.stringify(currentIds)}::jsonb))`);
    },
    outcome(token, id, { status, messageId = null, providerState = null, reason = null }) {
      return fenced(token, tx => tx.$executeRaw`
        UPDATE public.crm_lead_reminder_outbox SET status=${status},
          message_id=COALESCE(${messageId}::uuid,message_id),provider_state=${providerState},
          reason=${reason},updated_at=now() WHERE id=${id}::uuid`);
    },
    pendingStatuses() {
      return db.$queryRaw`
        SELECT id,message_id FROM public.crm_lead_reminder_outbox
        WHERE status='accepted' ORDER BY updated_at LIMIT 100`;
    },
  };
}
