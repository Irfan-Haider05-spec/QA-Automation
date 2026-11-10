import { Router } from "express";
import { USERS, issueToken } from "../../../store";
const router = Router();
router.post("/login", (req, res) => {
  const { identifier, password, device } = req.body ?? {};
  const u = USERS.find((x) => x.identifier === identifier && x.password === password);
  if (!u) return res.status(400).json({ success: false, message: "Invalid credentials" });
  if (u.device !== device) return res.status(403).json({ success: false, message: "Wrong device" });
  // planted: refresh cookie without HttpOnly / SameSite
  res.setHeader("set-cookie", `refreshToken=${issueToken(u)}; Path=/`);
  res.json({ success: true, message: "ok", data: { accessToken: issueToken(u) } });
});
export const AuthRoutes = router;
