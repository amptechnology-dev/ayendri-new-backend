const mongoose = require("mongoose");
const { model } = mongoose;

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
    },
    description: { type: String, default: "" },

    image: { type: String, default: "" },

    icon: { type: String, trim: true, default: "" },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

categorySchema.index({ storeId: 1, name: 1 }, { unique: true });

const CategoryModel = model("Category", categorySchema);

module.exports = CategoryModel;
