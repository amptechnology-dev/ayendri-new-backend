const { z } = require("zod");

const optionalUrl = z
  .string()
  .trim()
  .url("Invalid URL")
  .or(z.literal(""))
  .optional();
const optionalPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9]{10,15}$/, "Invalid phone number")
  .or(z.literal(""))
  .optional();
const optionalEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email")
  .or(z.literal(""))
  .optional();

const addressSchema = z.object({
  addressLine: z.string().trim().optional(),
  area: z.string().trim().optional(),
  city: z.string().trim().optional(),
  state: z.string().trim().optional(),
  pincode: z.string().trim().optional(),
  country: z.string().trim().optional(),
});

const upsertCompanySchema = z
  .object({
    companyName: z.string().trim().min(2, "Company name is required"),
    companyPhone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{10,15}$/, "Invalid phone number"),
    // optional now (empty string clears it)
    companyEmail: optionalEmail,

    whatsappNo: optionalPhone,
    supportPhone: optionalPhone,
    supportEmail: optionalEmail,
    website: optionalUrl,
    description: z.string().trim().max(1000).optional(),

    address: addressSchema.optional(),

    socialLinks: z
      .object({
        facebookUrl: optionalUrl,
        instagramUrl: optionalUrl,
        twitterUrl: optionalUrl,
        linkedinUrl: optionalUrl,
        youtubeUrl: optionalUrl,
      })
      .optional(),
  })
  .strict();

module.exports = { upsertCompanySchema };