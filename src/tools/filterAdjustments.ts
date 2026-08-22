import { z } from "zod";

/**
 * The adjustments a filter is made of, as the model may send them.
 *
 * One schema for `preview_filter` and `create_filter`: what the operator sees
 * in the preview is exactly the object that gets saved, field for field.
 *
 * Ranges copied from `adjustmentRanges` in the Studio's
 * lib/filters/adjustmentRanges.ts (formerly the filter editor page). They are
 * in the schema, not just the description, because the model is translating
 * "hangat dan agak pudar" into numbers and has nothing else to go on. Get the
 * scale wrong and the filter is created successfully and looks broken — the
 * worst of both outcomes, because nothing reports an error.
 *
 * Only the adjustments an operator would ask for by name are exposed. The
 * Studio's model has thirty-odd; sharpening radius and noise-reduction
 * smoothness are not things anyone describes in a sentence, and every extra
 * field is another number for the model to invent.
 */
export const filterAdjustments = z
  .object({
    brightness: z.number().min(0).max(200).optional().describe("100 = unchanged"),
    contrast: z.number().min(0).max(200).optional().describe("100 = unchanged"),
    saturation: z.number().min(0).max(200).optional().describe("100 = unchanged, 0 = grey"),
    temperature: z
      .number()
      .min(-100)
      .max(100)
      .optional()
      .describe("0 = unchanged, positive = warmer"),
    tint: z.number().min(-100).max(100).optional().describe("0 = unchanged, positive = magenta"),
    exposure: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    shadows: z.number().min(-100).max(100).optional().describe("0 = unchanged, positive = lifted"),
    highlights: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    whites: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    blacks: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    vibrance: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    clarity: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    dehaze: z.number().min(-100).max(100).optional().describe("0 = unchanged"),
    sepia: z.number().min(0).max(100).optional().describe("0 = off"),
    grayscale: z.number().min(0).max(100).optional().describe("0 = off, 100 = black and white"),
    vignette: z.number().min(0).max(200).optional().describe("0 = off"),
    grain: z.number().min(0).max(100).optional().describe("0 = off"),
    blur: z.number().min(0).max(10).optional().describe("0 = off, in pixels"),
    hueRotate: z.number().min(0).max(360).optional().describe("0 = unchanged, in degrees"),
  })
  .describe(
    "Only include what the operator asked to change. An omitted adjustment keeps its neutral value; sending every field at its neutral value creates a filter that does nothing."
  );

export type FilterAdjustmentsInput = z.infer<typeof filterAdjustments>;
