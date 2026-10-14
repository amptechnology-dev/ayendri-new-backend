require("dotenv").config();
const fs = require("fs");
const readline = require("readline");
const mongoose = require("mongoose");
const PincodeModel = require("../model/pincode.model.js");

// usage (backend folder theke): node src/scripts/fillMissingPincodes.js ./pincodes.csv
const FILE = process.argv[2];
if (!FILE) {
  console.error("Usage: node src/scripts/fillMissingPincodes.js <csv-file>");
  process.exit(1);
}

// quote soho simple CSV line parser
const parseLine = (line) => {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else inQuote = false;
      } else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
};

const norm = (h) => h.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z]/g, "");

const addTo = (map, key, lat, lng) => {
  const cur = map.get(key) || { latSum: 0, lngSum: 0, n: 0 };
  cur.latSum += lat;
  cur.lngSum += lng;
  cur.n += 1;
  map.set(key, cur);
};

const avg = (v) => [v.lngSum / v.n, v.latSum / v.n]; // [lng, lat]

(async () => {
  // ---------- 1. CSV theke pincode + naam ----------
  const csvMap = new Map();
  const rl = readline.createInterface({
    input: fs.createReadStream(FILE, "utf8"),
    crlfDelay: Infinity,
  });

  let idx = null;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseLine(line);

    if (!idx) {
      const names = cols.map(norm);
      idx = {
        pin: names.indexOf("pincode"),
        office: names.indexOf("postofficename"),
        district: names.indexOf("districtsname"),
        state: names.indexOf("state"),
      };
      if (idx.pin === -1) {
        console.error("CSV te 'Pincode' column paoa gelo na");
        process.exit(1);
      }
      continue;
    }

    const pin = (cols[idx.pin] || "").trim();
    if (!/^[1-9][0-9]{5}$/.test(pin) || csvMap.has(pin)) continue;
    csvMap.set(pin, {
      area: idx.office >= 0 ? (cols[idx.office] || "").trim() : "",
      district: idx.district >= 0 ? (cols[idx.district] || "").trim() : "",
      state: idx.state >= 0 ? (cols[idx.state] || "").trim() : "",
    });
  }

  // ---------- 2. DB te ki ache ----------
  await mongoose.connect(process.env.DB);

  const all = await PincodeModel.find().select("pincode -_id").lean();
  const existing = new Set(all.map((d) => d.pincode));

  // average shudhu real (GeoNames) pincode theke, approx ta theke noy
  const real = await PincodeModel.find({
    source: { $in: [null, "GEONAMES"] },
  })
    .select("pincode location -_id")
    .lean();

  const p5 = new Map();
  const p4 = new Map();
  const p3 = new Map();
  for (const d of real) {
    const [lng, lat] = d.location.coordinates;
    addTo(p5, d.pincode.slice(0, 5), lat, lng);
    addTo(p4, d.pincode.slice(0, 4), lat, lng);
    addTo(p3, d.pincode.slice(0, 3), lat, lng);
  }

  // ---------- 3. missing gulo fill ----------
  const stats = { PREFIX_5: 0, PREFIX_4: 0, PREFIX_3: 0, skipped: 0 };
  const ops = [];

  for (const [pin, meta] of csvMap.entries()) {
    if (existing.has(pin)) continue;

    let coords = null;
    let source = null;
    if (p5.has(pin.slice(0, 5))) {
      coords = avg(p5.get(pin.slice(0, 5)));
      source = "PREFIX_5";
    } else if (p4.has(pin.slice(0, 4))) {
      coords = avg(p4.get(pin.slice(0, 4)));
      source = "PREFIX_4";
    } else if (p3.has(pin.slice(0, 3))) {
      coords = avg(p3.get(pin.slice(0, 3)));
      source = "PREFIX_3";
    }

    if (!coords) {
      stats.skipped += 1;
      continue;
    }
    stats[source] += 1;

    ops.push({
      updateOne: {
        filter: { pincode: pin },
        update: {
          $set: {
            pincode: pin,
            area: meta.area,
            district: meta.district,
            state: meta.state,
            source,
            location: { type: "Point", coordinates: coords },
          },
        },
        upsert: true,
      },
    });
  }

  for (let i = 0; i < ops.length; i += 1000) {
    await PincodeModel.bulkWrite(ops.slice(i, i + 1000));
    console.log(`Filled ${Math.min(i + 1000, ops.length)} / ${ops.length}`);
  }

  console.log("Result:", stats);
  console.log("Done");
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});