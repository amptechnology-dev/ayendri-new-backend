const mongoose = require("mongoose");

const storeActionSchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    actionType: {
      type: String,
      enum: ["WEBSITE", "WHATSAPP", "CALL", "DIRECTION", "SHARE"],
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("StoreAction", storeActionSchema);
