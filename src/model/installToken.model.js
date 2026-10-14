const mongoose = require("mongoose");

const installTokenSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true },
    storeUniqueId: { type: String, required: true },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
    claimed: { type: Boolean, default: false },
    claimedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// expiresAt por MongoDB nijei document delete kore dibe
installTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
installTokenSchema.index({ ip: 1, claimed: 1, createdAt: -1 });

module.exports = mongoose.model("InstallToken", installTokenSchema);