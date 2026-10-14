const mongoose = require("mongoose");

const storeVisitSchema = new mongoose.Schema(
  {
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
    lastVisitedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

storeVisitSchema.index({ userId: 1, storeId: 1 }, { unique: true });
storeVisitSchema.index({ storeId: 1 });

module.exports = mongoose.model("StoreVisit", storeVisitSchema);
