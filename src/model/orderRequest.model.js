const mongoose = require("mongoose");
const { getNextSequence } = require("../helper/counter.js");

const REQUEST_TYPES = ["RETURN", "REPLACE", "REFUND"];
const REQUEST_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "COMPLETED"];

const bankDetailsSchema = new mongoose.Schema(
  {
    accountHolder: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifsc: { type: String, trim: true },
    bankName: { type: String, trim: true },
    upiId: { type: String, trim: true },
  },
  { _id: false },
);

const orderRequestSchema = new mongoose.Schema(
  {
    requestNumber: { type: String, unique: true },

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    orderNumber: { type: String },
    // whole-order cancel refund e null
    itemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    itemName: { type: String },
    itemImage: { type: String, default: null },
    quantity: { type: Number, default: 1 },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },

    type: { type: String, enum: REQUEST_TYPES, required: true },
    // CUSTOMER = user nijer request, ORDER_CANCEL = paid order cancel hoye auto toiri
    source: {
      type: String,
      enum: ["CUSTOMER", "ORDER_CANCEL"],
      default: "CUSTOMER",
    },
    reasonCode: { type: String, required: true },
    reason: { type: String, required: true, trim: true },

    status: { type: String, enum: REQUEST_STATUSES, default: "REQUESTED" },

    refundAmount: { type: Number, default: 0, min: 0 },
    bankDetails: { type: bankDetailsSchema, default: null },

    storeNote: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    referenceNo: { type: String, trim: true, default: null }, // refund UTR / txn id
    completeNote: { type: String, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

orderRequestSchema.index({ storeId: 1, status: 1, createdAt: -1 });
orderRequestSchema.index({ userId: 1, createdAt: -1 });
orderRequestSchema.index({ orderId: 1, itemId: 1, status: 1 });

orderRequestSchema.index(
  { orderId: 1, itemId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: { $in: ["REQUESTED", "APPROVED", "COMPLETED"] },
      itemId: { $type: "objectId" },
    },
  },
);

orderRequestSchema.pre("save", async function () {
  if (this.isNew && !this.requestNumber) {
    const seq = await getNextSequence("requestNumber");
    this.requestNumber = `REQ${String(seq).padStart(6, "0")}`;
  }
});

const OrderRequestModel = mongoose.model("OrderRequest", orderRequestSchema);

module.exports = { OrderRequestModel, REQUEST_TYPES, REQUEST_STATUSES };