const mongoose = require("mongoose");

const stockLogSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    // which exact stock unit inside the product changed
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sizeVariantId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // snapshot labels so logs are readable without populate
    productName: { type: String },
    variantLabel: { type: String, default: "Default" },

    type: {
      type: String,
      enum: ["IN", "OUT", "ADJUSTMENT", "OPENING"],
      required: true,
    },
    reason: {
      type: String,
      enum: [
        "PRODUCT_CREATE",
        "PRODUCT_UPDATE",
        "MANUAL_ADD",
        "MANUAL_REDUCE",
        "MANUAL_SET",
        "SALE",
        "OTHER",
      ],
      default: "OTHER",
    },
    note: { type: String, trim: true },

    quantityChanged: { type: Number, required: true }, 
    previousStock: { type: Number, required: true, min: 0 },
    newStock: { type: Number, required: true, min: 0 },
  },
  { timestamps: true },
);

stockLogSchema.index({ productId: 1, createdAt: -1 });

const StockLogModel = mongoose.model("StockLog", stockLogSchema);
module.exports = StockLogModel;