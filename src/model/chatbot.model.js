const mongoose = require("mongoose");
const { model } = mongoose;

const chatbotFaqSchema = new mongoose.Schema(
  {
    // kon store er FAQ. null hole sob store er jonno (global)
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },
    question: { type: String, required: true, trim: true, maxlength: 500 },
    keywords: [{ type: String, trim: true, lowercase: true }],
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
    category: { type: String, default: "general" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = model("ChatbotFaq", chatbotFaqSchema);