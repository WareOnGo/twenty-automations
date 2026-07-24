import { Router } from "express";
import { closureChecklist } from "../controllers/closure-checklist.controller.js";
import { requireSecret } from "../lib/require-secret.js";

const router = Router();
router.use(requireSecret());
router.post("/", closureChecklist);

export default router;
