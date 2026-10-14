const nodemailer = require("nodemailer");

const sendStoreVerifyEmail = async (toEmail, storeName, storeUniqueId) => {
  try {

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: `"AMP Store Management" <${process.env.EMAIL_USER}>`,
      to: toEmail,
      subject: "Your Store is Verified 🎉",
      html: `
        <div style="font-family: Arial; max-width:600px; margin:auto; padding:20px; border:1px solid #ddd; border-radius:10px; background:#f9f9f9;">
          
          <h2 style="color:#2E86C1; text-align:center;">
            Store Verified Successfully 🚀
          </h2>

          <p>Hello,</p>

          <p>Your store has been <strong style="color:green;">verified</strong> by the admin.</p>

          <table style="width:100%; border-collapse: collapse; margin-top:20px;">
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Store Name</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${storeName}</td>
            </tr>
            <tr>
              <td style="padding:10px; border:1px solid #ddd;"><strong>Store ID</strong></td>
              <td style="padding:10px; border:1px solid #ddd;">${storeUniqueId}</td>
            </tr>
          </table>

          <p style="margin-top:20px;">
            🎉 Now your store is live and you can login & manage your products.
          </p>

          <p style="margin-top:30px;">
            Regards,<br/>
            <strong>AMP Store Management Team</strong>
          </p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);

    console.log("Store verification email sent ✅");

  } catch (error) {
    console.error("Store verify email failed:", error);
  }
};

module.exports = sendStoreVerifyEmail;