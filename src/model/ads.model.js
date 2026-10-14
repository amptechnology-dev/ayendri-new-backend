const mongoose = require("mongoose");

const adsSchema = new mongoose.Schema(
  {
    mediaUrl: {
      type: String,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Ads", adsSchema);