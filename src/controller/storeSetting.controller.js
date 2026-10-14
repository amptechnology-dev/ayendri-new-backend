const StoreModel = require("../model/store.model.js");
const StoreSettingModel = require("../model/storeSetting.model.js");
const { updateStoreSettingSchema } = require("../schema/storeSetting.schema.js");
const { DEFAULT_SETTINGS } = require("../helper/storeSettings.js");
const { resolvePaymentMode } = require("../helper/storePolicy.js");

const resolveStore = async (userId, storeId) => {
  if (storeId) return StoreModel.findOne({ _id: storeId, userId });
  return StoreModel.findOne({ userId });
};

// setting doc na thakle ba purono doc e notun field na thakle default
const toPayload = (settings) => {
  const paymentMode = resolvePaymentMode(settings);
  return {
    hasStockManagement: settings
      ? settings.hasStockManagement
      : DEFAULT_SETTINGS.hasStockManagement,
    hasDelivery: settings ? settings.hasDelivery !== false : true,
    paymentMode,
    paymentFirst: paymentMode === "ONLINE_ONLY",
  };
};

const getStoreSettingsController = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const store = await resolveStore(userId, req.query.storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: "Store not found" });
    }

    const settings = await StoreSettingModel.findOne({ storeId: store._id });

    return res.status(200).json({
      success: true,
      storeId: store._id,
      settings: toPayload(settings),
    });
  } catch (error) {
    console.error("Get Store Settings Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

const updateStoreSettingsController = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const storeId = req.body.storeId || req.query.storeId;
    const store = await resolveStore(userId, storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: "Store not found" });
    }

    const parsed = updateStoreSettingSchema.parse(req.body);

    const $set = { ...parsed };
    // purono paymentFirst field ke paymentMode er sathe mil rakhi
    if (parsed.paymentMode) {
      $set.paymentFirst = parsed.paymentMode === "ONLINE_ONLY";
    }

    const settings = await StoreSettingModel.findOneAndUpdate(
      { storeId: store._id },
      { $set },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      success: true,
      message: "Store settings updated successfully",
      settings: toPayload(settings),
    });
  } catch (error) {
    if (error.name === "ZodError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((err) => ({
          field: err.path.join("."),
          message: err.message,
        })),
      });
    }
    console.error("Update Store Settings Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { getStoreSettingsController, updateStoreSettingsController };