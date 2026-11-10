import { Router } from "express";
import auth, { authLoose } from "../../middlewares/auth";
const router = Router();
router.get("/crash", auth(), () => { throw new Error("planted crash"); });
router.get("/slow", auth(), async (_req, res) => { await new Promise((r) => setTimeout(r, 2300)); res.json({ success: true, data: {} }); });
// planted bug: role list is ignored by authLoose
router.get("/merchant-only", authLoose("MERCHANT"), (_req, res) => res.json({ success: true, data: { secret: "merchant data" } }));
// Always rate-limited, like a backend limiter hit by a load test
router.get("/limited", auth(), (_req, res) => res.status(429).json({ success: false, message: "Too many requests" }));
export const SystemRoutes = router;
