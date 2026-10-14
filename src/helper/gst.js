// helper/gst.js

const GST_KEYS = ["cgst", "sgst", "igst"];

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isBlank = (v) => v === undefined || v === null || v === "";
const toNum = (v) => {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// {cgst, sgst, igst} -> shob key number ba null
const normalizeGst = (raw) => ({
  cgst: toNum(raw?.cgst),
  sgst: toNum(raw?.sgst),
  igst: toNum(raw?.igst),
});

const hasAnyGst = (g) => !!g && GST_KEYS.some((k) => !isBlank(g[k]));

// returns error string | null
const validateGstInput = (raw, label = "") => {
  if (raw === undefined || raw === null) return null;
  for (const k of GST_KEYS) {
    if (isBlank(raw[k])) continue;
    const n = Number(raw[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      return `${label}${k.toUpperCase()} must be between 0 and 100`;
    }
  }
  return null;
};

// sizeVariant -> color variant -> product : prothom je level e GST set ache seta
const pickGst = (...levels) => {
  for (const l of levels) if (hasAnyGst(l)) return normalizeGst(l);
  return normalizeGst(null);
};

const normState = (s) => String(s ?? "").trim().toLowerCase();

// store state != delivery state hole IGST, nahole CGST+SGST
const getGstMode = (storeState, deliveryState) => {
  const a = normState(storeState);
  const b = normState(deliveryState);
  return a && b && a !== b ? "INTER" : "INTRA";
};

const EMPTY_CALC = {
  taxableAmount: null,
  cgstAmount: 0,
  sgstAmount: 0,
  igstAmount: 0,
  gstAmount: 0,
  lineTotalWithGst: null,
};

// lineTotal = unitPrice * qty (GST er age / ba GST soho jodi inclusive hoy)
const calcLineGst = ({ lineTotal, gst, inclusive = false, mode = "INTRA" }) => {
  if (typeof lineTotal !== "number" || !Number.isFinite(lineTotal)) {
    return { ...EMPTY_CALC };
  }
  const g = normalizeGst(gst);
  const rates =
    mode === "INTER"
      ? { cgst: 0, sgst: 0, igst: g.igst || 0 }
      : { cgst: g.cgst || 0, sgst: g.sgst || 0, igst: 0 };
  const totalRate = rates.cgst + rates.sgst + rates.igst;

  const taxableAmount = inclusive
    ? round2(lineTotal / (1 + totalRate / 100))
    : lineTotal;

  const cgstAmount = round2((taxableAmount * rates.cgst) / 100);
  const sgstAmount = round2((taxableAmount * rates.sgst) / 100);
  const igstAmount = round2((taxableAmount * rates.igst) / 100);
  const gstAmount = round2(cgstAmount + sgstAmount + igstAmount);

  return {
    taxableAmount,
    cgstAmount,
    sgstAmount,
    igstAmount,
    gstAmount,
    lineTotalWithGst: inclusive ? lineTotal : round2(lineTotal + gstAmount),
  };
};

// order item (gstRates, gstInclusive, lineTotal) e calculated field gulo boshay
const applyGstToItem = (item, mode) => ({
  ...item,
  ...calcLineGst({
    lineTotal: item.lineTotal,
    gst: item.gstRates,
    inclusive: item.gstInclusive === true,
    mode,
  }),
});

// ---------- product create/update: validateProduct + applyPriceTiers er por call koro ----------
const isEmptySizeRow = (raw) =>
  !(raw?.size || raw?.weight || raw?.height) &&
  !raw?.sku &&
  isBlank(raw?.mrp) &&
  isBlank(raw?.offerPrice);

const parseMaybeJson = (v) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

const setGst = (target, raw) => {
  const g = parseMaybeJson(raw);
  target.gst = hasAnyGst(g) ? normalizeGst(g) : undefined;
};

// error thakle string return kore
const applyGst = (body, data, hasVariants) => {
  const top = parseMaybeJson(body.gst);
  const topErr = validateGstInput(top);
  if (topErr) return topErr;

  setGst(data, top);
  data.gstInclusive = String(body.gstInclusive) === "true";

  if (!hasVariants) return null;

  const hasColor = (data.variants || []).some((v) => v.color);
  const bodyAll = (Array.isArray(body.variants) ? body.variants : []).filter(
    Boolean,
  );
  // validateProduct / applyPriceTiers er moto same filter, index align thakbe
  const srcVariants = hasColor
    ? bodyAll
    : bodyAll.filter((v) => !isEmptySizeRow(v));

  for (let i = 0; i < (data.variants || []).length; i++) {
    const v = data.variants[i];
    const src = srcVariants[i] || {};

    let err = validateGstInput(src.gst, `Variant ${i + 1}: `);
    if (err) return err;
    setGst(v, src.gst);

    if (Array.isArray(v.sizeVariants) && v.sizeVariants.length) {
      const srcSizes = (
        Array.isArray(src.sizeVariants) ? src.sizeVariants : []
      ).filter((sv) => !isEmptySizeRow(sv));

      for (let j = 0; j < v.sizeVariants.length; j++) {
        const srcSize = srcSizes[j] || {};
        err = validateGstInput(srcSize.gst, `Variant ${i + 1} - Size ${j + 1}: `);
        if (err) return err;
        setGst(v.sizeVariants[j], srcSize.gst);
      }
    }
  }
  return null;
};

// ---------- public / list response e use korar jonno ----------
// product (doc ba lean) -> plain object, ar proti variant e effectiveGst
const withEffectiveGst = (product) => {
  const p = typeof product?.toObject === "function" ? product.toObject() : { ...product };
  const productGst = p.gst;
  p.gst = normalizeGst(productGst);
  p.gstInclusive = p.gstInclusive === true;
  p.variants = (p.variants || []).map((v) => ({
    ...v,
    effectiveGst: pickGst(v.gst, productGst),
    sizeVariants: (v.sizeVariants || []).map((sv) => ({
      ...sv,
      effectiveGst: pickGst(sv.gst, v.gst, productGst),
    })),
  }));
  return p;
};

module.exports = {
  normalizeGst,
  hasAnyGst,
  validateGstInput,
  pickGst,
  getGstMode,
  calcLineGst,
  applyGstToItem,
  applyGst,
  withEffectiveGst,
};