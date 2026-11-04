const mongoose = require("mongoose");
const { model } = mongoose;

const chatMessageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatConversation",
      required: true,
      index: true,
    },
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

module.exports = model("ChatMessage", chatMessageSchema);