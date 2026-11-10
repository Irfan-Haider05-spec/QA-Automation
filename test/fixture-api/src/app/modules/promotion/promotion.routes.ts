import { Router } from "express";
import auth from "../../middlewares/auth";
import { PROMOTIONS } from "../../../store";
import validateRequest from "../../middlewares/validateRequest";
import { PromotionValidation } from "./promotion.validation";
const router = Router();
router.get("/", auth("MERCHANT"), (req: any, res) => {
  res.json({ success: true, data: PROMOTIONS.filter((p) => p.merchantId === req.user.id) });
});
// planted bug: crashes when limit is above 20 (fuzzer should find it)
router.get("/search", auth(), validateRequest(PromotionValidation.searchZodSchema), (req, res) => {
  const limit = Number(req.query.limit ?? 10);
  if (limit > 20) throw new Error("planted: page size overflow");
  res.json({ success: true, data: PROMOTIONS.filter((p) => p.title.includes(String(req.query.q))).slice(0, limit) });
});
router.post("/", auth("MERCHANT"), validateRequest(PromotionValidation.createPromotionZodSchema), (req: any, res) => {
  res.status(201).json({ success: true, data: { _id: "5f00000000000000000000ff", merchantId: req.user.id, ...req.body } });
});
// planted bug: no merchant scoping on detail
router.get("/:id", auth(), (req, res) => {
  const p = PROMOTIONS.find((x) => x._id === req.params.id);
  if (!p) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: p });
});
router.patch("/:id", auth("MERCHANT"), (req: any, res) => {
  const p = PROMOTIONS.find((x) => x._id === req.params.id && x.merchantId === req.user.id);
  if (!p) return res.status(404).json({ success: false, message: "Not found" });
  res.json({ success: true, data: p });
});
export const PromotionRoutes = router;
