const mongoose = require("mongoose");

const companySchema = new mongoose.Schema(
  {
    singletonKey: {
      type: String,
      default: "COMPANY_INFO",
      unique: true,
      immutable: true,
      select: false,
    },

    companyName: { type: String, required: true, trim: true },
    companyPhone: { type: String, required: true, trim: true },
    // optional now
    companyEmail: { type: String, trim: true, lowercase: true },

    whatsappNo: { type: String, trim: true },
    supportPhone: { type: String, trim: true },
    supportEmail: { type: String, trim: true, lowercase: true },
    website: { type: String, trim: true },
    description: { type: String, trim: true },

    address: {
      addressLine: String,
      area: String,
      city: String,
      state: String,
      pincode: String,
      country: String,
    },

    socialLinks: {
      facebookUrl: String,
      instagramUrl: String,
      twitterUrl: String,
      linkedinUrl: String,
      youtubeUrl: String,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      select: false,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Company", companySchema);