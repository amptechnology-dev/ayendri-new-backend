const mongoose = require("mongoose");

const phoneOtpSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  purpose: { type: String, enum: ["LOGIN", "SIGNUP"], required: true },
  otpHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

// ekta phone + purpose e ekta-i active OTP
phoneOtpSchema.index({ phone: 1, purpose: 1 }, { unique: true });
// expire hole Mongo nijei delete kore dey
phoneOtpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("PhoneOtp", phoneOtpSchema);