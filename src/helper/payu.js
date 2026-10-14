const crypto = require("crypto");

const PAYU_KEY = process.env.PAYU_KEY;
const PAYU_SALT = process.env.PAYU_SALT;
const IS_TEST = process.env.PAYU_TEST_MODE === "true";

const PAYU_PAYMENT_URL = IS_TEST
  ? "https://test.payu.in/_payment"
  : "https://secure.payu.in/_payment";

const PAYU_VERIFY_URL = IS_TEST
  ? "https://test.payu.in/merchant/postservice?form=2"
  : "https://info.payu.in/merchant/postservice?form=2";

const sha512 = (str) => crypto.createHash("sha512").update(str).digest("hex");

// key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT
const generateRequestHash = ({
  txnid,
  amount,
  productinfo,
  firstname,
  email,
  udf1 = "",
  udf2 = "",
  udf3 = "",
  udf4 = "",
  udf5 = "",
}) =>
  sha512(
    [
      PAYU_KEY,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      udf1,
      udf2,
      udf3,
      udf4,
      udf5,
      "",
      "",
      "",
      "",
      "",
      PAYU_SALT,
    ].join("|"),
  );

// reverse: SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key
const generateResponseHash = (p) =>
  sha512(
    [
      PAYU_SALT,
      p.status,
      "",
      "",
      "",
      "",
      "",
      p.udf5 || "",
      p.udf4 || "",
      p.udf3 || "",
      p.udf2 || "",
      p.udf1 || "",
      p.email || "",
      p.firstname || "",
      p.productinfo || "",
      p.amount || "",
      p.txnid || "",
      PAYU_KEY,
    ].join("|"),
  );

const isValidResponseHash = (p) => {
  if (!p?.hash) return false;
  const expected = generateResponseHash(p);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(p.hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Server-to-server verify (webhook miss / user browser close korle)
const verifyPaymentWithPayU = async (txnid) => {
  const command = "verify_payment";
  const hash = sha512(`${PAYU_KEY}|${command}|${txnid}|${PAYU_SALT}`);

  const body = new URLSearchParams({
    key: PAYU_KEY,
    command,
    var1: txnid,
    hash,
  });

  const resp = await fetch(PAYU_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await resp.json();
  return json?.transaction_details?.[txnid] || null;
};

module.exports = {
  PAYU_KEY,
  PAYU_PAYMENT_URL,
  generateRequestHash,
  isValidResponseHash,
  verifyPaymentWithPayU,
};