const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Banner name is required"],
      trim: true,
    },
    image: {
      type: String,
      required: [true, "Banner media is required"],
    },
    mediaType: {
      type: String,
      enum: ["image", "video"],
      default: "image",
    },
    isActive: { type: Boolean, default: true },
    // true hole eta offer banner (public offer API te ashbe + user ke notification jabe)
    offerBanner: { type: Boolean, default: false },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    // optional: khali array = "general" banner, nahole ekadhik category
    categoryIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Category",
      },
    ],
    // optional: banner e click korle ei product e jabe
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

bannerSchema.index({ storeId: 1, categoryIds: 1, isActive: 1, createdAt: -1 });
bannerSchema.index({ offerBanner: 1, isActive: 1, createdAt: -1 });
bannerSchema.index({ productId: 1 });

const BannerModel = mongoose.model("Banner", bannerSchema);
module.exports = BannerModel;