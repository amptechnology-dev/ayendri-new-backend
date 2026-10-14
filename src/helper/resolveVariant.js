// helper/resolveVariant.js
const { pickGst } = require("./gst.js");

// "null" / "undefined" / "" string ke empty dhorbe
const normalizeId = (id) => {
  if (id === undefined || id === null) return null;
  const s = String(id).trim();
  if (!s || s === "null" || s === "undefined") return null;
  return s;
};

const orNull = (v) => (v === undefined ? null : v);

const findActiveVariant = (product, variantId) => {
  const idStr = normalizeId(variantId);
  if (!idStr || !Array.isArray(product?.variants)) return null;

  for (const v of product.variants) {
    if (v.isActive === false) continue; // inactive color/parent skip

    if (String(v._id) === idStr) {
      // size variant ache, kintu size select hoy nai
      if (Array.isArray(v.sizeVariants) && v.sizeVariants.length > 0) {
        return null;
      }
      return { variant: v, parent: null };
    }

    if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
      const nested = v.sizeVariants.find(
        (sv) => String(sv._id) === idStr && sv.isActive !== false,
      );
      if (nested) return { variant: nested, parent: v };
    }
  }

  return null;
};

// NOTE: price na thakleo null return kora hobe NA.
// Price-less item controller e priceOnRequest hishebe handle hoy.
// null = sudhu "variant invalid / select kora hoy nai"
const resolveLineSource = (product, variantId) => {
  if (!product) return null;

  const idStr = normalizeId(variantId);
  const hasVariants =
    Array.isArray(product.variants) && product.variants.length > 0;

  // ---------- variant selected ----------
  if (idStr) {
    const found = findActiveVariant(product, idStr);
    if (!found) return null;

    const { variant, parent } = found;
    return {
      variantId: variant._id,
      mrp: orNull(variant.mrp ?? parent?.mrp),
      offerPrice: orNull(variant.offerPrice ?? parent?.offerPrice),
      stock: variant.currentStock ?? 0,
      color: variant.color ?? parent?.color ?? null,
      size: variant.size ?? null,
      weight: variant.weight ?? parent?.weight ?? null,
      height: variant.height ?? parent?.height ?? null,
      image:
        variant.images?.[0] || parent?.images?.[0] || product.images?.[0] || null,
      // [GST] size -> color -> product
      gst: pickGst(variant.gst, parent?.gst, product.gst),
      gstInclusive: product.gstInclusive === true,
    };
  }

  // product e variant ache, kintu variantId nai -> user ke select korte hobe
  if (hasVariants) return null;

  // ---------- simple product (price thakuk ba na thakuk) ----------
  return {
    variantId: null,
    mrp: orNull(product.mrp),
    offerPrice: orNull(product.offerPrice),
    stock: product.currentStock ?? 0,
    color: null,
    size: null,
    weight: null,
    height: null,
    image: product.images?.[0] ?? null,
    gst: pickGst(product.gst),
    gstInclusive: product.gstInclusive === true,
  };
};

module.exports = { findActiveVariant, resolveLineSource };