const { z } = require("zod");

const discountCfgSchema = z
  .object({
    enabled: z.boolean(),
    percent: z.number().min(0).max(90),
  })
  .refine((v) => !v.enabled || v.percent > 0, {
    message: "Discount percent must be greater than 0",
    path: ["percent"],
  });

const updateStoreSettingSchema = z.object({
  hasDelivery: z.boolean().optional(),
  paymentMode: z.enum(["BOTH", "ONLINE_ONLY", "OFF"]).optional(),
  paymentFirst: z.boolean().optional(),
  mobileFirstOrderDiscount: z
    .object({
      product: discountCfgSchema,
      service: discountCfgSchema,
    })
    .optional(),
});

module.exports = { updateStoreSettingSchema };
