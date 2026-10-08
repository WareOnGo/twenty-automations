import prisma from "../lib/prisma.js";
import { listRecordsSince } from "./twenty.service.js";
import { createSyncEngine } from "./sync-engine.js";

export const { runSync } = createSyncEngine({ prisma, listRecordsSince });
