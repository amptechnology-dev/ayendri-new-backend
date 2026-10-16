const mongoose = require("mongoose");

const termsConditionSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, "Title is required"],
      trim: true,
      maxlength: [150, "Title can not be more than 150 characters"],
    },
    // sanitized HTML (bold, bullet, ordered list etc.)
    description: {
      type: String,
      required: [true, "Description is required"],
    },
    // choto number age dekhabe
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

termsConditionSchema.index({ isActive: 1, order: 1, createdAt: 1 });

module.exports = mongoose.model("TermsCondition", termsConditionSchema);