const nodemailer = require("nodemailer");

// HTML injection theke bachar jonno
const escapeHtml = (str = "") =>
  String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const sendStoreCredentialsEmail = async ({
  toEmail,
  ownerName,
  storeName,
  storeUniqueId,
  password,
}) => {
  try {
    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const loginUrl = process.env.FRONTEND_URL || "";

    const mailOptions = {
      from: `"AMP Store Management" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Your Store Account Has Been Created 🎉",
      html: `
        <div style="font-family: Arial; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px; background:#f9f9f9;">

          <h2 style="color:#2E86C1; text-align:center;">
            Welcome to AMP Store 🚀
          </h2>

          <p>Hello ${escapeHtml(ownerName) || ""},</p>

          <p>Your store account has been <strong style="color:green;">created</strong> by the admin. Use the credentials below to login.</p>

          <table style="width:100%; border-collapse: collapse; margin-top:20px;">
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Store Name</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${escapeHtml(storeName)}</td>
            </tr>
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Store ID</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${escapeHtml(storeUniqueId)}</td>
            </tr>
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Email</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${escapeHtml(toEmail)}</td>
            </tr>
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Password</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${escapeHtml(password)}</td>
            </tr>
          </table>

          ${
            loginUrl
              ? `<p style="text-align:center; margin-top:25px;">
                  <a href="${escapeHtml(loginUrl)}" style="background:#2E86C1; color:#fff; padding:10px 24px; border-radius:6px; text-decoration:none;">Login Now</a>
                </p>`
              : ""
          }

          <p style="margin-top:20px; color:#b03a2e;">
            ⚠️ For security, please change your password after your first login.
          </p>

          <p style="margin-top:30px;">
            Regards,<br/>
            <strong>AMP Store Management Team</strong>
          </p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log("Store credentials email sent ✅");
  } catch (error) {
    console.error("Store credentials email failed:", error);
  }
};

module.exports = sendStoreCredentialsEmail;
