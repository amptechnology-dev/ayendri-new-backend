const mongoose = require("mongoose");

const appReleaseSchema = new mongoose.Schema(
  {
    appName: {
      type: String,
      required: [true, "App name is required"],
      trim: true,
    },
    version: {
      type: String,
      required: [true, "Version is required"],
      trim: true,
    },
    apkUrl: {
      type: String,
      required: [true, "APK url is required"],
    },
    fileName: { type: String, default: "" },
    fileSize: { type: Number, default: 0 },
    releaseNotes: { type: String, default: "", trim: true },
    isActive: { type: Boolean, default: true },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

// ekta version duibar na
appReleaseSchema.index({ version: 1 }, { unique: true });
appReleaseSchema.index({ isActive: 1, createdAt: -1 });

module.exports = mongoose.model("AppRelease", appReleaseSchema);
