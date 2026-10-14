const nodemailer = require("nodemailer");

const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const formatMoney = (n) => `₹${Number(n || 0).toFixed(2)}`;

const itemsTableRows = (items = []) =>
  items
    .map(
      (it) => `
        <tr>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(it.name)}${
            it.size ? ` (${escapeHtml(it.size)})` : ""
          }</td>
          <td style="padding:8px; border:1px solid #ddd; text-align:center;">${it.quantity}</td>
          <td style="padding:8px; border:1px solid #ddd; text-align:right;">${formatMoney(it.offerPrice)}</td>
          <td style="padding:8px; border:1px solid #ddd; text-align:right;">${formatMoney(it.lineTotal)}</td>
        </tr>`,
    )
    .join("");

const itemsTable = (items) => `
  <table style="width:100%; border-collapse: collapse; margin-top:10px;">
    <thead>
      <tr style="background:#eee;">
        <th style="padding:8px; border:1px solid #ddd;">Item</th>
        <th style="padding:8px; border:1px solid #ddd;">Qty</th>
        <th style="padding:8px; border:1px solid #ddd;">Price</th>
        <th style="padding:8px; border:1px solid #ddd;">Total</th>
      </tr>
    </thead>
    <tbody>${itemsTableRows(items)}</tbody>
  </table>
`;

const baseWrapper = (title, bodyHtml) => `
  <div style="font-family: Arial; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px; background:#f9f9f9;">
    <h2 style="color:#2E86C1; text-align:center;">${title}</h2>
    ${bodyHtml}
    <p style="margin-top:30px;">Regards,<br/><strong>AMP Store Management Team</strong></p>
  </div>
`;

// ===== 1. Store owner ke notify - notun order eseche =====
const sendNewOrderEmailToStore = async ({ toEmail, storeName, order }) => {
  try {
    if (!toEmail) return;

    const body = `
      <p>Hello ${escapeHtml(storeName)},</p>
      <p>You have received a <strong style="color:green;">new order</strong> 🎉</p>
      <table style="width:100%; border-collapse: collapse; margin-top:10px;">
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Order Number</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(order.orderNumber)}</td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Customer</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(
            order.deliveryAddress?.fullName,
          )} (${escapeHtml(order.deliveryAddress?.phone)})</td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Delivery Address</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(
            order.deliveryAddress?.addressLine || "",
          )}</td>
        </tr>
      </table>
      ${itemsTable(order.items)}
      <p style="text-align:right; margin-top:10px; font-size:16px;">
        <strong>Grand Total: ${formatMoney(order.totalAmount)}</strong>
      </p>
    `;

    await transporter.sendMail({
      from: `"AMP Store Management" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `New Order Received - #${order.orderNumber}`,
      html: baseWrapper("New Order Received 🛒", body),
    });

    console.log("New order email sent to store ✅");
  } catch (error) {
    console.error("New order email (store) failed:", error);
  }
};

// ===== 2. User ke order confirmation (checkout-e ekbare multiple store hote pare) =====
const sendOrderConfirmationToUser = async ({ toEmail, userName, orders }) => {
  try {
    if (!toEmail || !orders?.length) return;

    const ordersHtml = orders
      .map(
        (order) => `
        <h3 style="margin-top:20px; color:#2E86C1;">${escapeHtml(order.storeName)} - #${escapeHtml(
          order.orderNumber,
        )}</h3>
        ${itemsTable(order.items)}
        <p style="text-align:right; margin-top:5px;"><strong>Subtotal: ${formatMoney(
          order.totalAmount,
        )}</strong></p>
      `,
      )
      .join("");

    const grandTotal = orders.reduce((sum, o) => sum + o.totalAmount, 0);

    const body = `
      <p>Hello ${escapeHtml(userName) || "Customer"},</p>
      <p>Thank you! Your order has been placed <strong style="color:green;">successfully</strong>.</p>
      ${ordersHtml}
      <p style="text-align:right; margin-top:15px; font-size:16px;">
        <strong>Grand Total: ${formatMoney(grandTotal)}</strong>
      </p>
      <p style="margin-top:15px;">We'll notify you when the status of your order changes.</p>
    `;

    await transporter.sendMail({
      from: `"AMP Store Management" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Order Placed Successfully 🎉",
      html: baseWrapper("Order Confirmed ✅", body),
    });

    console.log("Order confirmation email sent to user ✅");
  } catch (error) {
    console.error("Order confirmation email (user) failed:", error);
  }
};

// ===== 3. User ke order status update =====
const STATUS_MESSAGES = {
  CONFIRMED: "Your order has been confirmed by the store.",
  SHIPPED: "Your order has been shipped and is on its way.",
  DELIVERED: "Your order has been delivered. Enjoy!",
  CANCELLED: "Your order has been cancelled.",
};

const sendOrderStatusUpdateToUser = async ({
  toEmail,
  userName,
  order,
  status,
}) => {
  try {
    if (!toEmail) return;

    const body = `
      <p>Hello ${escapeHtml(userName) || "Customer"},</p>
      <p>${STATUS_MESSAGES[status] || "Your order status has been updated."}</p>
      <table style="width:100%; border-collapse: collapse; margin-top:10px;">
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Order Number</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(order.orderNumber)}</td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Store</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${escapeHtml(order.storeName)}</td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>New Status</strong></td>
          <td style="padding:8px; border:1px solid #ddd;"><strong style="color:#2E86C1;">${escapeHtml(
            status,
          )}</strong></td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Total Amount</strong></td>
          <td style="padding:8px; border:1px solid #ddd;">${formatMoney(order.totalAmount)}</td>
        </tr>
      </table>
    `;

    await transporter.sendMail({
      from: `"AMP Store Management" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: `Order #${order.orderNumber} - Status Updated to ${status}`,
      html: baseWrapper("Order Status Update 🔔", body),
    });

    console.log("Order status update email sent to user ✅");
  } catch (error) {
    console.error("Order status update email (user) failed:", error);
  }
};

module.exports = {
  sendNewOrderEmailToStore,
  sendOrderConfirmationToUser,
  sendOrderStatusUpdateToUser,
};
