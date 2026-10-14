const StoreSettingModel = require("../model/storeSetting.model.js");

const PAYMENT_MODES = ["BOTH", "ONLINE_ONLY", "OFF"];
const COD_NOT_ALLOWED_MESSAGE = "This store accepts online payment only";

// paymentMode na thakle purono paymentFirst theke
const resolvePaymentMode = (s) => {
  if (!s) return "BOTH";
  if (PAYMENT_MODES.includes(s.paymentMode)) return s.paymentMode;
  return s.paymentFirst === true ? "ONLINE_ONLY" : "BOTH";
};

// store er delivery / payment niyom. Setting doc na thakle default: delivery ON, COD + Online
const getStorePolicy = async (storeId) => {
  const s = await StoreSettingModel.findOne({ storeId })
    .select("hasDelivery paymentMode paymentFirst")
    .lean();

  const paymentMode = resolvePaymentMode(s);

  return {
    hasDelivery: s ? s.hasDelivery !== false : true,
    paymentMode,
    paymentFirst: paymentMode === "ONLINE_ONLY",
    paymentOff: paymentMode === "OFF",
    codAllowed: paymentMode === "BOTH", // customer COD select korte parbe kina
    onlineAllowed: paymentMode !== "OFF",
  };
};

/**
 * Customer er chaoya payment method ke store er mode onujayi thik kore.
 *  BOTH        : customer ja chay
 *  ONLINE_ONLY : COD chaile reject
 *  OFF         : app e payment nei. Order "COD" hishebe save hoy, paymentOff = true (taka store er sathe shoja)
 */
const resolvePaymentForStore = (policy, requestedMethod) => {
  const requested = requestedMethod === "COD" ? "COD" : "ONLINE";

  if (policy.paymentMode === "OFF") {
    return { ok: true, method: "COD", paymentOff: true };
  }
  if (policy.paymentMode === "ONLINE_ONLY" && requested === "COD") {
    return {
      ok: false,
      code: "COD_NOT_ALLOWED",
      message: COD_NOT_ALLOWED_MESSAGE,
    };
  }
  return { ok: true, method: requested, paymentOff: false };
};

module.exports = {
  PAYMENT_MODES,
  COD_NOT_ALLOWED_MESSAGE,
  resolvePaymentMode,
  getStorePolicy,
  resolvePaymentForStore,
};