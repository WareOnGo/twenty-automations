import { Router } from "express";
import healthRoutes from "./health.routes.js";
import rfqRoutes from "./rfq.routes.js";
import syncRoutes from "./sync.routes.js";
import morningBriefingRoutes from "./morning-briefing.routes.js";
import adminBriefingRoutes from "./admin-briefing.routes.js";
import closureChecklistRoutes from "./closure-checklist.routes.js";

const router = Router();

router.use("/health", healthRoutes);
router.use("/rfq", rfqRoutes);
router.use("/sync", syncRoutes);
router.use("/morning-briefing", morningBriefingRoutes);
router.use("/admin-briefing", adminBriefingRoutes);
router.use("/closure-checklist", closureChecklistRoutes);

export default router;
