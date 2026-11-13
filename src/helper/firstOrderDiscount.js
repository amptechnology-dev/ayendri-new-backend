const StoreSettingModel = require("../model/storeSetting.model.js");
const OrderModel = require("../model/order.model.js");
const CheckoutSessionModel = require("../model/checkoutSession.model.js");

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// mobile app header pathabe: X-Client-Platform: mobile
const getClientPlatform = (req) => {
  const v = String(req.headers["x-client-platform"] || "")
    .trim()
    .toLowerCase();
  return v === "mobile" ? "MOBILE" : "WEB";
};

const TYPES = ["PRODUCT", "SERVICE"];

/**
 * totalsByType: { PRODUCT: 1000, SERVICE: 500 } (GST soho, shipping baad)
 * Protita type er jonno alada check: oi store e oi type er ager order nai + payment pending session nai.
 * Eligible hole { percent, amount, platform, breakdown } ferot dey, na hole null.
 */
const resolveFirstOrderDiscount = async ({
  userId,
  storeId,
  platform,
  totalsByType,
  priceStatus,
}) => {
  try {
    if (platform !== "MOBILE") return null;
    if (priceStatus && priceStatus !== "NOT_REQUIRED") return null;

    const setting = await StoreSettingModel.findOne({ storeId })
      .select("mobileFirstOrderDiscount")
      .lean();
    const cfg = setting?.mobileFirstOrderDiscount;
    if (!cfg) return null;

    const candidates = TYPES.filter((type) => {
      const c = cfg[type.toLowerCase()];
      return (
        c?.enabled === true &&
        Number(c.percent) > 0 &&
        Number(totalsByType?.[type]) > 0
      );
    });
    if (candidates.length === 0) return null;

    const eligible = await Promise.all(
      candidates.map(async (type) => {
        const isService = type === "SERVICE";
        const [hasOrder, hasOpenSession] = await Promise.all([
          OrderModel.exists({
            userId,
            storeId,
            status: { $ne: "CANCELLED" },
            hasService: isService ? true : { $ne: true },
          }),
          CheckoutSessionModel.exists({
            userId,
            storeId,
            status: "PENDING",
            expiresAt: { $gt: new Date() },
            "orderPayload.hasService": isService ? true : { $ne: true },
          }),
        ]);
        return hasOrder || hasOpenSession ? null : type;
      }),
    );

    const breakdown = eligible
      .filter(Boolean)
      .map((type) => {
        const base = Number(totalsByType[type]);
        const percent = Number(cfg[type.toLowerCase()].percent);
        const amount = round2(Math.min(base, (base * percent) / 100));
        return { productType: type, percent, amount };
      })
      .filter((b) => b.amount > 0);

    if (breakdown.length === 0) return null;

    return {
      // ekta type hole sei percent, duto type mix hole null (breakdown dekho)
      percent: breakdown.length === 1 ? breakdown[0].percent : null,
      amount: round2(breakdown.reduce((t, b) => t + b.amount, 0)),
      platform,
      breakdown,
    };
  } catch (e) {
    console.error("First order discount error:", e.message);
    return null;
  }
};

module.exports = { getClientPlatform, resolveFirstOrderDiscount };