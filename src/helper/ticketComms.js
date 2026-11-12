const transporter = require("./emailtransporter");
const UserModel = require("../model/user.model.js");
const StoreModel = require("../model/store.model.js");
const { normalizePhone, isValidIndianMobile } = require("./phone.js");
const { sendTicketSms } = require("./sendTicketSms.js");

const STATUS_LABEL = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const layout = (heading, rows) => `
  <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:16px;border:1px solid #eee;border-radius:8px">
    <h2 style="color:#6b1f2a;margin:0 0 12px">${esc(heading)}</h2>
    ${rows
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<p style="margin:6px 0;font-size:14px"><b>${esc(k)}:</b><br/>${esc(v).replace(/\n/g, "<br/>")}</p>`,
      )
      .join("")}
    <p style="margin-top:16px;font-size:12px;color:#888">This is an automated message from AYENDRI Help Center.</p>
  </div>`;

// event: RAISED | UPDATED | CLOSED   audience: USER | STORE
const buildContent = (ticket, event, audience) => {
  const no = ticket.ticketNo;
  const customer = ticket.customerName || "Customer";
  const orderPart = ticket.orderNumber ? ` for order #${ticket.orderNumber}` : "";
  const status = STATUS_LABEL[ticket.status] || ticket.status;
  const fb = ticket.feedback;

  const base = [
    ["Ticket", `#${no}`],
    ["Subject", ticket.subject],
    ["Order", ticket.orderNumber ? `#${ticket.orderNumber}` : ""],
  ];

  if (event === "RAISED") {
    if (audience === "USER") {
      return {
        subject: `Ticket #${no} raised`,
        html: layout("Your ticket has been raised", [
          ...base,
          ["Complaint", ticket.description],
          ["Next", "Our support team will update you soon."],
        ]),
        sms: `AYENDRI: Ticket #${no} has been raised${orderPart}. We will update you soon.`,
      };
    }
    return {
      subject: `New ticket #${no} from ${customer}`,
      html: layout("New support ticket", [
        ...base,
        ["Customer", `${customer} ${ticket.phoneNumber || ""}`.trim()],
        ["Complaint", ticket.description],
      ]),
      sms: `AYENDRI: New ticket #${no}${orderPart} from ${customer}. Please check your Tickets page.`,
    };
  }

  if (event === "UPDATED") {
    const rows = [...base, ["Status", status], ["Solution", ticket.resolution]];
    if (audience === "USER") {
      return {
        subject: `Ticket #${no} is now ${status}`,
        html: layout(`Your ticket is ${status}`, rows),
        sms: `AYENDRI: Ticket #${no} status is now ${status}.`,
      };
    }
    return {
      subject: `Ticket #${no} updated to ${status}`,
      html: layout("Ticket updated", [...rows, ["Customer", customer]]),
      sms: `AYENDRI: Ticket #${no} updated to ${status}.`,
    };
  }

  // CLOSED
  const rating = fb ? `${fb.rating}/5` : "";
  if (audience === "USER") {
    return {
      subject: `Ticket #${no} closed`,
      html: layout("Your ticket has been closed", [
        ...base,
        ["Your rating", rating],
        ["Your feedback", fb?.comment],
      ]),
      sms: `AYENDRI: Ticket #${no} has been closed. Thank you for your feedback.`,
    };
  }
  return {
    subject: `Ticket #${no} closed by customer${rating ? ` (${rating})` : ""}`,
    html: layout("Customer closed the ticket", [
      ...base,
      ["Customer", customer],
      ["Rating", rating],
      ["Feedback", fb?.comment],
    ]),
    sms: `AYENDRI: Ticket #${no} closed by ${customer}${rating ? `, rating ${rating}` : ""}.`,
  };
};

// ---------- recipients ----------
const resolveParties = async (ticket) => {
  const [user, store] = await Promise.all([
    ticket.userId
      ? UserModel.findById(ticket.userId).select("email phone").lean()
      : null,
    StoreModel.findById(ticket.storeId)
      .select("email contactNo supportNo userId")
      .lean(),
  ]);
  const owner = store?.userId
    ? await UserModel.findById(store.userId).select("email phone").lean()
    : null;

  return {
    USER: {
      email: user?.email || "",
      phone: user?.phone || ticket.phoneNumber || "",
    },
    STORE: {
      email: store?.email || owner?.email || "",
      phone: store?.supportNo || store?.contactNo || owner?.phone || "",
    },
  };
};

const sendEmail = async (to, subject, html) => {
  if (!to) return;
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  });
};

const sendSms = async (rawPhone, event, ticket) => {
  const phone = normalizePhone(rawPhone);
  if (!isValidIndianMobile(phone)) return;
  await sendTicketSms(phone, event, {
    ticketNo: ticket.ticketNo,
    status: STATUS_LABEL[ticket.status] || ticket.status,
  });
};

// fire-and-forget: caller await korbe na, kokhono throw korbe na
const notifyTicketParties = (ticket, event) => {
  (async () => {
    const parties = await resolveParties(ticket);
    const jobs = [];

    for (const audience of ["USER", "STORE"]) {
      const p = parties[audience];
      const c = buildContent(ticket, event, audience);
      jobs.push(
        sendEmail(p.email, c.subject, c.html),
        sendSms(p.phone, event, ticket),
      );
    }

    const results = await Promise.allSettled(jobs);
    results
      .filter((r) => r.status === "rejected")
      .forEach((r) =>
        console.error("ticket comms:", r.reason?.message || r.reason),
      );
  })().catch((e) => console.error("ticket comms:", e.message));
};

module.exports = { notifyTicketParties };