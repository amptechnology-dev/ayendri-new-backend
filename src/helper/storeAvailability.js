const StoreModel = require("../model/store.model.js");

const STORE_UNAVAILABLE_MESSAGE = "This store is not present in this application";
const AVAILABLE_STORE_FILTER = { isActive: true, isVerify: true };

const isStoreAvailable = async (storeId) =>
  !!(await StoreModel.exists({ _id: storeId, ...AVAILABLE_STORE_FILTER }));

// storeId chhara list fetch hole, shudhu available store-er data dekhate
const getAvailableStoreIds = () =>
  StoreModel.distinct("_id", AVAILABLE_STORE_FILTER);

const sendStoreUnavailable = (res) =>
  res.status(404).json({ success: false, message: STORE_UNAVAILABLE_MESSAGE });

module.exports = {
  STORE_UNAVAILABLE_MESSAGE,
  AVAILABLE_STORE_FILTER,
  isStoreAvailable,
  getAvailableStoreIds,
  sendStoreUnavailable,
};