import { Router } from "express";
import auth from "../../middlewares/auth";
const router = Router();
router.get("/:id", auth(), (req, res) => res.status(404).json({ success: false, message: "Not found" }));
// planted bug: unreachable, /:id above matches "featured"
router.get("/featured", auth(), (_req, res) => res.json({ success: true, data: [] }));
router.post("/test");
export const ProductRoutes = router;
