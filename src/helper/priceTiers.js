const MAX_TIERS = 10;

const isBlank = (v) => v === undefined || v === null || v === "";

const toNum = (v) => (isBlank(v) ? null : Number(v));

// validateProduct er isEmptySizeVariant er sathe same, jate index mismatch na hoy
const isEmptySizeRow = (raw) =>
  !(raw?.size || raw?.weight || raw?.height) &&
  !raw?.sku &&
  isBlank(raw?.mrp) &&
  isBlank(raw?.offerPrice);

// raw tiers validate + normalize kore. return: { tiers } ba { error }
// NOTE: tier price er upor MRP validation nei (tier price MRP er beshi hole-o cholbe)
const normalizeTiers = (raw, { label = "" } = {}) => {
  if (raw === undefined || raw === null) return { tiers: [] };
  if (!Array.isArray(raw)) return { error: `${label}Invalid price tiers` };
  if (raw.length === 0) return { tiers: [] };
  if (raw.length > MAX_TIERS) {
    return { error: `${label}You can add at most ${MAX_TIERS} price tiers` };
  }

  const tiers = raw.map((t) => ({
    minQty: toNum(t?.minQty),
    maxQty: toNum(t?.maxQty),
    price: toNum(t?.price),
  }));

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    if (!Number.isInteger(t.minQty) || t.minQty < 1) {
      return {
        error: `${label}Tier ${i + 1}: min quantity must be a whole number >= 1`,
      };
    }
    if (t.price === null || !Number.isFinite(t.price) || t.price < 0) {
      return { error: `${label}Tier ${i + 1}: valid price is required` };
    }
  }

  tiers.sort((a, b) => a.minQty - b.minQty);

  if (tiers[0].minQty !== 1) {
    return { error: `${label}First tier must start from quantity 1` };
  }

  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i];
    const isLast = i === tiers.length - 1;

    if (isLast) {
      // last tier: maxQty khali = no limit, value thakle seta RAKHBE (age null kore dito)
      if (
        t.maxQty !== null &&
        (!Number.isInteger(t.maxQty) || t.maxQty < t.minQty)
      ) {
        return {
          error: `${label}Tier ${i + 1}: max quantity must be a whole number >= ${t.minQty}`,
        };
      }
      continue;
    }

    if (!Number.isInteger(t.maxQty) || t.maxQty < t.minQty) {
      return {
        error: `${label}Tier ${i + 1}: max quantity must be >= min quantity`,
      };
    }
    if (tiers[i + 1].minQty !== t.maxQty + 1) {
      return {
        error: `${label}Tier ${i + 1}: next tier must start from ${t.maxQty + 1} (no gap or overlap allowed)`,
      };
    }
  }

  return { tiers };
};

// qty er jonno kon tier er price lagbe
// last tier er maxQty set thakle, tar upore qty gele fallback (normal price) hobe
const pickTierPrice = (tiers, qty, fallback) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return fallback;
  const sorted = [...tiers].sort((a, b) => b.minQty - a.minQty);
  const tier = sorted.find((t) => qty >= t.minQty);
  if (!tier) return fallback;
  if (tier.maxQty !== null && tier.maxQty !== undefined && qty > tier.maxQty) {
    return fallback;
  }
  return tier.price;
};

// product er je unit (simple / variant / sizeVariant) er variantId, tar tiers
const findTiers = (product, variantId) => {
  if (!product) return [];
  if (!variantId) return product.priceTiers || [];
  const id = String(variantId);
  for (const v of product.variants || []) {
    if (String(v._id) === id) return v.priceTiers || [];
    for (const sv of v.sizeVariants || []) {
      if (String(sv._id) === id) return sv.priceTiers || [];
    }
  }
  return [];
};

const getUnitPrice = (product, variantId, fallback, qty) =>
  pickTierPrice(findTiers(product, variantId), qty, fallback);

// "aro X ta nile Y price" hint er jonno
const getNextTier = (tiers, qty) => {
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const next = [...tiers]
    .sort((a, b) => a.minQty - b.minQty)
    .find((t) => t.minQty > qty);
  return next
    ? { minQty: next.minQty, price: next.price, moreNeeded: next.minQty - qty }
    : null;
};

const productHasTiers = (p) =>
  (p?.priceTiers || []).length > 0 ||
  (p?.variants || []).some(
    (v) =>
      (v.priceTiers || []).length > 0 ||
      (v.sizeVariants || []).some((s) => (s.priceTiers || []).length > 0),
  );

// listing e "bulk price from ₹X" dekhate
const getMinTierPrice = (p) => {
  const prices = [];
  const push = (arr) => (arr || []).forEach((t) => prices.push(t.price));
  push(p?.priceTiers);
  (p?.variants || []).forEach((v) => {
    push(v.priceTiers);
    (v.sizeVariants || []).forEach((s) => push(s.priceTiers));
  });
  return prices.length ? Math.min(...prices) : null;
};

// validateProduct er por: body theke tier niye data te boshay.
// offerPrice: user explicitly dile seta thakbe, khali hole tiers[0].price hobe.
// error thakle string return kore.
const applyPriceTiers = (body, data, hasVariants) => {
  if (!hasVariants) {
    const r = normalizeTiers(body.priceTiers);
    if (r.error) return r.error;
    data.priceTiers = r.tiers;
    if (r.tiers.length && isBlank(body.offerPrice)) {
      data.offerPrice = r.tiers[0].price;
    }
    return null;
  }

  data.priceTiers = [];

  const hasColor = (data.variants || []).some((v) => v.color);
  const bodyAll = (Array.isArray(body.variants) ? body.variants : []).filter(
    Boolean,
  );
  // validateProduct jevabe filter kore, thik sevabei align kora
  const srcVariants = hasColor
    ? bodyAll
    : bodyAll.filter((v) => !isEmptySizeRow(v));

  for (let i = 0; i < (data.variants || []).length; i++) {
    const v = data.variants[i];
    const src = srcVariants[i] || {};

    if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
      v.priceTiers = [];
      const srcSizes = (
        Array.isArray(src.sizeVariants) ? src.sizeVariants : []
      ).filter((sv) => !isEmptySizeRow(sv));

      for (let j = 0; j < v.sizeVariants.length; j++) {
        const sv = v.sizeVariants[j];
        const srcSize = srcSizes[j] || {};
        const r = normalizeTiers(srcSize.priceTiers, {
          label: `Variant ${i + 1} - Size ${j + 1}: `,
        });
        if (r.error) return r.error;
        sv.priceTiers = r.tiers;
        if (r.tiers.length && isBlank(srcSize.offerPrice)) {
          sv.offerPrice = r.tiers[0].price;
        }
      }
    } else {
      const r = normalizeTiers(src.priceTiers, {
        label: `Variant ${i + 1}: `,
      });
      if (r.error) return r.error;
      v.priceTiers = r.tiers;
      if (r.tiers.length && isBlank(src.offerPrice)) {
        v.offerPrice = r.tiers[0].price;
      }
    }
  }
  return null;
};

module.exports = {
  normalizeTiers,
  pickTierPrice,
  findTiers,
  getUnitPrice,
  getNextTier,
  productHasTiers,
  getMinTierPrice,
  applyPriceTiers,
};