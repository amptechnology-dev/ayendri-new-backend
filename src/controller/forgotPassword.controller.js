const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const UserModel = require("../model/user.model.js");
const EmailVerificationModel = require("../model/otpverify.js");
const transporter = require("../helper/emailtransporter.js");
const {
  generateAuthToken,
  setAuthCookie,
  buildResponseUser,
} = require("../helper/authToken");
const {
  sendOtpSchema,
  verifyOtpSchema,
  resetPasswordSchema,
  loginWithOtpSchema,
} = require("../schema/user.schema.js");

// ===================== CONSTANTS =====================
const PURPOSE = "FORGOT_PASSWORD";
const OTP_EXPIRY_MINUTES = 15; // model er TTL (15m) er sathe mil rakho
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const RESET_TOKEN_EXPIRY = "10m";

// reset token er jonno alada secret: login token er sathe mishe jabe na,
// tai reset token diye kokhono API access paoa jabe na
const RESET_SECRET =
  process.env.RESET_TOKEN_SECRET ||
  `${process.env.TOKEN_SECRET}:password-reset`;

// ===================== HELPERS =====================
const httpError = (statusCode, message) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const handleError = (res, error, label) => {
  if (error.name === "ZodError") {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      })),
    });
  }
  if (error.statusCode) {
    return res
      .status(error.statusCode)
      .json({ success: false, message: error.message });
  }
  console.error(`${label}:`, error);
  return res
    .status(500)
    .json({ success: false, message: "Internal server error" });
};

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

// OTP DB te plain thakbe na, HMAC hash thakbe
const hashOtp = (otp) =>
  crypto.createHmac("sha256", process.env.TOKEN_SECRET).update(otp).digest("hex");

const isOtpMatch = (plainOtp, storedHash) => {
  const a = Buffer.from(hashOtp(plainOtp));
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const buildOtpEmail = (name, otp) => `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;border:1px solid #e5e7eb;border-radius:8px">
    <h2 style="margin:0 0 12px;color:#1d4ed8">Password Reset OTP</h2>
    <p>Hello ${name || "there"},</p>
    <p>Use the OTP below to continue. It is valid for ${OTP_EXPIRY_MINUTES} minutes.</p>
    <div style="font-size:32px;letter-spacing:8px;font-weight:bold;text-align:center;margin:20px 0;color:#111827">${otp}</div>
    <p style="color:#6b7280;font-size:13px">If you did not request this, you can safely ignore this email.</p>
  </div>
`;

// reset token verify kore, OTP record atomically delete kore (single-use),
// tarpor user return kore. Ekta token diye shudhu ekta action-i hobe.
const consumeResetToken = async (resetToken) => {
  let decoded;
  try {
    decoded = jwt.verify(resetToken, RESET_SECRET);
  } catch {
    throw httpError(
      401,
      "Reset session expired or invalid. Please verify OTP again.",
    );
  }

  if (decoded.purpose !== "PASSWORD_RESET") {
    throw httpError(401, "Invalid reset token");
  }

  const record = await EmailVerificationModel.findOneAndDelete({
    _id: decoded.otpId,
    userId: decoded.userId,
    purpose: PURPOSE,
    verified: true,
  });
  if (!record) {
    throw httpError(
      401,
      "Reset session already used or expired. Please request a new OTP.",
    );
  }

  const user = await UserModel.findById(decoded.userId);
  if (!user) throw httpError(404, "User not found");

  return user;
};

// ===================== 1. SEND OTP =====================
// POST /forgot-password/send-otp   body: { email }
const sendForgotPasswordOtp = async (req, res) => {
  try {
    const { email, role } = sendOtpSchema.parse(req.body);

    // email registered ki na, seta jeno bahire theke bojha na jay
    const genericResponse = {
      success: true,
      message: "If this email is registered, an OTP has been sent.",
    };

    const user = await UserModel.findOne({ email, role });
    if (!user) return res.status(200).json(genericResponse);

    // resend cooldown
    const last = await EmailVerificationModel.findOne({
      userId: user._id,
      purpose: PURPOSE,
    })
      .sort({ createdAt: -1 })
      .lean();

    if (last) {
      const waitSeconds = Math.ceil(
        (new Date(last.createdAt).getTime() +
          RESEND_COOLDOWN_SECONDS * 1000 -
          Date.now()) /
          1000,
      );
      if (waitSeconds > 0) {
        return res.status(429).json({
          success: false,
          message: `Please wait ${waitSeconds}s before requesting a new OTP`,
          retryAfter: waitSeconds,
        });
      }
    }

    // purono forgot-password OTP gulo muche notun ta banao
    await EmailVerificationModel.deleteMany({
      userId: user._id,
      purpose: PURPOSE,
    });

    const otp = generateOtp();
    const record = await EmailVerificationModel.create({
      userId: user._id,
      otp: hashOtp(otp),
      purpose: PURPOSE,
    });

    // development e mail setup na thakle terminal theke OTP dekhe test korte parbe
    if (process.env.NODE_ENV !== "production") {
      console.log(`[DEV] Forgot password OTP for ${email}: ${otp}`);
    }

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: "Your Password Reset OTP",
        html: buildOtpEmail(user.name, otp),
      });
    } catch (mailErr) {
      // mail na gele OTP rekhe lav nei
      await EmailVerificationModel.deleteOne({ _id: record._id });
      console.error("Forgot password mail error:", mailErr);
      throw httpError(500, "Unable to send OTP email. Please try again later.");
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    return handleError(res, error, "Send Forgot Password OTP Error");
  }
};

// ===================== 2. VERIFY OTP =====================
// POST /forgot-password/verify-otp   body: { email, otp }
const verifyForgotPasswordOtp = async (req, res) => {
  try {
    const { email, otp, role } = verifyOtpSchema.parse(req.body);

    const invalidResponse = () =>
      res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
      });

    const user = await UserModel.findOne({ email, role });
    if (!user) return invalidResponse();

    // attempt count atomically barao, tarpor check koro (parallel guess rokhe)
    const record = await EmailVerificationModel.findOneAndUpdate(
      { userId: user._id, purpose: PURPOSE, verified: false },
      { $inc: { attempts: 1 } },
      { new: true, sort: { createdAt: -1 } },
    );
    if (!record) return invalidResponse();

    if (record.attempts > MAX_ATTEMPTS) {
      await EmailVerificationModel.deleteOne({ _id: record._id });
      return res.status(429).json({
        success: false,
        message: "Too many wrong attempts. Please request a new OTP.",
      });
    }

    if (!isOtpMatch(otp, record.otp)) {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired OTP",
        attemptsLeft: Math.max(MAX_ATTEMPTS - record.attempts, 0),
      });
    }

    // OTP thik: verified mark koro, tarpor short-lived single-use reset token dao
    await EmailVerificationModel.updateOne(
      { _id: record._id },
      { $set: { verified: true } },
    );

    const resetToken = jwt.sign(
      {
        userId: String(user._id),
        otpId: String(record._id),
        purpose: "PASSWORD_RESET",
      },
      RESET_SECRET,
      { expiresIn: RESET_TOKEN_EXPIRY },
    );

    return res.status(200).json({
      success: true,
      message: "OTP verified successfully",
      resetToken,
      // frontend ei duto option dekhabe
      options: ["CHANGE_PASSWORD", "LOGIN_DIRECTLY"],
    });
  } catch (error) {
    return handleError(res, error, "Verify Forgot Password OTP Error");
  }
};

// ===================== 3A. CHANGE PASSWORD =====================
// POST /forgot-password/reset-password
// body: { resetToken, password, confirmPassword }
const resetPasswordWithOtp = async (req, res) => {
  try {
    // age password validate, jeno vul password dile reset session nosto na hoy
    const { resetToken, password } = resetPasswordSchema.parse(req.body);

    const user = await consumeResetToken(resetToken);

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    await UserModel.updateOne(
      { _id: user._id },
      { $set: { password: hashedPassword } },
    );

    return res.status(200).json({
      success: true,
      message: "Password changed successfully. Please login with your new password.",
    });
  } catch (error) {
    return handleError(res, error, "Reset Password With OTP Error");
  }
};

// ===================== 3B. LOGIN DIRECTLY (password change na kore) =====================
// POST /forgot-password/login-with-otp   body: { resetToken }
const loginWithOtp = async (req, res) => {
  try {
    const { resetToken } = loginWithOtpSchema.parse(req.body);

    const user = await consumeResetToken(resetToken);

    // normal login er moto-i account verified hote hobe
    if (!user.isVerified) {
      throw httpError(401, "Your account is not verified");
    }

    const token = generateAuthToken(user);
    setAuthCookie(res, token);

    return res.status(200).json({
      message: "Login successful",
      token,
      user: buildResponseUser(user),
    });
  } catch (error) {
    return handleError(res, error, "Login With OTP Error");
  }
};

module.exports = {
  sendForgotPasswordOtp,
  verifyForgotPasswordOtp,
  resetPasswordWithOtp,
  loginWithOtp,
};