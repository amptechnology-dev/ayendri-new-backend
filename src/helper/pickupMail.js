const nodemailer = require("nodemailer");

const FROM_NAME = "Ayendri";
let transporter = null;

const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
  }
  return transporter;
};

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const fmtDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return x.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
};

const addressText = (a = {}) =>
  [a.addressLine, a.area, a.city, a.state, a.pincode]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(", ");

// value string ba array (array hole proti item alada line)
const rowsHtml = (rows) =>
  rows
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const val = Array.isArray(v) ? v.map(esc).join("<br/>") : esc(v);
      return `<tr>
        <td style="padding:10px;border:1px solid #ddd;width:35%;"><strong>${esc(k)}</strong></td>
        <td style="padding:10px;border:1px solid #ddd;">${val}</td>
      </tr>`;
    })
    .join("");

const layout = ({ title, greeting, intro, rows, outro }) => `
  <div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:10px;background:#f9f9f9;">
    <h2 style="color:#2E86C1;text-align:center;">${esc(title)}</h2>
    <p>Hello ${esc(greeting || "there")},</p>
    <p>${esc(intro)}</p>
    <table style="width:100%;border-collapse:collapse;margin-top:20px;">${rowsHtml(rows)}</table>
    ${outro ? `<p style="margin-top:20px;">${esc(outro)}</p>` : ""}
    <p style="margin-top:30px;">Regards,<br/><strong>AMP Store Management Team</strong></p>
  </div>`;

// kokhono throw kore na: mail fail holeo main flow (product save / order) cholbe
const send = async ({ to, subject, html }) => {
  const email = String(to || "").trim();
  if (!email || !process.env.EMAIL_USER) return false;
  try {
    await getTransporter().sendMail({
      from: `"${FROM_NAME}" <${process.env.EMAIL_USER}>`,
      to: email,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error("Pickup contact mail failed:", error.message);
    return false;
  }
};

// ---------- 1. Product add / pickup address update ----------
const sendPickupContactProductMail = async ({
  product,
  store,
  address,
  isUpdate = false,
}) => {
  if (!address?.email) return false;
  const isService = product?.productType === "SERVICE";
  const kind = isService ? "Service" : "Product";

  return send({
    to: address.email,
    subject: isUpdate
      ? `Pickup details updated: ${product.name}`
      : `You are added as pickup contact for ${product.name}`,
    html: layout({
      title: isUpdate ? "Pickup Details Updated" : "Pickup Contact Added",
      greeting: address.contactName,
      intro: isUpdate
        ? `The pickup details of the following ${kind.toLowerCase()} were updated and you are the pickup contact.`
        : `A new ${kind.toLowerCase()} was added and you are set as its pickup contact.`,
      rows: [
        [kind, product.name],
        [`${kind} code`, product.productCode],
        ["Store", store?.storeName],
        ["Store ID", store?.storeUniqueId],
        ["Contact person", address.contactName],
        ["Phone", address.phone],
        ["Pickup address", addressText(address)],
      ],
      outro: isService
        ? "Whenever a booking is placed for this service you will get another email."
        : "Whenever an order is placed for this product you will get another email with the order details and the courier pickup date.",
    }),
  });
};

// ---------- 2. Order place hole ----------
const sendPickupContactOrderMail = async ({ order }) => {
  let addr = order?.pickupAddress;
  if (!addr) {
    const OrderModel = require("../model/order.model.js"); // lazy: circular import er jonno
    const full = await OrderModel.findById(order._id)
      .select("+pickupAddress")
      .lean();
    addr = full?.pickupAddress;
  }
  if (!addr?.email) return false;

  const items = (order.items || []).map(
    (i) =>
      `${i.name}${i.productCode ? ` (${i.productCode})` : ""} x ${i.quantity}`,
  );

  return send({
    to: addr.email,
    subject: `New order ${order.orderNumber}: keep items ready for pickup`,
    html: layout({
      title: "New Order Received",
      greeting: addr.contactName,
      intro:
        "An order was placed for item(s) that are picked up from your address. Please keep them packed and ready.",
      rows: [
        ["Order number", order.orderNumber],
        ["Store", order.storeName],
        ["Items", items],
        ["Booking date", order.hasService ? fmtDate(order.bookingDate) : null],
        ["Pickup address", addressText(addr)],
      ],
      outro:
        "When the store books the courier, you will get another email with the pickup date and courier details.",
    }),
  });
};

// ---------- 3. Shiprocket pickup schedule hole ----------
const sendPickupContactShipmentMail = async ({ order, shipment, address }) => {
  const addr = address || order?.pickupAddress;
  if (!addr?.email) return false;

  return send({
    to: addr.email,
    subject: `Courier pickup scheduled for order ${order.orderNumber}`,
    html: layout({
      title: "Courier Pickup Scheduled",
      greeting: addr.contactName,
      intro:
        "The courier will come to collect the package from your address. Please keep it packed and ready.",
      rows: [
        ["Order number", order.orderNumber],
        ["Pickup date", fmtDate(shipment?.pickupScheduledDate)],
        ["Courier", shipment?.courierName],
        ["AWB", shipment?.awb],
        ["Pickup token", shipment?.pickupTokenNumber],
        ["Tracking link", shipment?.trackingUrl],
        ["Pickup address", addressText(addr)],
      ],
      outro: "Please hand over the package to the courier executive.",
    }),
  });
};

module.exports = {
  sendPickupContactProductMail,
  sendPickupContactOrderMail,
  sendPickupContactShipmentMail,
};