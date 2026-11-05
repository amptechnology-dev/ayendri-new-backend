const mongoose = require("mongoose");
const { model } = mongoose;

const CATEGORY_TYPES = ["PRODUCT", "SERVICE"];

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    type: {
      type: String,
      enum: CATEGORY_TYPES,
      default: "PRODUCT",
      index: true,
    },
    description: { type: String, default: "" },
    image: { type: String, default: "" },
    icon: { type: String, trim: true, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// same name is allowed once per type (e.g. "Repair" as PRODUCT and as SERVICE)
categorySchema.index({ storeId: 1, type: 1, name: 1 }, { unique: true });

const CategoryModel = model("Category", categorySchema);

module.exports = CategoryModel;
module.exports.CATEGORY_TYPES = CATEGORY_TYPES;
