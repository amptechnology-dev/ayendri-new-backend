const { getStorePolicy } = require("./storePolicy.js");
const { getStoreBusinessType } = require("./storeSettings.js");

const PRODUCT_TYPES = ["PRODUCT", "SERVICE"];
const POLICY_KEYS = [
  "productType",
  "isReturnable",
  "returnDays",
  "isReplaceable",
  "replaceDays",
  "isRefundable",
  "refundDays",
];

const isBlank = (v) => v === undefined || v === null || v === "";
const toBool = (v) => v === true || String(v).trim().toLowerCase() === "true";

// days faka hole null (delivery agent / store decide kore), noile 1..365 whole number
const parseDays = (v, label) => {
  if (isBlank(v)) return { days: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    return { error: `${label} must be a whole number between 1 and 365` };
  }
  return { days: n };
};

// body theke policy parse + validate.
// return: { error: {field, message} } | { policy } | { policy: null } (update e policy field na ashle)
const parseProductPolicy = (body, { currentType = null } = {}) => {
  const touched = POLICY_KEYS.some((k) => body[k] !== undefined);
  if (!touched && currentType) return { policy: null };

  const productType = String(
    body.productType || currentType || "PRODUCT",
  ).toUpperCase();
  if (!PRODUCT_TYPES.includes(productType)) {
    return { error: { field: "productType", message: "Invalid product type" } };
  }
  const isService = productType === "SERVICE";

  // service e return / replace nei, shudhu cancel + refund (booking date er age)
  const isReturnable = !isService && toBool(body.isReturnable);
  const isReplaceable = !isService && toBool(body.isReplaceable);
  const isRefundable = toBool(body.isRefundable);

  const ret = isReturnable
    ? parseDays(body.returnDays, "Return days")
    : { days: null };
  const rep = isReplaceable
    ? parseDays(body.replaceDays, "Replace days")
    : { days: null };
  const ref =
    isRefundable && !isService
      ? parseDays(body.refundDays, "Refund days")
      : { days: null };

  const failed = [
    [ret, "returnDays"],
    [rep, "replaceDays"],
    [ref, "refundDays"],
  ].find(([r]) => r.error);
  if (failed) {
    return { error: { field: failed[1], message: failed[0].error } };
  }

  if (isRefundable && !isService && ref.days === null) {
    return {
      error: {
        field: "refundDays",
        message: "Refund days is required for a refundable product",
      },
    };
  }

  return {
    policy: {
      productType,
      isReturnable,
      returnDays: ret.days,
      isReplaceable,
      replaceDays: rep.days,
      isRefundable,
      refundDays: ref.days,
    },
  };
};

// order place er somoy item e snapshot (pore product edit korleo purono order change hobe na)
const snapshotPolicy = (product) => ({
  productType: product?.productType === "SERVICE" ? "SERVICE" : "PRODUCT",
  isReturnable: product?.isReturnable === true,
  returnDays: product?.returnDays ?? null,
  isReplaceable: product?.isReplaceable === true,
  replaceDays: product?.replaceDays ?? null,
  isRefundable: product?.isRefundable === true,
  refundDays: product?.refundDays ?? null,
});

// public product API te store er settings
const getPublicStoreSettings = async (storeId) => {
  const [policy, storeBusinessType] = await Promise.all([
    getStorePolicy(storeId),
    getStoreBusinessType(storeId),
  ]);
  return {
    paymentMode: policy.paymentMode,
    codAvailable: policy.codAllowed,
    onlineAvailable: policy.onlineAllowed,
    paymentOff: policy.paymentMode === "OFF",
    hasDelivery: policy.hasDelivery,
    storeBusinessType,
  };
};

module.exports = {
  PRODUCT_TYPES,
  parseProductPolicy,
  snapshotPolicy,
  getPublicStoreSettings,
};