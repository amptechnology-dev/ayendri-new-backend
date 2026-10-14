const mongoose = require("mongoose");
const { model } = mongoose;

const recentSearchSchema = new mongoose.Schema(
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
  },
  {
    timestamps: true,
  },
);

recentSearchSchema.index({ userId: 1, storeId: 1 }, { unique: true });

const RecentSearchModel = model("RecentSearch", recentSearchSchema);

module.exports = RecentSearchModel;
