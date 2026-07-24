import { Router } from "express";
import { sendMorningBriefing } from "../controllers/morning-briefing.controller.js";
import { requireSecret } from "../lib/require-secret.js";

const router = Router();
router.use(requireSecret());
router.post("/", sendMorningBriefing);

export default router;
