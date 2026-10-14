const nodemailer = require("nodemailer");

const sendPasswordEmail = async (toEmail, password, userName) => {
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
      subject: "Your AMP Store Management Account Credentials",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px; background-color: #f9f9f9;">
          <h2 style="color: #2E86C1; text-align: center;">Welcome to AMP Store Management 🎉</h2>
      
          <p>Your account has been created successfully. Below are your login credentials:</p>
          <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>Email</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${toEmail}</td>
            </tr>
            <tr>
              <td style="padding: 10px; border: 1px solid #ddd;"><strong>Password</strong></td>
              <td style="padding: 10px; border: 1px solid #ddd;">${password}</td>
            </tr>
          </table>

          <p style="color: #C0392B;"><strong>Note:</strong> This is your credential information. Please keep it secure. Contact your administrator if you verified then you can login with your store</p>

          <p style="margin-top: 30px;">Best Regards,<br><strong>AMP Store Management Team</strong></p>
        </div>
      `,
    };

    await transporter.sendMail(mailOptions);
    console.log("Password email sent successfully");
  } catch (error) {
    console.error("Email sending failed:", error);
    throw error;
  }
};


module.exports = sendPasswordEmail;