const mongoose = require("mongoose");
const { getNextSequence } = require("../helper/counter.js");

const packagingDetailsSchema = new mongoose.Schema(
  {
    expectedDeliveryDays: { type: Number, min: 0 },
    length: { type: Number, min: 0 },
    breadth: { type: Number, min: 0 },
    height: { type: Number, min: 0 },
    weight: { type: Number, min: 0 },
  },
  { _id: false },
);

const gstSchema = new mongoose.Schema(
  {
    cgst: { type: Number, min: 0, max: 100, default: null },
    sgst: { type: Number, min: 0, max: 100, default: null },
    igst: { type: Number, min: 0, max: 100, default: null },
  },
  { _id: false },
);

// quantity based price: minQty..maxQty er jonno per-unit price
const priceTierSchema = new mongoose.Schema(
  {
    minQty: { type: Number, required: true, min: 1 },
    maxQty: { type: Number, default: null, min: 1 }, // null = no limit
    price: { type: Number, required: true, min: 0 }, // per unit price
  },
  { _id: false },
);

const offerPriceValidator = {
  validator: function (value) {
    if (value === undefined || value === null) return true;
    if (Array.isArray(this?.priceTiers) && this.priceTiers.length > 0) {
      return true;
    }
    return this.mrp === undefined || this.mrp === null || value <= this.mrp;
  },
  message: "Offer price cannot be greater than MRP",
};

// nested size/weight/height row inside a color variant
const sizeVariantSchema = new mongoose.Schema(
  {
    size: { type: String, trim: true },
    weight: { type: String, trim: true },
    height: { type: String, trim: true },
    // MRP optional: na dile "price on request"
    mrp: {
      type: Number,
      min: [0, "MRP must be >= 0"],
    },
    offerPrice: {
      type: Number,
      min: [0, "Offer price must be >= 0"],
      validate: offerPriceValidator,
    },
    openingStock: { type: Number, default: 0, min: 0 },
    currentStock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    packagingDetails: packagingDetailsSchema,
    gst: { type: gstSchema, default: undefined },
    priceTiers: { type: [priceTierSchema], default: [] },
  },
  { timestamps: false },
);

// top-level variant: flat (size/weight/height) OR color (optionally with nested sizeVariants)
const variantSchema = new mongoose.Schema(
  {
    color: { type: String, trim: true },
    images: [{ type: String }],

    size: { type: String, trim: true },
    weight: { type: String, trim: true },
    height: { type: String, trim: true },

    // MRP optional: na dile "price on request"
    mrp: {
      type: Number,
      min: [0, "MRP must be >= 0"],
    },
    offerPrice: {
      type: Number,
      min: [0, "Offer price must be >= 0"],
      validate: offerPriceValidator,
    },

    openingStock: { type: Number, default: 0, min: 0 },
    currentStock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    sku: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    packagingDetails: packagingDetailsSchema,
    gst: { type: gstSchema, default: undefined },
    priceTiers: { type: [priceTierSchema], default: [] },

    sizeVariants: { type: [sizeVariantSchema], default: [] },
  },
  { timestamps: false },
);

const reviewSchema = new mongoose.Schema(
  {
    comment: { type: String, trim: true },
    rating: {
      type: Number,
      required: [true, "Rating is required"],
      min: [1, "Rating must be at least 1"],
      max: [5, "Rating cannot be more than 5"],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    image: { type: String, default: null },
  },
  { timestamps: true },
);

const productSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
    },
    productCode: { type: String, unique: true },
    description: {
      type: String,
      required: [true, "Product description is required"],
      trim: true,
    },
    unit: { type: String, required: [true, "Unit is required"], trim: true },
    deliveryTime: { type: String, trim: true },

    images: [{ type: String }],

    // simple (no-variant) product fields
    mrp: { type: Number, min: [0, "MRP must be >= 0"] },
    offerPrice: { type: Number, min: [0, "Offer price must be >= 0"] },
    openingStock: { type: Number, default: 0, min: 0 },
    currentStock: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    hasLowStock: { type: Boolean, default: false, index: true },
    packagingDetails: packagingDetailsSchema,
    gst: { type: gstSchema, default: undefined },
    priceTiers: { type: [priceTierSchema], default: [] },

    variants: { type: [variantSchema], default: [] },

    hasVariants: { type: Boolean, default: false },
    hasColor: { type: Boolean, default: false },
    hasStockManagement: { type: Boolean, default: true },
    isMadeForProduct: { type: Boolean, default: false },
    gstInclusive: { type: Boolean, default: false },
    hsnCode: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    reviews: [reviewSchema],
    averageRating: { type: Number, default: 0, min: 0, max: 5 },
    totalReviews: { type: Number, default: 0 },
  },
  { timestamps: true },
);

productSchema.pre("save", async function () {
  if (this.isNew && !this.productCode) {
    const seq = await getNextSequence("productCode");
    this.productCode = `PRD${String(seq).padStart(6, "0")}`;
  }
});

const ProductModel = mongoose.model("Product", productSchema);
module.exports = ProductModel;