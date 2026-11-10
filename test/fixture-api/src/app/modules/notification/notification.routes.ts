import { Router } from "express";
import auth from "../../middlewares/auth";
import { notifyUser, broadcast } from "../../../realtime";
const router = Router();
// Sends a realtime "newNotification" to the caller. Planted bug (realtime.ts): delivered only
// to sockets on this process, so a second instance never gets it.
router.post("/ping", auth(), (req, res) => {
  const user = (req as any).user as { id: string };
  notifyUser(user.id, "newNotification", { message: "ping" });
  res.json({ success: true, data: { sent: true } });
});
// Planted bug: broadcasts the caller's event to every connected socket (io.emit), like
// "salesActivation::<userId>" in the real backend
router.post("/activation-test", auth(), (req, res) => {
  const user = (req as any).user as { id: string };
  broadcast(`salesActivation::${user.id}`, { status: "active" });
  res.json({ success: true, data: { sent: true } });
});
export const NotificationRoutes = router;
