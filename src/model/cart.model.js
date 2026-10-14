const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    // simple (non-variant) product hole variantId null thakbe
    variantId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    storeName: { type: String, default: null },
    quantity: {
      type: Number,
      required: true,
      min: [1, "Quantity must be at least 1"],
      validate: {
        validator: Number.isInteger,
        message: "Quantity must be a whole number",
      },
    },

    color: { type: String, default: null, trim: true },
    size: { type: String, default: null, trim: true },
    weight: { type: String, default: null, trim: true },
    height: { type: String, default: null, trim: true },

    name: { type: String, required: true },
    productCode: { type: String },
    image: { type: String, default: null },
    unit: { type: String },
    // price on request product e null thakbe (store order er por estimate dibe)
    mrp: { type: Number, default: null, min: 0 },
    offerPrice: { type: Number, default: null, min: 0 },
  },
  { timestamps: true },
);

const cartSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    items: [cartItemSchema],
  },
  { timestamps: true },
);

const CartModel = mongoose.model("Cart", cartSchema);

module.exports = CartModel;