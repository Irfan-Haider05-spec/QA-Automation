import type { Request, Response, NextFunction } from "express";
import { readToken } from "../../store";
const auth = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return res.status(401).json({ success: false, message: "Authorization header missing" });
  const user = readToken(h.slice(7));
  if (!user) return res.status(401).json({ success: false, message: "Invalid token" });
  if (roles.length && !roles.includes(user.role)) return res.status(403).json({ success: false, message: "Forbidden" });
  (req as any).user = user;
  next();
};
// planted bug: accepts roles but never checks them
export const authLoose = (...roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  void roles;
  return auth()(req, res, next);
};
export default auth;
