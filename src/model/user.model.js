const mongoose = require("mongoose");
const { model } = mongoose;

const addressSchema = new mongoose.Schema({
  label: {
    type: String,
    enum: ["HOME", "WORK", "OTHER"],
    default: "HOME",
  },
  addressLine: { type: String, required: true, trim: true },
  area: { type: String, trim: true },
  city: { type: String, required: true, trim: true },
  state: { type: String, required: true, trim: true },
  pincode: { type: String, required: true, trim: true },
  country: { type: String, default: "India", trim: true },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    // unique: true shoriye deya hoyeche, uniqueness ekhon (email + role) index e
    email: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String },
    password: { type: String },
    role: {
      type: String,
      enum: ["ADMIN", "STORE", "USER"],
      default: "ADMIN",
    },
    googleId: { type: String },
    picture: { type: String },
    provider: {
      type: String,
      enum: ["LOCAL", "GOOGLE"],
      default: "LOCAL",
    },
    addresses: { type: [addressSchema], default: [] },
    isActive: { type: Boolean, default: true },
    isVerified: { type: Boolean, default: false },
    fcmTokens: { type: [String], default: [], select: false },
  },
  { timestamps: true },
);

// ekta email, ekta role e ekbar-i. Alada role e same email cholbe.
userSchema.index({ email: 1, role: 1 }, { unique: true });

const UserModel = model("User", userSchema);

module.exports = UserModel;
