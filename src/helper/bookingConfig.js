const StoreDeliveryModel = require("../model/storeDelivery.model.js");

const DEFAULT_CUTOFF = "16:00";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const todayYmdIST = (now = Date.now()) =>
  new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10);

const addDaysYmd = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const normCutoff = (t) => (TIME_RE.test(String(t || "")) ? t : DEFAULT_CUTOFF);

// "16:00" -> 960
const cutoffMinutes = (t) => {
  const m = TIME_RE.exec(normCutoff(t));
  return Number(m[1]) * 60 + Number(m[2]);
};

// "16:00" -> "4:00 PM"
const cutoffLabel = (t) => {
  const [h, m] = normCutoff(t).split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};

const nowMinutesIST = (now = Date.now()) => {
  const d = new Date(now + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

// aj-er cutoff pera gele true
const isPastCutoff = (cfg, now = Date.now()) =>
  nowMinutesIST(now) >= cutoffMinutes(cfg?.cutoffTime);

const toCfg = (doc) => ({
  cutoffTime: normCutoff(doc?.bookingCutoffTime),
  blockedDates: Array.isArray(doc?.blockedBookingDates)
    ? doc.blockedBookingDates
    : [],
});

const SELECT = "storeId bookingCutoffTime blockedBookingDates";

// isActive filter nei: delivery off hole-o booking rule kaj korbe
const getBookingConfig = async (storeId) =>
  toCfg(await StoreDeliveryModel.findOne({ storeId }).select(SELECT).lean());

// Map<storeIdString, cfg>. Setting na thakle default cfg
const getBookingConfigMap = async (storeIds = []) => {
  const ids = [...new Set(storeIds.filter(Boolean).map(String))];
  const map = new Map(ids.map((id) => [id, toCfg(null)]));
  if (ids.length === 0) return map;
  const docs = await StoreDeliveryModel.find({ storeId: { $in: ids } })
    .select(SELECT)
    .lean();
  docs.forEach((d) => map.set(String(d.storeId), toCfg(d)));
  return map;
};

// cutoff er age hole aj, na hole kal (blocked date dhora hoyni)
const earliestBookingYmdFor = (cfg, now = Date.now()) => {
  const today = todayYmdIST(now);
  return isPastCutoff(cfg, now) ? addDaysYmd(today, 1) : today;
};

// prothom je date e booking nite pare (blocked skip kore)
const nextAvailableBookingYmd = (cfg, now = Date.now()) => {
  const blocked = new Set(cfg?.blockedDates || []);
  let d = earliestBookingYmdFor(cfg, now);
  for (let i = 0; i < 400; i++) {
    if (!blocked.has(d)) return d;
    d = addDaysYmd(d, 1);
  }
  return null;
};

// aj ba future-er blocked date (calendar e disable korar jonno)
const upcomingBlockedDates = (cfg, now = Date.now()) =>
  (cfg?.blockedDates || []).filter((d) => d >= todayYmdIST(now)).sort();

const validateBookingDate = (ymd, cfg, now = Date.now()) => {
  const rawEarliest = earliestBookingYmdFor(cfg, now);
  const earliest = nextAvailableBookingYmd(cfg, now) || rawEarliest;
  const blockedDates = upcomingBlockedDates(cfg, now);

  if (!ymd) {
    return {
      ok: false,
      code: "BOOKING_DATE_REQUIRED",
      message: "Please select a booking date for this service",
      earliest,
      blockedDates,
    };
  }

  if (ymd < rawEarliest) {
    const message =
      ymd < todayYmdIST(now)
        ? "Booking date cannot be in the past"
        : `Booking for today closes at ${cutoffLabel(cfg?.cutoffTime)}. Please choose ${earliest} or a later date`;
    return {
      ok: false,
      code: "BOOKING_DATE_INVALID",
      message,
      earliest,
      blockedDates,
    };
  }

  if ((cfg?.blockedDates || []).includes(ymd)) {
    return {
      ok: false,
      code: "BOOKING_DATE_BLOCKED",
      message:
        "Bookings are not available on this date. Please choose another date",
      earliest,
      blockedDates,
    };
  }

  return { ok: true, earliest, blockedDates };
};

module.exports = {
  DEFAULT_CUTOFF,
  todayYmdIST,
  addDaysYmd,
  normCutoff,
  cutoffMinutes,
  cutoffLabel,
  isPastCutoff,
  getBookingConfig,
  getBookingConfigMap,
  earliestBookingYmdFor,
  nextAvailableBookingYmd,
  upcomingBlockedDates,
  validateBookingDate,
};