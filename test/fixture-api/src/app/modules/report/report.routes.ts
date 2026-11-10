import { Router } from "express";
import { CUSTOMERS } from "../../../store";
const router = Router();
// planted bug: export without auth
router.get("/customer/export", (_req, res) => res.json({ success: true, data: CUSTOMERS }));
export const ReportRoutes = router;
