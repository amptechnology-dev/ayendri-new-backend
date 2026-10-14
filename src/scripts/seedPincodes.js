require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const mongoose = require("mongoose");
const PincodeModel = require("../model/pincode.model.js");

// usage (backend folder theke): node src/scripts/seedPincodes.js ./geonames/IN.txt
// GeoNames IN.txt columns (tab separated):
// 0 country | 1 pincode | 2 place | 3 state | 4 stateCode | 5 district | 6 districtCode
// 7 admin3 | 8 admin3Code | 9 latitude | 10 longitude | 11 accuracy
const FILE = process.argv[2];
if (!FILE) {
  console.error("Usage: node src/scripts/seedPincodes.js <IN.txt>");
  process.exit(1);
}

const inIndia = (lat, lng) => lat >= 6 && lat <= 38 && lng >= 68 && lng <= 98;

(async () => {
  // ek pincode e onek place thake -> lat/lng er average nei
  const map = new Map();
  let totalRows = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(FILE, "utf8"),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalRows += 1;

    const c = line.split("\t");
    const pin = (c[1] || "").trim();
    const lat = parseFloat(c[9]);
    const lng = parseFloat(c[10]);

    if (!/^[1-9][0-9]{5}$/.test(pin)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (!inIndia(lat, lng)) continue;

    const cur = map.get(pin) || {
      latSum: 0,
      lngSum: 0,
      n: 0,
      area: (c[2] || "").trim(),
      state: (c[3] || "").trim(),
      district: (c[5] || "").trim(),
    };
    cur.latSum += lat;
    cur.lngSum += lng;
    cur.n += 1;
    map.set(pin, cur);
  }

  console.log(`Rows read: ${totalRows}, valid unique pincodes: ${map.size}`);
  if (map.size === 0) {
    console.error("Kono valid pincode paoa gelo na. File ta ki GeoNames IN.txt?");
    process.exit(1);
  }

  await mongoose.connect(process.env.DB);

  const ops = [...map.entries()].map(([pincode, v]) => ({
    updateOne: {
      filter: { pincode },
      update: {
        $set: {
          pincode,
          area: v.area,
          district: v.district,
          state: v.state,
          location: {
            type: "Point",
            coordinates: [v.lngSum / v.n, v.latSum / v.n],
          },
        },
      },
      upsert: true,
    },
  }));

  for (let i = 0; i < ops.length; i += 1000) {
    await PincodeModel.bulkWrite(ops.slice(i, i + 1000));
    console.log(`Seeded ${Math.min(i + 1000, ops.length)} / ${ops.length}`);
  }

  await PincodeModel.syncIndexes();
  console.log("Done");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});