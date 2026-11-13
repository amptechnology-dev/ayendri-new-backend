const {
  DEFAULT_CUTOFF,
  normCutoff,
  cutoffLabel,
  isPastCutoff,
  earliestBookingYmdFor,
} = require("./bookingConfig.js");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const todayIST = () =>
  new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

// ===================== [BOOKING / CANCEL RULES] =====================
const BOOKING_CUTOFF_LABEL = cutoffLabel(DEFAULT_CUTOFF); // default label, compat

const ymdAddDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ajker cutoff (IST) pera gele true
const isPastBookingCutoff = (cfg) => isPastCutoff(cfg);

// cutoff er age: aj theke. Cutoff er por: kal theke
const earliestBookingYmd = (cfg) => earliestBookingYmdFor(cfg);

// SERVICE cancel deadline = booking date er ager din, store er cutoff somoy (IST)
const serviceCancelDeadline = (bookingYmd, cfg) =>
  new Date(
    `${ymdAddDays(bookingYmd, -1)}T${normCutoff(cfg?.cutoffTime)}:00.000+05:30`,
  );

// courier product receive / pickup kore nile (Shiprocket webhook status)
const COURIER_RECEIVED_RE =
  /(PICKED UP|IN TRANSIT|OUT FOR DELIVERY|REACHED AT DESTINATION|SHIPPED|DELIVERED)/i;
const COURIER_BAD_RE = /(RTO|UNDELIVERED|CANCEL)/i;

const courierAlreadyReceived = (order) => {
  const st = String(order?.shipment?.status || "");
  return !!st && COURIER_RECEIVED_RE.test(st) && !COURIER_BAD_RE.test(st);
};

const REASON_LABELS = {
  SIZE_MISMATCH: "Size did not match",
  PRODUCT_DAMAGE: "Product is damaged",
  WRONG_PRODUCT: "Wrong product received",
  NOT_AS_DESCRIBED: "Product is not as described",
  QUALITY_ISSUE: "Quality issue",
  OTHER: "Other",
};

// preset reason hole label, OTHER hole user er nijer likha reason
const resolveReasonText = (reasonCode, reason) => {
  if (reasonCode === "OTHER") return reason;
  const label = REASON_LABELS[reasonCode] || reasonCode;
  return reason ? `${label}: ${reason}` : label;
};

const getDeliveredAt = (order) => {
  const h = [...(order.statusHistory || [])]
    .reverse()
    .find((x) => x.status === "DELIVERED");
  return new Date(h?.at || order.updatedAt || Date.now());
};

// days null = delivery agent / store decide korbe, tai kono fixed limit nei
const withinDays = (from, days) =>
  days === null ||
  days === undefined ||
  Date.now() - from.getTime() <= days * DAY_MS;

const itemRefundAmount = (item) =>
  round2(item.lineTotalWithGst ?? item.lineTotal ?? 0);

const requestRefundAmount = (order, item, type) => {
  if (type !== "RETURN" && type !== "REFUND") return 0;
  if (order.paymentStatus !== "PAID") return 0;
  return itemRefundAmount(item);
};

const getCancelEligibility = (order, cfg) => {
  const no = (message) => ({ ok: false, message, deadline: null });

  if (order.orderType === "REPLACEMENT") {
    return no("A replacement order cannot be cancelled");
  }

  if (!["PENDING", "CONFIRMED"].includes(order.status)) {
    return no(`Order cannot be cancelled once it is ${order.status}`);
  }

  const items = order.items || [];
  const wasPaid = order.paymentStatus === "PAID";
  const isService =
    order.hasService === true || items.some((i) => i.productType === "SERVICE");

  // paid order cancel = refund, tai shob item refundable hote hobe
  if (
    wasPaid &&
    (!items.length || !items.every((i) => i.isRefundable === true))
  ) {
    return no(
      "This order has items that are not refundable, so a paid order cannot be cancelled",
    );
  }

  // ---------- SERVICE ----------
  if (isService) {
    if (!order.bookingDate) {
      return no(
        "Booking date not found for this order, so it cannot be cancelled",
      );
    }
    const booking = new Date(order.bookingDate).toISOString().slice(0, 10);

    // [SAME DAY] booking date aj / aager hole cancel kora jabe na
    if (booking <= todayIST()) {
      return no(
        "A same-day service booking cannot be cancelled once it is placed",
      );
    }

    const deadline = serviceCancelDeadline(booking, cfg);
    if (Date.now() >= deadline.getTime()) {
      return no(
        `A service booking can be cancelled only until ${cutoffLabel(cfg?.cutoffTime)} on the day before the booking date (${booking})`,
      );
    }
    return { ok: true, message: null, deadline };
  }

  // ---------- PRODUCT ----------
  if (courierAlreadyReceived(order)) {
    return no(
      "The courier has already picked up this order, so it can no longer be cancelled",
    );
  }

  if (wasPaid) {
    const placedAt = new Date(order.createdAt || Date.now());
    const late = items.find((i) => !withinDays(placedAt, i.refundDays));
    if (late) {
      return no(
        `The refund period of ${late.refundDays} days for "${late.name}" is over, so this order can no longer be cancelled`,
      );
    }
  }

  return { ok: true, message: null, deadline: null };
};

// purono naam e onno jaygay use hole jeno na bhange
const checkCancelRefund = (order, cfg) => getCancelEligibility(order, cfg);

// delivered order er item e return / replace / refund request
const checkRequestEligibility = (order, item, type) => {
  if (order.orderType === "REPLACEMENT") {
    return {
      ok: false,
      message: "No request can be raised on a replacement order",
    };
  }

  if (item.productType === "SERVICE") {
    return {
      ok: false,
      message:
        "A service can only be cancelled for a refund before its booking date",
    };
  }
  if (order.status !== "DELIVERED") {
    return {
      ok: false,
      message: "You can raise this request only after the order is delivered",
    };
  }

  const deliveredAt = getDeliveredAt(order);

  if (type === "RETURN") {
    if (item.isReturnable !== true) {
      return { ok: false, message: "This product is not returnable" };
    }
    if (!withinDays(deliveredAt, item.returnDays)) {
      return {
        ok: false,
        message: `The return period of ${item.returnDays} days is over`,
      };
    }
  }
  if (type === "REPLACE") {
    if (item.isReplaceable !== true) {
      return { ok: false, message: "This product is not replaceable" };
    }
    if (!withinDays(deliveredAt, item.replaceDays)) {
      return {
        ok: false,
        message: `The replacement period of ${item.replaceDays} days is over`,
      };
    }
  }
  if (type === "REFUND") {
    if (item.isRefundable !== true) {
      return { ok: false, message: "This product is not refundable" };
    }
    if (order.paymentStatus !== "PAID") {
      return { ok: false, message: "No payment found for this order" };
    }
    if (!withinDays(deliveredAt, item.refundDays)) {
      return {
        ok: false,
        message: `The refund period of ${item.refundDays} days is over`,
      };
    }
  }
  return { ok: true };
};

const getItemRequestOptions = (order, item) => {
  const out = {};
  const daysOf = {
    RETURN: item.returnDays,
    REPLACE: item.replaceDays,
    REFUND: item.refundDays,
  };
  for (const type of ["RETURN", "REPLACE", "REFUND"]) {
    const r = checkRequestEligibility(order, item, type);
    const days = daysOf[type];
    out[type] = {
      ok: r.ok,
      message: r.ok ? null : r.message,
      deadline:
        order.status === "DELIVERED" && days
          ? new Date(getDeliveredAt(order).getTime() + days * DAY_MS)
          : null,
    };
  }
  return out;
};

module.exports = {
  REASON_LABELS,
  round2,
  todayIST,
  ymdAddDays,
  BOOKING_CUTOFF_LABEL,
  isPastBookingCutoff,
  earliestBookingYmd,
  serviceCancelDeadline,
  getCancelEligibility,
  resolveReasonText,
  itemRefundAmount,
  requestRefundAmount,
  checkCancelRefund,
  checkRequestEligibility,
  getItemRequestOptions
};
