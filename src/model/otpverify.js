const mongoose = require("mongoose");

const emailVerificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  otp: {
    type: String,
    required: true,
  },
  purpose: {
    type: String,
    enum: ["SIGNUP", "FORGOT_PASSWORD"],
    default: "SIGNUP",
  },
  attempts: {
    type: Number,
    default: 0,
  },
  verified: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: "15m",
  },
});

emailVerificationSchema.index({ userId: 1, purpose: 1 });

const EmailVerificationModel = mongoose.model(
  "EmailVerification",
  emailVerificationSchema,
);

module.exports = EmailVerificationModel;
