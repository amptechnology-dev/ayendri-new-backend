const { z } = require("zod");

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

const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),

  email: z.string().email("Invalid email format").toLowerCase(),

  phone: z
    .string()
    .min(10, "Phone number must be at least 10 digits")
    .max(11, "Phone number too long")
    .optional(),

  password: z.string().min(6, "Password must be at least 6 characters"),

  role: z.enum(["ADMIN", "STORE", "USER"]).optional(),

  isActive: z.boolean().optional(),

  address: addressSchema.optional(),
});

// address ekhon alada API (/addresses) diye manage hoy, tai ekhane nei
const updateUserSchema = z.object({
  name: z.string().min(2).optional(),

  email: z.string().email().toLowerCase().optional(),

  phone: z.string().min(10).max(15).optional(),

  role: z.enum(["ADMIN", "STORE"]).optional(),

  isActive: z.boolean().optional(),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email"),

  password: z.string().min(6, "Password is required"),
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
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "OTP must be 6 digits"),
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
  resetPasswordSchema,
  loginWithOtpSchema,
  addAddressSchema,
  updateAddressSchema,
};