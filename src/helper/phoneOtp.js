const crypto = require("crypto");
const PhoneOtpModel = require("../model/phoneOtp.model.js");
const { sendOtpSms } = require("./sendOtpSms.js");

const OTP_TTL_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

const fail = (status, message, extra = {}) => ({
  ok: false,
  status,
  message,
  ...extra,
});

// phone-er sathe bind kora HMAC, DB leak holeo OTP boshano jay na
const hashOtp = (phone, otp) =>
  crypto
    .createHmac("sha256", process.env.TOKEN_SECRET)
    .update(`${phone}:${otp}`)
    .digest("hex");

const safeEqual = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// notun OTP toiri kore SMS pathay. SMS fail korle throw kore.
const issuePhoneOtp = async (phone, purpose) => {
  const existing = await PhoneOtpModel.findOne({ phone, purpose }).lean();
  if (existing) {
    const elapsed = Date.now() - new Date(existing.lastSentAt).getTime();
    if (elapsed < RESEND_COOLDOWN_MS) {
      const retryAfter = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000);
      return fail(
        429,
        `Please wait ${retryAfter}s before requesting a new OTP`,
        { retryAfter },
      );
    }
  }

  const otp = String(crypto.randomInt(100000, 1000000));

  await PhoneOtpModel.findOneAndUpdate(
    { phone, purpose },
    {
      $set: {
        otpHash: hashOtp(phone, otp),
        attempts: 0,
        lastSentAt: new Date(),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );

  try {
    await sendOtpSms(phone, otp);
  } catch (error) {
    // SMS jai-ni, tai cooldown e atke na thakuk
    await PhoneOtpModel.deleteOne({ phone, purpose });
    throw error;
  }

  return { ok: true };
};

// OTP check kore, consume kore na (clearPhoneOtp alada)
const verifyPhoneOtpCode = async (phone, purpose, otp) => {
  const record = await PhoneOtpModel.findOne({ phone, purpose });

  if (!record || record.expiresAt.getTime() < Date.now()) {
    return fail(400, "OTP expired or not found. Please request a new one.");
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return fail(429, "Too many wrong attempts. Please request a new OTP.");
  }

  if (!safeEqual(hashOtp(phone, String(otp)), record.otpHash)) {
    await PhoneOtpModel.updateOne(
      { _id: record._id },
      { $inc: { attempts: 1 } },
    );
    const left = MAX_ATTEMPTS - record.attempts - 1;
    return fail(
      400,
      left > 0
        ? `Incorrect OTP. ${left} attempt(s) left`
        : "Incorrect OTP. Please request a new one",
    );
  }

  return { ok: true };
};

const clearPhoneOtp = (phone, purpose) =>
  PhoneOtpModel.deleteMany({ phone, purpose });

module.exports = { issuePhoneOtp, verifyPhoneOtpCode, clearPhoneOtp };