import { Router } from "express";
import { triggerSync } from "../controllers/sync.controller.js";
import { requireSecret } from "../lib/require-secret.js";

const router = Router();
router.use(requireSecret());
router.post("/", triggerSync);

export default router;
