const mongoose = require("mongoose");

const NOTIFICATION_TYPES = [
  // store side
  "NEW_ORDER",
  "ORDER_CANCELLED",
  "NEW_REVIEW",
  // user side
  "ORDER_PLACED",
  "ORDER_CONFIRMED",
  "ORDER_SHIPPED",
  "ORDER_DELIVERED",
  "NEW_OFFER",
  "PRICE_QUOTED",
  "REVIEW_REPLY",
  // chat / ticket
  "AGENT_REQUESTED",
  "TICKET_RAISED",
  "TICKET_UPDATED",
   "AGENT_REQUESTED",
  "TICKET_RAISED",
  "TICKET_UPDATED",
  "TICKET_RAISED_BY_USER",
  "TICKET_CLOSED_BY_USER",
];

const notificationSchema = new mongoose.Schema(
  {
    // store notification hole storeId, user notification hole userId
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      default: null,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    type: {
      type: String,
      enum: NOTIFICATION_TYPES,
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order" },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    reviewId: { type: mongoose.Schema.Types.ObjectId },
    // NEW_OFFER notification er jonno
    bannerId: { type: mongoose.Schema.Types.ObjectId, ref: "Banner" },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: "Ticket" },
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatConversation",
    },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, enum: ["image", "video", null], default: null },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// storeId ba userId, duitar moddhe ekta must
notificationSchema.pre("validate", function () {
  if (!this.storeId && !this.userId) {
    throw new Error("Notification must have storeId or userId");
  }
});

notificationSchema.index({ storeId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ storeId: 1, isRead: 1 });
notificationSchema.index({ userId: 1, isRead: 1 });

module.exports = mongoose.model("Notification", notificationSchema);
