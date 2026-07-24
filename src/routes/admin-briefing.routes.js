import { Router } from "express";
import { adminBriefing } from "../controllers/admin-briefing.controller.js";
import { requireSecret } from "../lib/require-secret.js";

const router = Router();
router.use(requireSecret());
router.post("/", adminBriefing);

export default router;
