const { z } = require("zod");
const { normalizePhone, isValidIndianMobile } = require("../helper/phone.js");

const addressSchema = z.object({
  label: z.enum(["HOME", "WORK", "OTHER"]).optional(),
  addressLine: z.string().trim().min(1, "Address line is required"),
  area: z.string().trim().optional(),
  city: z.string().trim().min(1, "City is required"),
  state: z.string().trim().min(1, "State is required"),
  pincode: z
    .string()
    .trim()
    .min(4, "Invalid pincode")
    .max(10, "Invalid pincode"),
  country: z.string().trim().optional(),
  isDefault: z.boolean().optional(),
});

// +91 / 0 / space soho jai-i asuk, 10 digit e normalize hoye validate hoy
const phoneField = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine(isValidIndianMobile, "Enter a valid 10-digit mobile number");

const otpField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "OTP must be 6 digits");

const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),

  email: z.string().email("Invalid email format").toLowerCase(),

  phone: phoneField,

  password: z.string().min(6, "Password must be at least 6 characters"),

  role: z.enum(["ADMIN", "STORE", "USER"]).optional(),

  isActive: z.boolean().optional(),

  address: addressSchema.optional(),
});

// address ekhon alada API (/addresses) diye manage hoy, tai ekhane nei
const updateUserSchema = z.object({
  name: z.string().min(2).optional(),

  email: z.string().email().toLowerCase().optional(),

  phone: phoneField.optional(),

  role: z.enum(["ADMIN", "STORE"]).optional(),

  isActive: z.boolean().optional(),
});

// purono email + password login (ekhon use hocche na, onno jaygay import thakle bhangbe na)
const loginSchema = z.object({
  email: z.string().email("Invalid email"),

  password: z.string().min(6, "Password is required"),
});

// ---------- phone OTP ----------
const sendPhoneOtpSchema = z.object({
  phone: phoneField,
});

const verifyPhoneOtpSchema = z.object({
  phone: phoneField,
  otp: otpField,
});

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Valid email is required");

const roleField = z.enum(["ADMIN", "STORE", "USER"]);

const sendOtpSchema = z.object({
  email: emailField,
  role: roleField,
});

const verifyOtpSchema = z.object({
  email: emailField,
  role: roleField,
  otp: otpField,
});

const resetPasswordSchema = z
  .object({
    resetToken: z.string().min(1, "Reset token is required"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Confirm password is required"),
  })
  .refine((d) => d.password === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

const loginWithOtpSchema = z.object({
  resetToken: z.string().min(1, "Reset token is required"),
});

const addAddressSchema = addressSchema;
const updateAddressSchema = addressSchema.partial();

module.exports = {
  createUserSchema,
  updateUserSchema,
  loginSchema,
  emailField,
  sendOtpSchema,
  verifyOtpSchema,
  sendPhoneOtpSchema,
  verifyPhoneOtpSchema,
  resetPasswordSchema,
  loginWithOtpSchema,
  addAddressSchema,
  updateAddressSchema,
};