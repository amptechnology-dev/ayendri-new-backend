// helper/validateProduct.js

const isBlank = (v) => v === undefined || v === null || v === "";
const toNum = (v) => (isBlank(v) ? undefined : Number(v));

const buildPackaging = (input = {}) => ({
  expectedDeliveryDays: toNum(input.expectedDeliveryDays),
  length: toNum(input.length),
  breadth: toNum(input.breadth),
  height: toNum(input.height),
  weight: toNum(input.weight),
});

const buildStock = (input = {}) => {
  const openingStock = Number(input.openingStock ?? 0);
  return {
    openingStock,
    currentStock: openingStock,
    lowStockThreshold: Number(input.lowStockThreshold ?? 0),
  };
};

const hasAttribute = (raw = {}) => !!(raw.size || raw.weight || raw.height);

// Row-ta puropuri khali (UI-r stray default row) kina
const isEmptySizeVariant = (raw = {}) =>
  !hasAttribute(raw) && !raw.sku && isBlank(raw.mrp) && isBlank(raw.offerPrice);

// MRP optional. MRP khali + offerPrice khali = "price on request" (store order-er por estimate dibe).
// offerPrice dile MRP lagbe, ar offerPrice <= MRP hote hobe.
const validatePricing = (raw, errors, path) => {
  const prefix = path ? `${path}.` : "";
  const hasMrp = !isBlank(raw.mrp);
  const hasOffer = !isBlank(raw.offerPrice);

  if (hasMrp && (Number.isNaN(Number(raw.mrp)) || Number(raw.mrp) < 0)) {
    errors.push({
      field: `${prefix}mrp`,
      message: "MRP must be a valid number >= 0",
    });
  }

  if (
    hasOffer &&
    (Number.isNaN(Number(raw.offerPrice)) || Number(raw.offerPrice) < 0)
  ) {
    errors.push({
      field: `${prefix}offerPrice`,
      message: "Offer price must be a valid number >= 0",
    });
  }

  if (hasOffer && !hasMrp) {
    errors.push({
      field: `${prefix}mrp`,
      message: "Enter MRP, or clear Offer Price to keep price on request",
    });
  }

  if (hasOffer && hasMrp && Number(raw.offerPrice) > Number(raw.mrp)) {
    errors.push({
      field: `${prefix}offerPrice`,
      message: "Offer price cannot be greater than MRP",
    });
  }
};

// MRP nai -> mrp ar offerPrice duto-i null (price on request).
// MRP ache, offerPrice nai -> offerPrice = mrp.
const resolvePrices = (raw) => {
  if (isBlank(raw.mrp)) return { mrp: null, offerPrice: null };
  const mrp = Number(raw.mrp);
  const offerPrice = isBlank(raw.offerPrice) ? mrp : Number(raw.offerPrice);
  return { mrp, offerPrice };
};

const buildSizeVariant = (raw, errors, path) => {
  if (!hasAttribute(raw)) {
    errors.push({
      field: `${path}.size`,
      message: "Enter at least one of Size, Weight or Height",
    });
  }
  validatePricing(raw, errors, path);
  return {
    size: raw.size || null,
    weight: raw.weight || null,
    height: raw.height || null,
    ...resolvePrices(raw),
    ...buildStock(raw),
    sku: raw.sku || null,
    isActive: raw.isActive ?? true,
    packagingDetails: buildPackaging(raw.packagingDetails),
  };
};

// Color variant: size options optional
const buildColorVariant = (raw, errors, path) => {
  if (!raw.color || !String(raw.color).trim()) {
    errors.push({ field: `${path}.color`, message: "Color name is required" });
  }

  const rawSizeVariants = (
    Array.isArray(raw.sizeVariants) ? raw.sizeVariants : []
  ).filter((sv) => !isEmptySizeVariant(sv));

  const base = {
    color: raw.color ? String(raw.color).trim() : null,
    images: Array.isArray(raw.images) ? raw.images : [],
    isActive: raw.isActive ?? true,
    packagingDetails: buildPackaging(raw.packagingDetails),
    sizeVariants: [],
  };

  if (rawSizeVariants.length > 0) {
    // color + size options: price/stock size-row e thakbe
    base.sizeVariants = rawSizeVariants.map((sv, idx) =>
      buildSizeVariant(sv, errors, `${path}.sizeVariants[${idx}]`),
    );
    base.mrp = null;
    base.offerPrice = null;
    base.openingStock = 0;
    base.currentStock = 0;
    base.lowStockThreshold = 0;
  } else {
    // color-only: size/weight/height lagbe na
    validatePricing(raw, errors, path);
    Object.assign(base, resolvePrices(raw), buildStock(raw));
    base.sku = raw.sku || null;
  }

  return base;
};

// req.files theke main image ar per-color image count
const countUploads = (files) => {
  const list = Array.isArray(files) ? files : Object.values(files || {}).flat();
  let main = 0;
  const variant = {};
  list.forEach((f) => {
    const name = f?.fieldname || "";
    if (/^variantImage_\d+$/.test(name)) {
      const i = Number(name.split("_")[1]);
      variant[i] = (variant[i] || 0) + 1;
    } else {
      main += 1;
    }
  });
  return { main, variant };
};

/**
 * body: req.body (variants controller e JSON.parse kora thakte hobe)
 * options.files: req.files
 * options.existingMainImages: update-er somoy already thaka main image URL list
 * returns: { errors, data, hasVariants, hasColor }
 */
const validateProduct = (
  body,
  { files = [], existingMainImages = [] } = {},
) => {
  const errors = [];
  const data = {};

  const allRaw = Array.isArray(body.variants)
    ? body.variants.filter(Boolean)
    : [];

  // Frontend explicit flag pathay; na thakle variants dekhe bujhe nei
  const hasColor = !isBlank(body.hasColor)
    ? String(body.hasColor) === "true"
    : allRaw.some((v) => v.color);

  const rawVariants = hasColor
    ? allRaw // color mode: index preserve korte hobe (variantImage_<idx> er jonno)
    : allRaw.filter((v) => !isEmptySizeVariant(v));

  const hasVariants = rawVariants.length > 0;
  const uploads = countUploads(files);

  // ---------- IMAGE RULES ----------
  if (!hasColor) {
    if (existingMainImages.length + uploads.main === 0) {
      errors.push({
        field: "images",
        message: "At least one product image is required",
      });
    }
  }

  if (hasColor) {
    if (!hasVariants) {
      errors.push({
        field: "variants",
        message: "At least one color is required",
      });
    }
    data.variants = rawVariants.map((v, idx) => {
      const built = buildColorVariant(v, errors, `variants[${idx}]`);
      const imgCount = built.images.length + (uploads.variant[idx] || 0);
      if (imgCount === 0) {
        errors.push({
          field: `variants[${idx}].images`,
          message: `Color ${idx + 1}: at least one image is required`,
        });
      }
      return built;
    });
    data.mrp = null;
    data.offerPrice = null;
    data.openingStock = 0;
    data.currentStock = 0;
    data.packagingDetails = buildPackaging(body.packagingDetails);
  } else if (hasVariants) {
    // normal size/weight/height variants
    data.variants = rawVariants.map((v, idx) =>
      buildSizeVariant(v, errors, `variants[${idx}]`),
    );
    data.mrp = null;
    data.offerPrice = null;
    data.openingStock = 0;
    data.currentStock = 0;
    data.packagingDetails = buildPackaging(body.packagingDetails);
  } else {
    // simple product
    validatePricing(body, errors, "");
    Object.assign(data, resolvePrices(body), buildStock(body));
    data.packagingDetails = buildPackaging(body.packagingDetails);
    data.variants = [];
  }

  return { errors, data, hasVariants, hasColor };
};

module.exports = { validateProduct };