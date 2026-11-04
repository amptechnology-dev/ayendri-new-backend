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

// store page theke chat hole oi store er public info AI ke dao
const getStoreContextForAI = async (storeId) => {
  if (!storeId) return "";
  const store = await StoreModel.findOne({ _id: storeId, ...AVAILABLE_STORE_FILTER })
    .select("storeName storeType description timingByDay supportNo whatsappNo address")
    .lean();
  if (!store) return "";

  const lines = [`- The customer is currently viewing the store "${store.storeName}" (${store.storeType}).`];
  if (store.description) lines.push(`- Store description: ${store.description}`);
  if (store.address?.area || store.address?.state)
    lines.push(`- Store location: ${[store.address.area, store.address.state].filter(Boolean).join(", ")}`);
  if (store.supportNo) lines.push(`- Store support number: ${store.supportNo}`);
  if (store.whatsappNo) lines.push(`- Store WhatsApp: ${store.whatsappNo}`);
  const days = Object.entries(store.timingByDay || {}).filter(([, v]) => v);
  if (days.length) lines.push(`- Store timings: ${days.map(([d, t]) => `${d}: ${t}`).join("; ")}`);
  return lines.join("\n");
};

module.exports = { getChatContextForAI, invalidateChatContextCache, getStoreContextForAI };