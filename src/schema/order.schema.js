const { z } = require("zod");

const objectIdSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{24}$/, "Invalid ObjectId");

const ORDER_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "SHIPPED",
  "DELIVERED",
  "CANCELLED",
];

// [PAYMENT] COD ar PayU online
const PAYMENT_METHODS = ["COD", "ONLINE"];

// ---- Date helpers (YYYY-MM-DD, aajker (IST) ba tar por) ----
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const todayIST = () =>
  new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

const isValidYmd = (v) => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

const deliveryDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Delivery date must be in YYYY-MM-DD format")
  .refine(isValidYmd, "Invalid delivery date")
  .refine((v) => v >= todayIST(), "Delivery date cannot be in the past");

const bookingDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Booking date must be in YYYY-MM-DD format")
  .refine(isValidYmd, "Invalid booking date")
  .refine((v) => v >= todayIST(), "Booking date cannot be in the past");

const optionalBookingDate = z.preprocess(
  (v) => (v === "" || v === null ? undefined : v),
  bookingDateSchema.optional(),
);

const deliveryAddressInputSchema = z.object({
  fullName: z.string().trim().min(1, "Full name is required"),
  phone: z.string().trim().min(10, "Valid phone number is required"),
  addressLine: z.string().trim().min(1, "Address is required"),
  area: z.string().trim().optional(),
  city: z.string().trim().min(1, "City is required"),
  state: z.string().trim().min(1, "State is required"),
  pincode: z.string().trim().min(3, "Enter a valid postal code").max(12),
  country: z.string().trim().optional(),
});

// ---- Cart theke checkout (multiple store, multiple item) ----
const cartCheckoutSchema = z.object({
  cartId: objectIdSchema,
  storeIds: z.array(objectIdSchema).optional(),
  deliveryAddress: deliveryAddressInputSchema,
  note: z.string().trim().optional(),
  bookingDate: optionalBookingDate, // [BOOKING] optional
  paymentMethod: z.enum(PAYMENT_METHODS).default("COD"),
});

// ---- Product theke direct "Buy Now" (cart chara, ekta product + optional variant) ----
const directCheckoutSchema = z.object({
  productId: objectIdSchema,
  variantId: objectIdSchema.optional(),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be at least 1")
    .default(1),
  deliveryAddress: deliveryAddressInputSchema,
  note: z.string().trim().optional(),
  bookingDate: optionalBookingDate, // [BOOKING] optional
  paymentMethod: z.enum(PAYMENT_METHODS).default("COD"),
});

const REQUEST_TYPES = ["RETURN", "REPLACE", "REFUND"];
const REASON_CODES = [
  "SIZE_MISMATCH",
  "PRODUCT_DAMAGE",
  "WRONG_PRODUCT",
  "NOT_AS_DESCRIBED",
  "QUALITY_ISSUE",
  "OTHER",
];

// refund pawar jonno bank account (holder + number + ifsc) ba UPI id
const bankDetailsSchema = z
  .object({
    accountHolder: z
      .string()
      .trim()
      .min(2, "Account holder name is required")
      .max(80)
      .optional(),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{9,18}$/, "Enter a valid account number")
      .optional(),
    ifsc: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC code")
      .optional(),
    bankName: z.string().trim().max(80).optional(),
    upiId: z
      .string()
      .trim()
      .regex(/^[\w.\-]{2,256}@[a-zA-Z]{2,64}$/, "Enter a valid UPI ID")
      .optional(),
  })
  .refine((b) => (b.accountHolder && b.accountNumber && b.ifsc) || b.upiId, {
    message: "Enter bank account details or a UPI ID",
  });

// cancel e reason mandatory. Paid order hole bankDetails controller e check hoy
const cancelOrderSchema = z.object({
  reason: z
    .string({ required_error: "Cancellation reason is required" })
    .trim()
    .min(3, "Cancellation reason must be at least 3 characters")
    .max(300),
  bankDetails: bankDetailsSchema.optional(),
});

// return / replace / refund request (delivered order er item e)
const createRequestSchema = z
  .object({
    itemId: objectIdSchema,
    type: z.enum(REQUEST_TYPES),
    reasonCode: z.enum(REASON_CODES, {
      errorMap: () => ({ message: "Select a reason" }),
    }),
    reason: z.string().trim().max(300).optional(),
    bankDetails: bankDetailsSchema.optional(),
  })
  .superRefine((d, ctx) => {
    if (d.reasonCode === "OTHER" && (!d.reason || d.reason.length < 3)) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Please write your reason",
      });
    }
    if (d.type === "REFUND" && !d.bankDetails) {
      ctx.addIssue({
        code: "custom",
        path: ["bankDetails"],
        message: "Bank details or a UPI ID is required to receive your refund",
      });
    }
  });

const decideRequestSchema = z
  .object({
    action: z.enum(["APPROVE", "REJECT"]),
    note: z.string().trim().max(300).optional(),
  })
  .superRefine((d, ctx) => {
    if (d.action === "REJECT" && (!d.note || d.note.length < 3)) {
      ctx.addIssue({
        code: "custom",
        path: ["note"],
        message: "Please give a reason for rejecting this request",
      });
    }
  });

const completeRequestSchema = z.object({
  referenceNo: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).optional(),
});

const updateOrderStatusSchema = z.object({
  status: z.enum(ORDER_STATUSES),
  note: z.string().trim().optional(),
  // SHIPPED korar somoy pathano jabe (order e age theke na thakle required)
  expectedDeliveryDate: deliveryDateSchema.optional(),
});

const updateDeliveryDateSchema = z.object({
  expectedDeliveryDate: deliveryDateSchema,
});

// ---- Price on request: store estimate pathay ----
const submitQuoteSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: objectIdSchema,
        unitPrice: z.coerce
          .number({ invalid_type_error: "Price must be a number" })
          .positive("Price must be greater than 0")
          .max(10000000, "Price is too large"),
      }),
    )
    .min(1, "At least one item price is required"),
  note: z.string().trim().max(300).optional(),
});

// ---- Price on request: user accept / reject ----
const respondQuoteSchema = z.object({
  action: z.enum(["ACCEPT", "REJECT"]),
  reason: z.string().trim().max(300).optional(),
});

// ---- [PAYMENT] PayU payment initiate ----
// body puro optional, Postman e {} pathalei cholbe
const initiatePaymentSchema = z.object({
  returnUrl: z.string().url().optional(),
});

module.exports = {
  ORDER_STATUSES,
  PAYMENT_METHODS,
  cartCheckoutSchema,
  directCheckoutSchema,
  cancelOrderSchema,
  updateOrderStatusSchema,
  updateDeliveryDateSchema,
  submitQuoteSchema,
  respondQuoteSchema,
  initiatePaymentSchema,
};
