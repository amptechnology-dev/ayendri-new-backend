const mongoose = require("mongoose");
const { model } = mongoose;

const storeSettingSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      unique: true,
    },
    hasStockManagement: { type: Boolean, default: false },
    storeBusinessType: {
      type: String,
      enum: ["RETAIL", "MADE_FOR_PRODUCT", "BOTH"],
    },
    // [DELIVERY] false hole ei store e delivery estimate / shipping charge / courier / pincode check kichu thakbe na
    hasDelivery: { type: Boolean, default: true },
    // [PAYMENT] BOTH = COD + Online, ONLINE_ONLY = payment age (COD bondho), OFF = app e kono payment nei
    // NOTE: ekhane kono default deini. Default na thakle purono paymentFirst theke hishab hoy (storePolicy.js)
    paymentMode: { type: String, enum: ["BOTH", "ONLINE_ONLY", "OFF"] },
    // purono field (paymentMode er age eta chilo). Notun code paymentMode er upor nirbhor kore
    paymentFirst: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const StoreSettingModel = model("StoreSetting", storeSettingSchema);
module.exports = StoreSettingModel;