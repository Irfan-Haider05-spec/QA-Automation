import type { Request, Response, NextFunction } from "express";
import type { AnyZodObject } from "zod";
const validateRequest = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
  try { await schema.parseAsync({ body: req.body, params: req.params, query: req.query }); next(); }
  catch (e: any) { res.status(400).json({ success: false, message: "Validation error", errors: e.errors }); }
};
export default validateRequest;
