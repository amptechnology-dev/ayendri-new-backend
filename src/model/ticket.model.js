const mongoose = require("mongoose");
const { model } = mongoose;

const ticketSchema = new mongoose.Schema(
  {
    ticketNo: { type: String, required: true, unique: true, index: true }, // "42A31"
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatConversation",
      required: true,
      index: true,
    },
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      index: true,
    },

    customerName: { type: String, trim: true, default: "" },
    phoneNumber: { type: String, trim: true, default: "" },
    phoneKey: { type: String, index: true, default: "" }, // last 10 digits (customer match)

    subject: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },

    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    resolution: { type: String, trim: true, maxlength: 2000, default: "" },
    resolvedAt: { type: Date, default: null },

    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    unreadByUser: { type: Number, default: 0 },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
  },
  { timestamps: true },
);

ticketSchema.index({ storeId: 1, createdAt: -1 });

module.exports = model("Ticket", ticketSchema);
