import { z } from "zod";

export const trackingSchema = z.object({
  name: z
    .string()
    .describe(
      "The name of the tracking category. Can be obtained from the list-tracking-categories tool",
    ),
  option: z
    .string()
    .describe(
      "The name of the tracking option. Can be obtained from the list-tracking-categories tool",
    ),
  trackingCategoryID: z
    .string()
    .optional()
    .describe(
      "The ID of the tracking category. Not needed: Xero resolves the category from the name and option above, so there is no need to call list-tracking-categories for it. Supply it only if you already have it to hand",
    ),
});
