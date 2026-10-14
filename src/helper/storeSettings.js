const StoreSettingModel = require("../model/storeSetting.model.js");

const DEFAULT_SETTINGS = {
  hasStockManagement: false,
};

const getStockManagementEnabled = async (storeId) => {
  const settings = await StoreSettingModel.findOne({ storeId })
    .select("hasStockManagement")
    .lean();
  return settings
    ? Boolean(settings.hasStockManagement)
    : DEFAULT_SETTINGS.hasStockManagement;
};

// Sudhu explicit `true` hole-i stock managed.
// false / undefined / null shob OFF -> stock check, decrement, out-of-stock kichu hobe na.
const isStockManaged = (product) => product?.hasStockManagement === true;

module.exports = { DEFAULT_SETTINGS, getStockManagementEnabled, isStockManaged };