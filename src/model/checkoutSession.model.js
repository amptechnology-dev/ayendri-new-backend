const mongoose = require("mongoose");

const attemptSchema = new mongoose.Schema(
  {
    txnid: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["INITIATED", "SUCCESS", "FAILED"],
      default: "INITIATED",
    },
    mihpayid: { type: String, default: null },
    mode: { type: String, default: null },
    bankRefNum: { type: String, default: null },
    errorMessage: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date, default: null },
  },
  { _id: false },
);

const checkoutSessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
    storeName: { type: String, default: null },

    amount: { type: Number, required: true, min: 0 }, // payable (items + shipping)
    itemsTotal: { type: Number, default: 0 },
    shippingCharge: { type: Number, default: 0 },

    // payment success hole OrderModel.create e ei payload-i jabe
    orderPayload: { type: mongoose.Schema.Types.Mixed, required: true },

    // hold kora stock / booking slot (fail ba expire hole ferot dibo)
    stockLines: { type: [mongoose.Schema.Types.Mixed], default: [] },
    bookingSlotProductIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    bookingYmd: { type: String, default: null },

    // payment success hole cart theke ei item gulo remove hobe
    cartId: { type: mongoose.Schema.Types.ObjectId, default: null },
    cartItemIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },

    status: {
      type: String,
      enum: ["PENDING", "PAID", "EXPIRED", "REFUND_REQUIRED"],
      default: "PENDING",
    },
    attempts: { type: [attemptSchema], default: [] },
    paidAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
  },
  { timestamps: true, minimize: false },
);

checkoutSessionSchema.index({ userId: 1, createdAt: -1 });
checkoutSessionSchema.index({ status: 1, expiresAt: 1 });
checkoutSessionSchema.index({ "attempts.txnid": 1 });

module.exports = mongoose.model("CheckoutSession", checkoutSessionSchema);