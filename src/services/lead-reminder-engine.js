import { randomUUID } from "node:crypto";
import { isNewLead, reconcileLead, dueNotifications, rosterResolver, assigneeKeys } from "../lib/lead-reminder-policy.js";
import { buildReminderMessage } from "../lib/lead-reminder-messages.js";

const TERMINAL = new Set(["SENT", "EXPIRED", "FAILED", "UNCERTAIN"]);

export function createReminderEngine({ repository, source, transport, config, clock = () => new Date() }) {
  return async function run({ preview = true } = {}) {
    if (!config.enabled && !preview) return { status: "disabled", preview };
    const now = clock();
    if (!(await source.healthy(now))) return { status: "source_unavailable", preview };
    await repository.checkCutoff(config.cutoff);
    const token = randomUUID();
    if (!preview && !(await repository.claim(config.cutoff, token))) return { status: "locked", preview };
    const result = { status: "ok", preview, examined: 0, queued: 0, alreadyRecorded: 0,
      routingIssues: 0, failures: 0, deliveryFailures: 0, notifications: [] };
    try {
      let roster = rosterResolver(await source.roster(), config);
      result.routingIssues += config.escalationIds.filter(id => !roster.canNotify(roster.byId.get(id), true)).length;
      for await (const page of source.pages(config.cutoff, now)) {
        for (const snapshot of page) {
          if (!preview) await repository.renew(token);
          let record = snapshot.data;
          if (!isNewLead(record, config) || Date.parse(record.createdAt) > +now) continue;
          result.examined++;
          try {
            assigneeKeys(record);
            if (!snapshot.lastPolledAt || !Number.isFinite(+new Date(snapshot.lastPolledAt)) ||
                +new Date(snapshot.lastPolledAt) > +now) throw new Error("INVALID_OBSERVATION_TIME");
          } catch { result.failures++; continue; }
          const previous = await repository.state(record.id);
          const observedAt = new Date(snapshot.lastPolledAt).toISOString();
          // A live check can be newer even at equal timestamp precision. Never
          // turn a cached assignment back into a new episode or reset its clock.
          const needsLiveSnapshot = previous?.observedAt && Date.parse(previous.observedAt) >= Date.parse(observedAt);
          let state = needsLiveSnapshot ? previous : reconcileLead(previous, record, roster, config, observedAt);
          let notifications = needsLiveSnapshot ? [] : dueNotifications(state, record, roster, config, now);
          if (needsLiveSnapshot || notifications.length) {
            // Live recheck prevents a known stale mirror from sending a closed/reassigned lead.
            // A concurrent change after this read remains possible; outbound expiry is short.
            try {
              const live = await source.current(record.id);
              record = live || { ...record, deletedAt: now.toISOString() };
              if (record.id !== snapshot.data.id || !isNewLead(record, config) || Date.parse(record.createdAt) > +clock()) {
                record = { ...snapshot.data, deletedAt: now.toISOString() };
              }
              roster = rosterResolver(await source.roster(), config);
              state = reconcileLead(state, record, roster, config, clock().toISOString());
              notifications = dueNotifications(state, record, roster, config, clock());
            } catch {
              // Persist observed assignments even if the live check fails. An outage never resets T0.
              if (!preview) await repository.save(token, snapshot.data, state);
              result.failures++;
              continue;
            }
          }
          const keys = assigneeKeys(record);
          result.routingIssues += keys.filter(k => {
            const person = roster.assignee(k);
            const assignment = state.assignments.find(a => a.key === k && !a.removedAt);
            return !person || (config.betaIds.includes(person.id) && !roster.canNotify(person)) ||
              (assignment?.admitted && !assignment.finished && assignment.employeeId !== person.id);
          }).length;
          if (!keys.length) {
            const owner = roster.owner(record);
            if (!owner || (config.betaIds.includes(owner.id) && !roster.canNotify(owner))) result.routingIssues++;
          }
          if (!preview) {
            await repository.save(token, snapshot.data, state);
            await repository.supersede(token, record.id, notifications.map(n => n.id));
          }
          for (const n of notifications) {
            const text = buildReminderMessage(record, n, config);
            if (text.length > 4000) { result.failures++; continue; }
            if (preview) {
              const existing = await repository.notification(n.id);
              result.notifications.push({ opportunityId: record.id, recipientId: n.recipient.id,
                step: n.step, status: existing?.status || "would_enqueue", text: existing?.payload?.text ?? text });
              continue;
            }
            const row = await repository.prepare(token, record, n,
              { to: n.recipient.phone_number, text, expiresInSeconds: 900 });
            if (row.status !== "prepared") {
              result.alreadyRecorded++;
              if (row.reason === "RETRY_WINDOW_EXPIRED") result.deliveryFailures++;
              continue;
            }
            // Frozen payload + same occurrence key on every retry, including after an ambiguous POST.
            if (row.payload.to !== n.recipient.phone_number) {
              await repository.outcome(token, n.id, { status: "superseded", reason: "RECIPIENT_CHANGED" });
              result.routingIssues++;
              continue;
            }
            try {
              await repository.renew(token);
              const sent = await transport.enqueue(n.id, row.payload);
              await repository.outcome(token, n.id, { status: "accepted", messageId: sent.messageId,
                providerState: "READY_TO_SEND" });
              result.queued++;
            } catch (error) {
              result.failures++;
              if ([400, 409, 413, 415, 422].includes(error.status)) {
                await repository.outcome(token, n.id, { status: "terminal", reason: "REQUEST_REJECTED" });
              }
              if ([401, 403].includes(error.status)) throw new Error("REMINDER_TRANSPORT_AUTH_FAILED");
            }
          }
        }
      }
      if (!preview) {
        for (const row of await repository.pendingStatuses()) {
          await repository.renew(token);
          try {
            const status = await transport.status(row.message_id);
            await repository.outcome(token, row.id, { status: TERMINAL.has(status.state) ? "terminal" : "accepted",
              providerState: status.state });
            if (["EXPIRED", "FAILED", "UNCERTAIN"].includes(status.state)) result.deliveryFailures++;
          } catch { result.failures++; }
        }
      }
      if (result.failures || result.deliveryFailures || result.routingIssues) result.status = "partial";
      return result;
    } finally {
      if (!preview) await repository.release(token);
    }
  };
}
