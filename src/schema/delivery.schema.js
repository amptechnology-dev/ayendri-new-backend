const { z } = require("zod");

const DURATION_UNITS = ["MINUTES", "HOURS", "DAYS"];

const pincodeField = z
  .string()
  .trim()
  .regex(/^[1-9][0-9]{5}$/, "Enter a valid 6 digit pincode");

const slabSchema = z.object({
  upToKm: z.coerce.number().positive().max(500),
  charge: z.coerce.number().min(0).max(100000),
  etaValue: z.coerce.number().min(0).max(100000),
  etaUnit: z.enum(DURATION_UNITS),
});

const ruleSchema = z.object({
  minOrderValue: z.coerce.number().min(0).max(10000000),
  charge: z.coerce.number().min(0).max(100000),
});

const saveDeliverySettingsSchema = z
  .object({
    storeId: z.string().min(1, "Store is required"),
    deliveryType: z.enum(["LOCAL", "NATIONAL", "BOTH"]),
    pincode: pincodeField,

    // LOCAL
    radiusKm: z.coerce.number().positive().max(500).optional(),
    localSlabs: z.array(slabSchema).max(20).optional(),
    // slab na dile (purono API call) ei duto lagbe
    localDeliveryDays: z.coerce.number().int().min(0).max(30).optional(),
    localDeliveryCharge: z.coerce.number().min(0).max(100000).optional(),

    // order value rules
    // [NEW] product / service alada rule
    productChargeRules: z.array(ruleSchema).max(20).optional(),
    serviceChargeRules: z.array(ruleSchema).max(20).optional(),
    // purono field (purono frontend / API call er jonno), notun frontend pathabe na
    chargeRules: z.array(ruleSchema).max(20).optional(),

    // NATIONAL
    nationalMinDays: z.coerce.number().int().min(0).max(60).optional(),
    nationalMaxDays: z.coerce.number().int().min(0).max(60).optional(),
    nationalFallbackCharge: z.coerce.number().min(0).max(100000).optional(),

    // INTERNATIONAL
    allowInternational: z.boolean().optional(),
    internationalMinDays: z.coerce.number().int().min(0).max(90).optional(),
    internationalMaxDays: z.coerce.number().int().min(0).max(90).optional(),
    internationalFallbackCharge: z.coerce.number().min(0).max(100000).optional(),

    // dispatch time
    handlingValue: z.coerce.number().min(0).max(100000).optional(),
    handlingUnit: z.enum(DURATION_UNITS).optional(),
    handlingDays: z.coerce.number().int().min(0).max(30).optional(), // purono
  })
  .superRefine((d, ctx) => {
    const needsLocal = d.deliveryType === "LOCAL" || d.deliveryType === "BOTH";
    const needsNational =
      d.deliveryType === "NATIONAL" || d.deliveryType === "BOTH";

    if (needsLocal) {
      if (d.radiusKm === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["radiusKm"],
          message: "Delivery radius is required for local delivery",
        });
      }

      const slabs = d.localSlabs || [];
      if (slabs.length === 0 && d.localDeliveryDays === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["localSlabs"],
          message: "Add at least one distance slab",
        });
      }

      const seen = new Set();
      slabs.forEach((s, i) => {
        if (d.radiusKm !== undefined && s.upToKm > d.radiusKm) {
          ctx.addIssue({
            code: "custom",
            path: ["localSlabs", i, "upToKm"],
            message: "Cannot be more than your delivery radius",
          });
        }
        if (seen.has(s.upToKm)) {
          ctx.addIssue({
            code: "custom",
            path: ["localSlabs", i, "upToKm"],
            message: "Two slabs have the same distance",
          });
        }
        seen.add(s.upToKm);
      });
    }

    // [NEW] product / service / purono rule, proti list e same order value duplicate check
    ["productChargeRules", "serviceChargeRules", "chargeRules"].forEach(
      (field) => {
        const seenRules = new Set();
        (d[field] || []).forEach((r, i) => {
          if (seenRules.has(r.minOrderValue)) {
            ctx.addIssue({
              code: "custom",
              path: [field, i, "minOrderValue"],
              message: "Two rules have the same order value",
            });
          }
          seenRules.add(r.minOrderValue);
        });
      },
    );

    if (needsNational) {
      if (d.nationalMinDays === undefined || d.nationalMaxDays === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["nationalMinDays"],
          message: "National delivery min and max days are required",
        });
      } else if (d.nationalMaxDays < d.nationalMinDays) {
        ctx.addIssue({
          code: "custom",
          path: ["nationalMaxDays"],
          message: "Max days cannot be less than min days",
        });
      }
    }

    if (d.allowInternational) {
      if (!needsNational) {
        ctx.addIssue({
          code: "custom",
          path: ["allowInternational"],
          message: "International delivery needs courier delivery to be ON",
        });
      }
      if (
        d.internationalMinDays !== undefined &&
        d.internationalMaxDays !== undefined &&
        d.internationalMaxDays < d.internationalMinDays
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["internationalMaxDays"],
          message: "Max days cannot be less than min days",
        });
      }
    }
  });

module.exports = { saveDeliverySettingsSchema };