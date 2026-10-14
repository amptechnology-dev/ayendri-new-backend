const { productHasTiers } = require("./priceTiers.js");

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// null / undefined / NaN / "" kono-tai "price" na
const hasPrice = (n) => typeof n === "number" && Number.isFinite(n);

const isBlank = (v) => v === undefined || v === null || v === "";

const QUOTE_PENDING_STATUSES = ["AWAITING_QUOTE", "QUOTED"];
const GST_AMOUNT_KEYS = ["cgstAmount", "sgstAmount", "igstAmount"];

// price-less item bad diye totals. Item e GST calculated field thakle (applyGstToItem) seta dhorbe.
const computeTotals = (items) => {
  const priced = items.filter((i) => hasPrice(i.offerPrice));
  const sum = (arr, fn) => arr.reduce((s, i) => s + (fn(i) || 0), 0);

  const totalItems = items.reduce((s, i) => s + i.quantity, 0);
  const totalMrp = round2(
    sum(priced, (i) => (hasPrice(i.mrp) ? i.mrp : i.offerPrice) * i.quantity),
  );
  const subtotal = round2(sum(priced, (i) => i.lineTotal));
  const totalTaxable = round2(sum(priced, (i) => i.taxableAmount ?? i.lineTotal));
  const totalCgst = round2(sum(priced, (i) => i.cgstAmount));
  const totalSgst = round2(sum(priced, (i) => i.sgstAmount));
  const totalIgst = round2(sum(priced, (i) => i.igstAmount));
  const totalGst = round2(totalCgst + totalSgst + totalIgst);
  // payable: exclusive item e GST jog hoy, inclusive item e already bhetore ache
  const totalAmount = round2(sum(priced, (i) => i.lineTotalWithGst ?? i.lineTotal));
  const discount = round2(Math.max(0, totalMrp - subtotal));

  return {
    totalItems,
    totalMrp,
    discount,
    subtotal,
    totalTaxable,
    totalCgst,
    totalSgst,
    totalIgst,
    totalGst,
    totalAmount,
  };
};

// product er kono level e (simple / variant / size / tier) price nai
const isPriceOnRequestProduct = (p) => {
  if (hasPrice(p.offerPrice) || hasPrice(p.mrp)) return false;
  if (productHasTiers(p)) return false;
  return !(p.variants || []).some(
    (v) =>
      hasPrice(v.offerPrice) ||
      hasPrice(v.mrp) ||
      (v.sizeVariants || []).some(
        (s) => hasPrice(s.offerPrice) || hasPrice(s.mrp),
      ),
  );
};

// offer price ache kintu MRP nai (simple / variant / size)
const hasOfferWithoutMrp = (row) =>
  isBlank(row?.mrp) && !isBlank(row?.offerPrice);

const findOfferWithoutMrp = (body) =>
  hasOfferWithoutMrp(body) ||
  (Array.isArray(body.variants) ? body.variants : []).some(
    (v) =>
      hasOfferWithoutMrp(v) ||
      (Array.isArray(v?.sizeVariants) ? v.sizeVariants : []).some(
        hasOfferWithoutMrp,
      ),
  );

module.exports = {
  round2,
  hasPrice,
  isBlank,
  QUOTE_PENDING_STATUSES,
  computeTotals,
  isPriceOnRequestProduct,
  findOfferWithoutMrp,
};