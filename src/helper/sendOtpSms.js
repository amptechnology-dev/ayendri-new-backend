const axios = require("axios");

const MBOX_URL =
  process.env.MBOX_URL ||
  "http://text.mboxsolution.com/sms-panel/api/http/index.php";

const sendOtpSms = async (phone, otp) => {
  const { MBOX_USERNAME, MBOX_API_KEY, MBOX_SENDER, MBOX_TEMPLATE_ID } =
    process.env;

  if (!MBOX_USERNAME || !MBOX_API_KEY || !MBOX_SENDER || !MBOX_TEMPLATE_ID) {
    throw new Error("MBOX SMS env variables are not configured");
  }

  const message = `${otp} is your OTP to login into AYENDRI. Please do not share this OTP with anyone.- AMPTECH`;

  const { data } = await axios.get(MBOX_URL, {
    params: {
      username: MBOX_USERNAME,
      apikey: MBOX_API_KEY,
      apirequest: "Text",
      sender: MBOX_SENDER,
      mobile: phone,
      message,
      route: "TRANS",
      TemplateID: MBOX_TEMPLATE_ID,
      format: "JSON",
    },
    timeout: 10000,
  });

  if (data?.status !== "success") {
    console.error("MBOX SMS failed:", data);
    throw new Error("Failed to send SMS");
  }
  return true;
};

module.exports = { sendOtpSms };