const { z } = require("zod");

const packagingDetailsSchema = z
  .object({
    expectedDeliveryDays: z.coerce.number().min(0).optional(),
    length: z.coerce.number().min(0).optional(),
    breadth: z.coerce.number().min(0).optional(),
    height: z.coerce.number().min(0).optional(),
    weight: z.coerce.number().min(0).optional(),
  })
  .optional();

const gstPercent = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : v),
  z.coerce.number().min(0).max(100).optional(),
);

const gstSchema = z
  .object({ cgst: gstPercent, sgst: gstPercent, igst: gstPercent })
  .optional();

// FormData te "false" string ashe, z.coerce.boolean("false") = true hoye jay, tai alada
const boolish = z.preprocess(
  (v) => (v === undefined || v === null || v === "" ? undefined : String(v).toLowerCase() === "true"),
  z.boolean().optional(),
);

// policy days: faka = undefined (asol validation helper/productPolicy.js e)
const policyDays = z.preprocess(
  (v) => (v === "" || v === null || v === undefined ? undefined : v),
  z.coerce.number().int().min(1).max(365).optional(),
);

const createProductSchema = z.object({
  name: z.string().trim().min(1, "Product name is required"),
  description: z.string().trim().min(1, "Product description is required"),
  unit: z.string().trim().min(1, "Unit is required"),
  storeId: z.string().min(1, "Store is required"),
  categoryId: z.string().min(1, "Category is required"),

  mrp: z.coerce.number().min(0).optional(),
  offerPrice: z.coerce.number().min(0).optional(),
  openingStock: z.coerce.number().min(0).optional(),
  packagingDetails: packagingDetailsSchema,
  gst: gstSchema,
  gstInclusive: boolish,
  hsnCode: z.string().trim().optional(),

  // product type + return / replace / refund policy
  productType: z.enum(["PRODUCT", "SERVICE"]).optional(),
  isReturnable: boolish,
  returnDays: policyDays,
  isReplaceable: boolish,
  replaceDays: policyDays,
  isRefundable: boolish,
  refundDays: policyDays,

  variants: z.array(z.record(z.any())).optional(),
});

const updateProductSchema = createProductSchema.partial();

module.exports = {
  createProductSchema,
  updateProductSchema,
  packagingDetailsSchema,
};