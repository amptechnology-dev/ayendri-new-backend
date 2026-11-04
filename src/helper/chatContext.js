const StoreModel = require("../model/store.model.js");
const ProductModel = require("../model/product.model.js");
const { AVAILABLE_STORE_FILTER } = require("./storeAvailability.js");

let cached = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const getChatContextForAI = async ({ forceRefresh = false } = {}) => {
  const now = Date.now();
  if (!forceRefresh && cached && cacheExpiresAt > now) return cached;

  const [storeCount, productCount] = await Promise.all([
    StoreModel.countDocuments(AVAILABLE_STORE_FILTER),
    ProductModel.countDocuments({ isActive: true, isVerified: true }),
  ]);

  cached = [
    `- AYENDRI is a multi-store marketplace with ${storeCount} active stores and ${productCount} live listings.`,
    "- Product prices are set by each store and shown on the product page. Some items are 'price on request': the store sends an estimate which the customer accepts or rejects before the order is confirmed.",
    "- Payment: depends on the store. Online payment (must be completed within 30 minutes of placing the order) and/or Cash on Delivery.",
    "- Delivery: depends on the store. Local stores deliver themselves; other orders ship by courier across India. Shipping charge and ETA are shown at checkout, and a 'fastest delivery' option may be available.",
    "- Services (e.g. puja bookings) need a future booking date; stores may limit bookings per day.",
    "- Orders go through: Pending -> Confirmed -> Shipped -> Delivered. Customers can cancel before shipping. Paid orders cancelled by the customer are refunded to the bank/UPI details given.",
    "- Return / replace / refund requests are raised from 'My Orders' and decided by the store.",
    "- Order tracking is available in 'My Orders'.",
  ].join("\n");

  cacheExpiresAt = now + CACHE_TTL_MS;
  return cached;
};

const invalidateChatContextCache = () => {
  cached = null;
  cacheExpiresAt = 0;
};

module.exports = { getChatContextForAI, invalidateChatContextCache };