const { z } = require("zod");
const mongoose = require("mongoose");

const objectId = z.string().refine((val) => mongoose.isValidObjectId(val), {
  message: "Invalid ObjectId",
});

// "" ba "null" pathale null hoye jabe (mane remove / kono value nai)
const nullableObjectId = z.preprocess(
  (v) => (v === "" || v === "null" ? null : v),
  objectId.nullable().optional(),
);

// FormData theke JSON string ("[...]"), single string ba array - shob handle kore
// undefined = change nai, [] = shob category remove
const objectIdArray = z.preprocess((v) => {
  if (v === undefined) return undefined;
  if (v === null || v === "" || v === "null") return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [v];
    }
  }
  return v;
}, z.array(objectId).max(100, "Too many categories").optional());

// FormData e boolean string hoye ashe ("true"/"false")
const booleanField = z.preprocess((v) => {
  if (v === undefined) return undefined;
  return v === true || v === "true" || v === "1";
}, z.boolean().optional());

const createBannerSchema = z.object({
  name: z.string().trim().min(1, "Banner name is required"),
  storeId: objectId,
  categoryIds: objectIdArray,
  productId: nullableObjectId,
  offerBanner: booleanField,
});

const updateBannerSchema = createBannerSchema.partial();

module.exports = { createBannerSchema, updateBannerSchema };