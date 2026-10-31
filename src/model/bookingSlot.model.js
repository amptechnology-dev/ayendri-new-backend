const mongoose = require("mongoose");

// ekta service product er ekta date e koyta booking hoyeche
const bookingSlotSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    count: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

// upsert + limit check er race-guard ei unique index er upor dariye ache
bookingSlotSchema.index({ productId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model("BookingSlot", bookingSlotSchema);