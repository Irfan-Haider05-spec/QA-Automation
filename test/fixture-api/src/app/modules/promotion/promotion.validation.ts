import { z } from "zod";
const searchZodSchema = z.object({
  query: z.object({ q: z.string().min(1), limit: z.coerce.number().int().min(1).max(50).optional() }),
});
const createPromotionZodSchema = z.object({
  body: z.object({ title: z.string().min(3), discount: z.number().min(1).max(100) }),
});
export const PromotionValidation = { searchZodSchema, createPromotionZodSchema };
