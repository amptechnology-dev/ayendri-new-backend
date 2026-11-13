const mongoose = require("mongoose");
const { model } = mongoose;

const chatMessageSchema = new mongoose.Schema(
  {
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: "ChatConversation", required: true, index: true },
    role: { type: String, enum: ["user", "assistant", "store"], required: true }, 
    content: { type: String, required: true, trim: true },
    senderId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, 
    canRaiseTicket: { type: Boolean, default: false }, 
  },
  { timestamps: true },
);

module.exports = model("ChatMessage", chatMessageSchema);