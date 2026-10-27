const StoreDeliveryModel = require("../model/storeDelivery.model.js");
const PincodeModel = require("../model/pincode.model.js");
const shiprocket = require("./shiprocket.js");
const { getStorePolicy } = require("./storePolicy.js");

const EARTH_RADIUS_KM = 6378.1;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const UNIT_MINUTES = { MINUTES: 1, HOURS: 60, DAYS: 1440 };

// ---------- small helpers ----------
const isValidPincode = (p) => /^[1-9][0-9]{5}$/.test(String(p || "").trim());
// India chara onno desher postal code (alphanumeric, 3-12 okkhor)
const isValidPostalCode = (p) =>
  /^[A-Za-z0-9][A-Za-z0-9 -]{1,10}[A-Za-z0-9]$/.test(String(p || "").trim());
const isIndia = (country) => {
  const c = String(country || "")
    .trim()
    .toLowerCase();
  return !c || ["india", "in", "ind", "bharat"].includes(c);
};

const toRad = (d) => (d * Math.PI) / 180;
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// value + unit -> minute
const toMinutes = (value, unit = "DAYS") =>
  Math.round(Math.max(0, Number(value) || 0) * (UNIT_MINUTES[unit] || 1440));

// coordinates = [lng, lat]
const haversineKm = ([lng1, lat1], [lng2, lat2]) => {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
};

// aaj (IST) theke n minute por je date (T00:00:00.000Z — toDeliveryDate er moto)
const dateAfterMinutes = (minutes) => {
  const d = new Date(Date.now() + IST_OFFSET_MS + minutes * 60000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
};

const pluralize = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// "Delivery in 45 minutes" / "Delivery in 2 hours" / "Delivery in 4-7 days"
const formatDurationLabel = (minMinutes, maxMinutes) => {
  const lo = Math.max(0, Math.round(minMinutes));
  const hi = Math.max(lo, Math.round(maxMinutes));

  if (hi === 0) return "Same day delivery";

  if (hi < 60) {
    return lo === hi
      ? `Delivery in ${pluralize(hi, "minute")}`
      : `Delivery in ${lo}-${hi} minutes`;
  }

  if (hi < 1440) {
    const toH = (m) => Math.round((m / 60) * 10) / 10;
    const a = toH(lo);
    const b = toH(hi);
    return a === b
      ? `Delivery in ${pluralize(b, "hour")}`
      : `Delivery in ${a}-${b} hours`;
  }

  const a = Math.ceil(lo / 1440);
  const b = Math.ceil(hi / 1440);
  if (a === b) return b === 1 ? "Delivery in 1 day" : `Delivery in ${b} days`;
  return `Delivery in ${a}-${b} days`;
};

// purono code er jonno alias
const formatDeliveryLabel = (minDays, maxDays) =>
  formatDurationLabel(minDays * 1440, maxDays * 1440);

// store er dispatch time (minute e). Purono doc e handlingMinutes na thakle handlingDays theke
const getHandlingMinutes = (cfg) =>
  typeof cfg.handlingMinutes === "number"
    ? cfg.handlingMinutes
    : (cfg.handlingDays || 0) * 1440;

// ---------- estimate info ----------
// source: MANUAL = store er nijer somoy/charge, SHIPROCKET = courier er asol ETA / rate
// shippingCharge: customer er order total e jog hoy. courierRate: courier ke asol je khoroch
const buildInfo = (mode, distanceKm, minMinutes, maxMinutes, extra = {}) => {
  const lo = Math.max(0, Math.round(minMinutes));
  const hi = Math.max(lo, Math.round(maxMinutes));

  const info = {
    mode,
    distanceKm,
    minMinutes: lo,
    maxMinutes: hi,
    minDays: Math.ceil(lo / 1440),
    maxDays: Math.ceil(hi / 1440),
    etaLabel: formatDurationLabel(lo, hi),
    estimatedMinDate: dateAfterMinutes(lo),
    estimatedMaxDate: dateAfterMinutes(hi),
    estimatedMaxAt: new Date(Date.now() + hi * 60000),
    source: "MANUAL",
    courierId: null,
    courierName: null,
    courierRate: null,
    shippingCharge: 0,
    baseShippingCharge: null,
    shippingNote: null,
    country: null,
    pincode: null,
    ...extra,
  };

  if (
    info.baseShippingCharge === null ||
    info.baseShippingCharge === undefined
  ) {
    info.baseShippingCharge = info.shippingCharge;
  }
  return info;
};

// courier er ETA na thakle manual din
const etaOf = (courier, fallbackDays) =>
  Number.isFinite(courier?.etaDays) ? courier.etaDays : fallbackDays;

// Radius er moddhe kon kon pincode porche (store er jonno preview)
const findPincodesInRadius = ({ coordinates, radiusKm, limit = 500 }) =>
  PincodeModel.find({
    location: {
      $geoWithin: { $centerSphere: [coordinates, radiusKm / EARTH_RADIUS_KM] },
    },
  })
    .select("pincode area district state -_id")
    .sort({ pincode: 1 })
    .limit(limit)
    .lean();

const countPincodesInRadius = ({ coordinates, radiusKm }) =>
  PincodeModel.countDocuments({
    location: {
      $geoWithin: { $centerSphere: [coordinates, radiusKm / EARTH_RADIUS_KM] },
    },
  });

// ---------- LOCAL: distance slab ----------
// distance jei prothom slab er upToKm er moddhe sheta. Sob slab er baire hole shesh slab
const pickSlab = (slabs, distanceKm) => {
  if (!Array.isArray(slabs) || slabs.length === 0) return null;
  const sorted = [...slabs].sort((a, b) => a.upToKm - b.upToKm);
  return (
    sorted.find((s) => distanceKm <= s.upToKm) || sorted[sorted.length - 1]
  );
};

const resolveLocal = ({ cfg, distanceKm, handlingMin, pin }) => {
  const slab = pickSlab(cfg.localSlabs, distanceKm);

  const etaMin = slab
    ? typeof slab.etaMinutes === "number"
      ? slab.etaMinutes
      : toMinutes(slab.etaValue, slab.etaUnit)
    : (cfg.localDeliveryDays || 0) * 1440;

  const charge = round2(slab ? slab.charge : cfg.localDeliveryCharge);
  const total = handlingMin + etaMin;

  return buildInfo("LOCAL", distanceKm, total, total, {
    shippingCharge: charge,
    shippingNote: slab ? `Within ${slab.upToKm} km` : "Local delivery",
    pincode: pin,
  });
};

// ---------- NATIONAL: Shiprocket thakle courier er asol ETA + rate, nahole manual ----------
const resolveNational = async ({
  cfg,
  pin,
  handlingMin,
  weightKg,
  parcel,
  cod,
  fastest = false,
}) => {
  if (shiprocket.isAvailable()) {
    try {
      const svc = await shiprocket.checkServiceability({
        pickupPostcode: cfg.pincode,
        deliveryPostcode: pin,
        weightKg,
        parcel,
        cod,
      });

      if (!svc.serviceable) return { serviceable: false, info: null };

      const fastDays = etaOf(svc.fastest, cfg.nationalMinDays || 0);
      const cheapDays = etaOf(svc.cheapest, cfg.nationalMaxDays || 0);
      const chosen = fastest ? svc.fastest : svc.cheapest;

      const minMin = handlingMin + fastDays * 1440;
      const maxMin = fastest
        ? minMin
        : Math.max(minMin, handlingMin + cheapDays * 1440);
      const rate = round2(chosen.rate);

      return {
        serviceable: true,
        info: buildInfo("NATIONAL", null, minMin, maxMin, {
          source: "SHIPROCKET",
          courierId: chosen.id,
          courierName: chosen.name,
          courierRate: rate,
          courierEtaDays: Number.isFinite(chosen.etaDays)
            ? chosen.etaDays
            : null,
          courierMode: chosen.mode ?? null,
          fastestDelivery: fastest,
          chargeableWeightKg: parcel?.chargeableWeight ?? weightKg ?? null,
          shippingCharge: rate,
          shippingNote: fastest
            ? `Fastest courier (${chosen.name}) to ${pin}`
            : `Courier (${chosen.name}) to ${pin}`,
          pincode: pin,
        }),
      };
    } catch (err) {
      console.error(
        "Shiprocket serviceability failed, using manual estimate:",
        err.message,
      );
    }
  }

  // manual fallback: fastest hole shudhu min din
  const manualMin = handlingMin + (cfg.nationalMinDays || 0) * 1440;
  const manualMax = fastest
    ? manualMin
    : handlingMin + (cfg.nationalMaxDays || 0) * 1440;

  return {
    serviceable: true,
    info: buildInfo("NATIONAL", null, manualMin, manualMax, {
      fastestDelivery: fastest,
      shippingCharge: round2(cfg.nationalFallbackCharge),
      shippingNote: `Courier delivery to ${pin}`,
      chargeableWeightKg: parcel?.chargeableWeight ?? weightKg ?? null,
      pincode: pin,
    }),
  };
};

// ---------- INTERNATIONAL ----------
// Shiprocket couriers pele seta, nahole store er manual days + charge
const resolveInternational = async ({
  cfg,
  pin,
  country,
  handlingMin,
  weightKg,
  parcel,
  fastest = false,
}) => {
  const countryCode = shiprocket.toCountryCode(country);

  if (shiprocket.isAvailable() && !countryCode) {
    console.warn(
      `[Delivery] No ISO code mapped for country "${country}", using manual estimate`,
    );
  }

  if (shiprocket.isAvailable() && countryCode) {
    try {
      const svc = await shiprocket.checkInternationalServiceability({
        pickupPostcode: cfg.pincode,
        countryCode,
        weightKg,
        parcel,
      });

      if (svc.serviceable) {
        const fastDays = etaOf(svc.fastest, cfg.internationalMinDays ?? 7);
        const cheapDays = etaOf(svc.cheapest, cfg.internationalMaxDays ?? 14);
        const chosen = fastest ? svc.fastest : svc.cheapest;

        const minMin = handlingMin + fastDays * 1440;
        const maxMin = fastest
          ? minMin
          : Math.max(minMin, handlingMin + cheapDays * 1440);
        const rate = round2(chosen.rate);

        return buildInfo("INTERNATIONAL", null, minMin, maxMin, {
          source: "SHIPROCKET",
          courierId: chosen.id,
          courierName: chosen.name,
          courierRate: rate,
          courierEtaDays: Number.isFinite(chosen.etaDays)
            ? chosen.etaDays
            : null,
          courierMode: chosen.mode ?? null,
          fastestDelivery: fastest,
          chargeableWeightKg: parcel?.chargeableWeight ?? weightKg ?? null,
          shippingCharge: rate,
          shippingNote: `International courier to ${country}`,
          country,
          pincode: pin,
        });
      }
    } catch (err) {
      console.error(
        "International estimate failed, using manual:",
        err.message,
      );
    }
  }

  const manualMin = handlingMin + (cfg.internationalMinDays ?? 7) * 1440;
  const manualMax = fastest
    ? manualMin
    : handlingMin + (cfg.internationalMaxDays ?? 14) * 1440;

  return buildInfo("INTERNATIONAL", null, manualMin, manualMax, {
    fastestDelivery: fastest,
    shippingCharge: round2(cfg.internationalFallbackCharge),
    shippingNote: `International shipping to ${country}`,
    chargeableWeightKg: parcel?.chargeableWeight ?? weightKg ?? null,
    country,
    pincode: pin,
  });
};

// ---------- ORDER VALUE RULES ----------
// items er total >= minOrderValue emon rule er moddhe shobcheye boro minOrderValue wala rule-ta jitbe
const applyChargeRules = (baseCharge, itemsTotal, rules) => {
  const total = Number(itemsTotal);
  if (!Number.isFinite(total) || !Array.isArray(rules) || rules.length === 0) {
    return { charge: baseCharge, rule: null };
  }
  const matched = rules
    .filter((r) => total >= r.minOrderValue)
    .sort((a, b) => b.minOrderValue - a.minOrderValue)[0];

  return matched
    ? { charge: round2(matched.charge), rule: matched }
    : { charge: baseCharge, rule: null };
};

/**
 * checkStoreDelivery er result + order er items total diye shipping charge final kore.
 * Order create / checkout preview e items total ber hoar por eta chalate hoy.
 * INTERNATIONAL e rule lage na (courier er asol khoroch-i)
 */
const finalizeShipping = (delivery, itemsTotal) => {
  const info = delivery?.info;
  if (!info) return null;

  const base = info.shippingCharge;
  if (info.mode === "INTERNATIONAL")
    return { ...info, baseShippingCharge: base };

  const { charge, rule } = applyChargeRules(
    base,
    itemsTotal,
    delivery.chargeRules,
  );
  if (!rule) return { ...info, baseShippingCharge: base };

  return {
    ...info,
    baseShippingCharge: base,
    shippingCharge: charge,
    shippingNote:
      charge === 0
        ? `Free delivery on orders of ₹${rule.minOrderValue} or more`
        : `Delivery ₹${charge} on orders of ₹${rule.minOrderValue} or more`,
  };
};

const notDeliverable = (message) => ({
  deliverable: false,
  configured: true,
  info: null,
  message,
});

/**
 * Ekta store ei address e deliver kore kina + somoy + shipping charge.
 * Return: { deliverable, configured, message?, info, chargeRules }
 *  - configured=false : store e delivery off ba setting nei -> kono restriction / estimate / charge nei
 *  - country : India na hole international (store allowInternational + courier ON thakte hobe)
 *  - weightKg / cod : courier hishabe lage. cod = courier COD collect korbe kina
 *  - policy : getStorePolicy er result (dile abar DB query hoy na)
 */
const checkStoreDelivery = async ({
  storeId,
  pincode,
  country,
  weightKg,
  parcel, // shiprocket.buildParcel() er result (dile weight + dimension dhore)
  cod = false,
  policy,
  fastest = false,
}) => {
  const pol = policy || (await getStorePolicy(storeId));

  if (!pol.hasDelivery) {
    return { deliverable: true, configured: false, disabled: true, info: null };
  }

  const cfg = await StoreDeliveryModel.findOne({
    storeId,
    isActive: true,
  }).lean();

  if (!cfg) return { deliverable: true, configured: false, info: null };

  const pin = String(pincode || "").trim();
  const handlingMin = getHandlingMinutes(cfg);
  const allowLocal =
    cfg.deliveryType === "LOCAL" || cfg.deliveryType === "BOTH";
  const allowNational =
    cfg.deliveryType === "NATIONAL" || cfg.deliveryType === "BOTH";
  const weight = parcel?.weight ?? weightKg;

  // ---------- INTERNATIONAL ----------
  if (!isIndia(country)) {
    const countryName = String(country).trim();

    if (!allowNational || cfg.allowInternational !== true) {
      return notDeliverable(`This store does not ship to ${countryName}`);
    }
    if (!isValidPostalCode(pin)) {
      return notDeliverable("Please enter a valid postal code");
    }
    if (cod) {
      return notDeliverable(
        "Cash on Delivery is not available for international orders",
      );
    }

    const info = await resolveInternational({
      cfg,
      pin,
      country: countryName,
      handlingMin,
      weightKg: weight,
      parcel,
      fastest,
    });
    return { deliverable: true, configured: true, info, chargeRules: [] };
  }

  // ---------- INDIA ----------
  if (!isValidPincode(pin)) {
    return notDeliverable("Please enter a valid 6 digit pincode");
  }

  const chargeRules = cfg.chargeRules || [];

  // ---------- LOCAL ----------
  if (allowLocal && cfg.radiusKm) {
    let distanceKm = null;

    if (pin === cfg.pincode) {
      distanceKm = 0;
    } else {
      const userPin = await PincodeModel.findOne({ pincode: pin })
        .select("location")
        .lean();
      if (userPin?.location?.coordinates?.length === 2) {
        distanceKm = round1(
          haversineKm(cfg.location.coordinates, userPin.location.coordinates),
        );
      }
    }

    if (distanceKm !== null && distanceKm <= cfg.radiusKm) {
      return {
        deliverable: true,
        configured: true,
        info: resolveLocal({ cfg, distanceKm, handlingMin, pin }),
        chargeRules,
      };
    }
  }

  // ---------- NATIONAL ----------
  if (allowNational) {
    const national = await resolveNational({
      cfg,
      pin,
      handlingMin,
      weightKg: weight,
      parcel,
      cod,
      fastest,
    });

    if (!national.serviceable) {
      return notDeliverable(
        `Courier delivery is not available for pincode ${pin}`,
      );
    }
    return {
      deliverable: true,
      configured: true,
      info: national.info,
      chargeRules,
    };
  }

  return notDeliverable(`This store does not deliver to pincode ${pin}`);
};

/**
 * Product listing / detail e dekhanor jonno chhoto summary.
 * - pincode nei, store e delivery off, ba setting nei -> null
 * - deliverable na -> { deliverable: false, label: "..." }
 * - itemsTotal dile order value rule dhore charge hishab hoy
 */
const getDeliverySummary = async ({
  storeId,
  pincode,
  country,
  itemsTotal = null,
  parcel = null, // product detail e dile oi product er weight/size dhore estimate
  fastest = false,
}) => {
  const pin = String(pincode || "").trim();
  if (!pin) return null;

  const policy = await getStorePolicy(storeId);
  if (!policy.hasDelivery) return null;

  const result = await checkStoreDelivery({
    storeId,
    pincode: pin,
    country,
    parcel,
    policy,
    fastest,
  });
  if (!result.configured) return null;

  if (!result.deliverable) {
    return {
      deliverable: false,
      mode: null,
      distanceKm: null,
      minMinutes: null,
      maxMinutes: null,
      minDays: null,
      maxDays: null,
      estimatedMinDate: null,
      estimatedMaxDate: null,
      estimatedMaxAt: null,
      shippingCharge: null,
      freeDeliveryAbove: null,
      shippingNote: null,
      courierName: null,
      chargeableWeightKg: null,
      fastest: false,
      label: result.message,
    };
  }

  const info =
    itemsTotal !== null && itemsTotal !== undefined
      ? finalizeShipping(result, itemsTotal)
      : result.info;

  const freeRules = (result.chargeRules || [])
    .filter((r) => r.charge === 0)
    .map((r) => r.minOrderValue);
  const freeDeliveryAbove = freeRules.length ? Math.min(...freeRules) : null;

  return {
    deliverable: true,
    mode: info.mode,
    distanceKm: info.distanceKm,
    minMinutes: info.minMinutes,
    maxMinutes: info.maxMinutes,
    minDays: info.minDays,
    maxDays: info.maxDays,
    estimatedMinDate: info.estimatedMinDate,
    estimatedMaxDate: info.estimatedMaxDate,
    estimatedMaxAt: info.estimatedMaxAt,
    shippingCharge: info.shippingCharge ?? 0,
    freeDeliveryAbove,
    shippingNote: info.shippingNote,
    courierName: info.courierName ?? null,
    chargeableWeightKg: info.chargeableWeightKg ?? null,
    fastest: !!info.fastestDelivery,
    label: info.etaLabel,
  };
};

module.exports = {
  isValidPincode,
  isValidPostalCode,
  isIndia,
  haversineKm,
  toMinutes,
  findPincodesInRadius,
  countPincodesInRadius,
  checkStoreDelivery,
  finalizeShipping,
  formatDurationLabel,
  formatDeliveryLabel,
  getDeliverySummary,
};
