require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const mongoose = require("mongoose");
const PincodeModel = require("../model/pincode.model.js");

// usage: node src/scripts/checkPincodes.js ./pincodes.csv
const FILE = process.argv[2];
if (!FILE) {
  console.error("Usage: node src/scripts/checkPincodes.js <csv-file>");
  process.exit(1);
}

(async () => {
  const csvPins = new Set();
  const rl = readline.createInterface({
    input: fs.createReadStream(FILE, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const m = line.match(/(?:^|,)"?([1-9][0-9]{5})"?(?=,|$)/);
    if (m) csvPins.add(m[1]);
  }

  await mongoose.connect(process.env.DB);
  const docs = await PincodeModel.find().select("pincode -_id").lean();
  const dbPins = new Set(docs.map((d) => d.pincode));

  const missing = [...csvPins].filter((p) => !dbPins.has(p));
  console.log(`CSV te unique pincode : ${csvPins.size}`);
  console.log(`DB te pincode         : ${dbPins.size}`);
  console.log(`DB te nei (missing)   : ${missing.length}`);
  console.log("Sample missing:", missing.slice(0, 30).join(", "));
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});