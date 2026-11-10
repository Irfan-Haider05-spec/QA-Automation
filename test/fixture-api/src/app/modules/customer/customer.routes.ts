import { Router } from "express";
import auth from "../../middlewares/auth";
import { CUSTOMERS } from "../../../store";
const router = Router();
router.get("/", auth("MERCHANT"), (req: any, res) => {
  res.json({ success: true, data: { result: CUSTOMERS.filter((c) => c.merchantId === req.user.id) } });
});
// correct: scoped by merchant
router.get("/:id", auth("MERCHANT"), (req: any, res) => {
  const c = CUSTOMERS.find((x) => x._id === req.params.id && x.merchantId === req.user.id);
  if (!c) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: c });
});
export const CustomerRoutes = router;
