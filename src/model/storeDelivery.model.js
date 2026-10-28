const mongoose = require("mongoose");

const DURATION_UNITS = ["MINUTES", "HOURS", "DAYS"];

// radius er moddhe distance onujayi charge + somoy (store nijer set kore)
const localSlabSchema = new mongoose.Schema(
  {
    upToKm: { type: Number, required: true, min: 0 }, // ei km porjonto
    charge: { type: Number, required: true, min: 0 }, // delivery charge (0 = free)
    etaValue: { type: Number, required: true, min: 0 }, // UI te dewa value
    etaUnit: { type: String, enum: DURATION_UNITS, default: "DAYS" },
    etaMinutes: { type: Number, required: true, min: 0 }, // hishab er jonno minute e
  },
  { _id: false },
);

// order er dam onujayi charge (eto taka ba beshi hole charge = X, 0 hole free)
const chargeRuleSchema = new mongoose.Schema(
  {
    minOrderValue: { type: Number, required: true, min: 0 },
    charge: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const storeDeliverySchema = new mongoose.Schema(
  {
    storeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
      required: true,
      unique: true, // ek store = ek delivery setting
    },
    // LOCAL = shudhu radius er moddhe, NATIONAL = shudhu courier, BOTH = radius + courier
    deliveryType: {
      type: String,
      enum: ["LOCAL", "NATIONAL", "BOTH"],
      required: true,
    },
    pincode: { type: String, required: true, trim: true }, // store er pincode
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: { type: [Number], required: true },
    },

    // ---------- LOCAL ----------
    radiusKm: { type: Number, default: null, min: 0 },
    localSlabs: { type: [localSlabSchema], default: [] },
    // slab na thakle (purono setting) ei duto use hoy
    localDeliveryDays: { type: Number, default: 1, min: 0 },
    localDeliveryCharge: { type: Number, default: 0, min: 0 },

    // ---------- NATIONAL (courier / Shiprocket) ----------
    nationalMinDays: { type: Number, default: 3, min: 0 },
    nationalMaxDays: { type: Number, default: 7, min: 0 },
    // Shiprocket rate na pele (off / down) ei flat charge
    nationalFallbackCharge: { type: Number, default: 0, min: 0 },

    // ---------- INTERNATIONAL (courier + deshe baire) ----------
    allowInternational: { type: Boolean, default: false },
    internationalMinDays: { type: Number, default: 7, min: 0 },
    internationalMaxDays: { type: Number, default: 14, min: 0 },
    internationalFallbackCharge: { type: Number, default: 0, min: 0 },

    // ---------- ORDER VALUE RULES ----------
    // [NEW] PRODUCT order er jonno alada rule (radius + courier dui-tei lagbe)
    productChargeRules: { type: [chargeRuleSchema], default: [] },
    // [NEW] SERVICE order er jonno alada rule
    serviceChargeRules: { type: [chargeRuleSchema], default: [] },
    // purono field. Notun save e khali kora hoy. Notun rule na thakle
    // purono store e eta-i duto type er jonno fallback hishebe kaj kore
    chargeRules: { type: [chargeRuleSchema], default: [] },

    // order pack / dispatch korte lagbe koto somoy (shob delivery te jog hoy)
    handlingValue: { type: Number, default: 1, min: 0 },
    handlingUnit: { type: String, enum: DURATION_UNITS, default: "DAYS" },
    handlingMinutes: { type: Number, default: null, min: 0 },
    handlingDays: { type: Number, default: 1, min: 0 }, // purono field, compat

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("StoreDelivery", storeDeliverySchema);