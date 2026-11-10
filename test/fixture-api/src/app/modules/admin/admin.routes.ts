import { Router } from "express";
import auth from "../../middlewares/auth";
const router = Router();
// planted bug: anyone can create an admin
router.post("/create-admin", (req, res) => res.status(201).json({ success: true, data: { created: true } }));
router.get("/stats", auth("ADMIN", "SUPER_ADMIN"), (_req, res) => res.json({ success: true, data: { merchants: 2 } }));
// planted: privileged route without role
router.get("/merchants", auth(), (_req, res) => res.json({ success: true, data: [] }));
export const AdminRoutes = router;
