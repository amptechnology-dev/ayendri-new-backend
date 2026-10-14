const { z } = require("zod");

// shob field optional: jeta toggle korbe shudhu seta pathale-i cholbe
const updateStoreSettingSchema = z
  .object({
    hasDelivery: z.boolean().optional(),
    paymentMode: z.enum(["BOTH", "ONLINE_ONLY", "OFF"]).optional(),
    paymentFirst: z.boolean().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined), {
    message: "At least one setting is required",
  });

module.exports = { updateStoreSettingSchema };
