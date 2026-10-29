// 98765 43210 / +91 98765 43210 / 09876543210 -> 9876543210
const normalizePhone = (value) => {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return digits;
};

const isValidIndianMobile = (phone) => /^[6-9]\d{9}$/.test(phone);

module.exports = { normalizePhone, isValidIndianMobile };