const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const todayIST = () =>
  new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

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
  days === null || days === undefined || Date.now() - from.getTime() <= days * DAY_MS;

const itemRefundAmount = (item) =>
  round2(item.lineTotalWithGst ?? item.lineTotal ?? 0);

// paid order cancel korle refund pawa jabe kina
const checkCancelRefund = (order) => {
  const items = order.items || [];
  if (!items.length || !items.every((i) => i.isRefundable === true)) {
    return {
      ok: false,
      message:
        "This order has items that are not refundable, so a paid order cannot be cancelled",
    };
  }
  if (order.hasService) {
    const booking = order.bookingDate
      ? new Date(order.bookingDate).toISOString().slice(0, 10)
      : null;
    if (!booking || booking <= todayIST()) {
      return {
        ok: false,
        message: "Refund is not possible on or after the booking date",
      };
    }
  }
  return { ok: true };
};

// delivered order er item e return / replace / refund request
const checkRequestEligibility = (order, item, type) => {
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

module.exports = {
  REASON_LABELS,
  round2,
  resolveReasonText,
  itemRefundAmount,
  checkCancelRefund,
  checkRequestEligibility,
};