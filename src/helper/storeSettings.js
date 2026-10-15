const StoreSettingModel = require("../model/storeSetting.model.js");

const DEFAULT_SETTINGS = {
  hasStockManagement: false,
};

const STORE_BUSINESS_TYPES = ["RETAIL", "MADE_FOR_PRODUCT", "BOTH"];

// settings doc theke store type ber kore. Notun field na thakle purono hasStockManagement theke
const resolveBusinessType = (settings) => {
  if (settings && STORE_BUSINESS_TYPES.includes(settings.storeBusinessType)) {
    return settings.storeBusinessType;
  }
  return settings?.hasStockManagement ? "RETAIL" : "MADE_FOR_PRODUCT";
};

const getStoreBusinessType = async (storeId) => {
  const settings = await StoreSettingModel.findOne({ storeId })
    .select("storeBusinessType hasStockManagement")
    .lean();
  return resolveBusinessType(settings);
};

// store level hasStockManagement flag er sathe sync rakhar jonno
// (RETAIL / BOTH e stock ache, MADE_FOR_PRODUCT e nei)
const businessTypeToStockFlag = (type) => type !== "MADE_FOR_PRODUCT";

// product create er somoy: ei product e stock thakbe kina
//  RETAIL           -> shob product e stock
//  MADE_FOR_PRODUCT -> kono product e stock nei
//  BOTH             -> product made-for-product hole stock nei, na hole stock
const resolveProductStockManaged = (type, isMadeForProduct) => {
  if (type === "RETAIL") return true;
  if (type === "MADE_FOR_PRODUCT") return false;
  return !isMadeForProduct;
};

// purono code er jonno rakha holo
const getStockManagementEnabled = async (storeId) => {
  const type = await getStoreBusinessType(storeId);
  return businessTypeToStockFlag(type);
};

const setStoreBusinessType = (storeId, type) =>
  StoreSettingModel.findOneAndUpdate(
    { storeId },
    {
      $set: {
        storeBusinessType: type,
        hasStockManagement: businessTypeToStockFlag(type),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

// Sudhu explicit `true` hole-i stock managed.
// false / undefined / null shob OFF -> stock check, decrement, out-of-stock kichu hobe na.
const isStockManaged = (product) => product?.hasStockManagement === true;

module.exports = {
  DEFAULT_SETTINGS,
  STORE_BUSINESS_TYPES,
  resolveBusinessType,
  getStoreBusinessType,
  businessTypeToStockFlag,
  setStoreBusinessType,
  resolveProductStockManaged,
  getStockManagementEnabled,
  isStockManaged,
};