const axios = require("axios");

const MBOX_URL =
  process.env.MBOX_URL ||
  "http://text.mboxsolution.com/sms-panel/api/http/index.php";

// ⚠️ DLT te approved ei text er sathe hubohu milte hobe:
// "Ticket #{#var#} update: {#var#}. Please check your tickets page for details.- AMPTECH"
const statusText = (event, status) => {
  if (event === "RAISED") return "raised";
  if (event === "CLOSED") return "closed";
  return status; // UPDATED: Open / In Progress / Resolved
};

const buildMessage = (event, { ticketNo, status }) =>
  `Ticket #${ticketNo} update: ${statusText(event, status)}. Please check your tickets page for details.- AMPTECH`;

const sendTicketSms = async (phone, event, vars) => {
  const { MBOX_USERNAME, MBOX_API_KEY, MBOX_SENDER, MBOX_TEMPLATE_ID } =
    process.env;

  if (!MBOX_USERNAME || !MBOX_API_KEY || !MBOX_SENDER) {
    throw new Error("MBOX SMS env variables are not configured");
  }

  // OTP er MBOX_TEMPLATE_ID fallback hishebe use kora hoy ni: text mile na, SMS block hobe
  if (!MBOX_TEMPLATE_ID) {
    console.warn("Ticket SMS skipped: MBOX_TEMPLATE_ID_TICKET is not set");
    return false;
  }

  const { data } = await axios.get(MBOX_URL, {
    params: {
      username: MBOX_USERNAME,
      apikey: MBOX_API_KEY,
      apirequest: "Text",
      sender: MBOX_SENDER,
      mobile: phone,
      message: buildMessage(event, vars),
      route: "TRANS",
      TemplateID: MBOX_TEMPLATE_ID,
      format: "JSON",
    },
    timeout: 10000,
  });

  if (data?.status !== "success") {
    console.error("MBOX ticket SMS failed:", data);
    throw new Error("Failed to send ticket SMS");
  }
  return true;
};

module.exports = { sendTicketSms };