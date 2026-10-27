import prisma from "../lib/prisma.js";
import { reminderConfig } from "../lib/lead-reminder-policy.js";
import { createReminderRepository } from "./lead-reminder.repository.js";
import { createReminderSource } from "./lead-reminder-source.js";
import { createRameshClient } from "./ramesh-outbound.client.js";
import { createReminderEngine } from "./lead-reminder-engine.js";

export async function runLeadReminders(options = {}) {
  const preview = options.preview !== false;
  const config = reminderConfig(process.env, { forPreview: preview });
  if (!config.enabled && !preview) return { status: "disabled", preview };
  return createReminderEngine({ config, repository: createReminderRepository(prisma),
    source: createReminderSource(prisma), transport: createRameshClient(config) })(options);
}
