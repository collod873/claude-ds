import { z } from "zod";

const RubricItem = z.object({
  id: z.string().min(1),
  pass: z.boolean(),
  reason: z.string().min(1),
});

export const GradeOutput = z.object({
  items: z.array(RubricItem).length(23),
  score: z.number().int().min(0).max(23),
  allPass: z.boolean(),
  summary: z.string().min(1),
});

export type GradeOutput = z.infer<typeof GradeOutput>;
