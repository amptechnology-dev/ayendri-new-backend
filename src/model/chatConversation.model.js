const mongoose = require("mongoose");
const { model } = mongoose;

const chatConversationSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    name: { type: String, trim: true, default: "" },
    phoneNumber: { type: String, trim: true, index: true, default: "" },
    status: { type: String, enum: ["active", "closed"], default: "active" },
    lastMessageAt: { type: Date, default: Date.now },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
      index: true,
    },

    // NEW
    mode: { type: String, enum: ["bot", "human"], default: "bot", index: true },
    handledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    lastMessagePreview: { type: String, default: "" },
    unreadByStore: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = model("ChatConversation", chatConversationSchema);
