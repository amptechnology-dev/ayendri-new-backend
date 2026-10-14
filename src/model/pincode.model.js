const mongoose = require("mongoose");

const pincodeSchema = new mongoose.Schema(
  {
    pincode: { type: String, required: true, unique: true, trim: true },
    area: { type: String, trim: true },
    district: { type: String, trim: true },
    state: { type: String, trim: true },
    // GeoJSON: coordinates = [longitude, latitude]
    source: {
      type: String,
      enum: ["GEONAMES", "PREFIX_5", "PREFIX_4", "PREFIX_3"],
      default: "GEONAMES",
    },
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },
  },
  { timestamps: false },
);

// radius query ($geoWithin) er jonno
pincodeSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("Pincode", pincodeSchema);