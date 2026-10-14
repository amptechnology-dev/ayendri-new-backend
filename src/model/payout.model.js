const mongoose = require("mongoose");
const { getNextSequence } = require("../helper/counter.js");

const PAYOUT_METHODS = ["BANK_TRANSFER", "UPI", "CASH", "CHEQUE", "OTHER"];

const payoutSchema = new mongoose.Schema(
  {
    payoutNumber: { type: String, unique: true },

    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    amount: { type: Number, required: true, min: 0.01 },
    method: { type: String, enum: PAYOUT_METHODS, default: "BANK_TRANSFER" },
    referenceNo: { type: String, trim: true, default: null }, // UTR / txn id / cheque no
    note: { type: String, trim: true, default: null },
    paidAt: { type: Date, default: Date.now },

    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // payout dewar somoy er snapshot (history te kaje lage)
    balanceBefore: { type: Number, default: 0 },
    balanceAfter: { type: Number, default: 0 },

    // bhul entry hole delete na kore void kora hoy
    isVoided: { type: Boolean, default: false },
    voidReason: { type: String, default: null },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

payoutSchema.index({ storeId: 1, isVoided: 1, paidAt: -1 });

payoutSchema.pre("save", async function () {
  if (this.isNew && !this.payoutNumber) {
    const seq = await getNextSequence("payoutNumber");
    this.payoutNumber = `PAY${String(seq).padStart(6, "0")}`;
  }
});

const PayoutModel = mongoose.model("StorePayout", payoutSchema);

module.exports = { PayoutModel, PAYOUT_METHODS };