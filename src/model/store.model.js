const mongoose = require("mongoose");
const { model } = mongoose;

const reviewSchema = new mongoose.Schema(
  {
    comment: { type: String },
    rating: { type: Number, min: 1, max: 5 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

const storeSchema = new mongoose.Schema(
  {
    storeName: {
      type: String,
      required: true,
    },
    storeType: {
      type: String,
      required: true,
    },

    storeUniqueId: {
      type: String,
      unique: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    images: [
      {
        type: String,
      },
    ],

    address: {
      area: String,
      state: String,
      country: String,
    },

    lat: Number,
    long: Number,

    contactNo: String,
    whatsappNo: String,
    supportNo: String,

    email: String,

    description: String,

    timingByDay: {
      sunday: String,
      monday: String,
      tuesday: String,
      wednesday: String,
      thursday: String,
      friday: String,
      saturday: String,
    },

    gstin: {
      type: String,
    },

    reviews: [reviewSchema],

    isActive: {
      type: Boolean,
      default: true,
    },

    isVerify: {
      type: Boolean,
      default: false,
    },
    isFeatured: {
      type: Boolean,
      default: false,
    },
    isVisitor: {
      type: Boolean,
      default: false,
    },
    viewCount: {
      type: Number,
      default: 0,
    },
    fcmTokens: [{ type: String }],
    qrCodeUrl: { type: String },
    qrCodeKey: { type: String },
  },
  { timestamps: true },
);

storeSchema.pre("save", function () {
  if (!this.storeUniqueId) {
    this.storeUniqueId = "STR-" + Date.now();
  }
});

const StoreModel = model("Store", storeSchema);

module.exports = StoreModel;
