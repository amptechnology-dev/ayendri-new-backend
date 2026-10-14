const path = require("path");
const os = require("os");
const fs = require("fs/promises");
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { uploadToR2 } = require("./upload.js");

// system ffmpeg use korte chaile .env te FFMPEG_PATH dao
ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || ffmpegPath);

// ---------- Video -> GIF settings ----------
const GIF_MAX_SECONDS = 15; // GIF max 15 second
const GIF_MIN_SECONDS = 0.2;
const GIF_FPS = 10;
const GIF_MAX_SHORT_SIDE = 1080; // resolution er upor limit (1080p, chhoto side)
const GIF_MIN_SHORT_SIDE = 240;
const GIF_MAX_BYTES = 30 * 1024 * 1024; // final GIF max 30MB
const GIF_TARGET_BYTES = Math.floor(GIF_MAX_BYTES * 0.85); // estimate e 15% safety margin
const GIF_SIZE_EXPONENT = 2; // GIF size ~ (short side)^2 (probe theke estimate)
const GIF_MAX_ATTEMPTS = 3;

const PROBE_SECONDS = 3; // choto sample encode kore size estimate
const PROBE_SHORT_SIDE = 360;

const FFMPEG_TIMEOUT_MS = 4 * 60 * 1000; // ek-ta encode er max time
const MAX_PARALLEL_CONVERSIONS = 2;

// ---------- Size limits (convert er age original file er upor) ----------
const MAX_BANNER_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_SOURCE_VIDEO_SIZE = 100 * 1024 * 1024; // 100MB (multer limit er sathe mil rakho)

// ---------- simple limiter (server er CPU bachate) ----------
let running = 0;
const waiting = [];

const acquireSlot = () => {
  if (running < MAX_PARALLEL_CONVERSIONS) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
};

const releaseSlot = () => {
  const next = waiting.shift();
  if (next)
    next(); // slot ta shorasori porer jon ke dao
  else running--;
};

const httpError = (message, statusCode = 400) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
};

const sanitizeName = (name = "") =>
  path
    .basename(name, path.extname(name))
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 50);

const buildFileName = (folder, file) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mediaFolder = file.mimetype.startsWith("video/") ? "videos" : "images";
  return `${folder}/${mediaFolder}/${Date.now()}-${Math.round(
    Math.random() * 1e9,
  )}-${sanitizeName(file.originalname)}${ext}`;
};

const isVideoFile = (file) => file.mimetype.startsWith("video/");

// ---------- Trim info ----------
// Frontend file er naam e trim pathay: "clip.__trim_12.50_27.50.mp4" (start_end, second e)
// Trim na thakle prothom 15 second nibe. Duration kokhono 15s er beshi hobe na.
const TRIM_TOKEN = /\.__trim_(\d+(?:\.\d+)?)_(\d+(?:\.\d+)?)(?=\.[^./\\]+$)/;

const parseTrim = (originalname = "") => {
  const match = originalname.match(TRIM_TOKEN);
  const cleanName = originalname.replace(TRIM_TOKEN, "");

  let start = 0;
  let duration = GIF_MAX_SECONDS;

  if (match) {
    const s = Number(match[1]);
    const e = Number(match[2]);
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
      start = s;
      duration = Math.min(e - s, GIF_MAX_SECONDS);
    }
  }

  duration = Math.round(Math.max(duration, GIF_MIN_SECONDS) * 100) / 100;
  return { cleanName, start, duration };
};

// ---------- ffmpeg helpers ----------
// chhoto side (width/height er jeta chhoto) = shortSide hobe, aspect ratio thik thakbe
const buildGifFilter = (shortSide, colors) =>
  `fps=${GIF_FPS},` +
  `scale=w='if(gte(iw,ih),-2,${shortSide})':h='if(gte(iw,ih),${shortSide},-2)':flags=lanczos,` +
  `split[s0][s1];[s0]palettegen=max_colors=${colors}[p];` +
  `[s1][p]paletteuse=dither=bayer:bayer_scale=4`;

const clampShortSide = (n) =>
  Math.max(
    GIF_MIN_SHORT_SIDE,
    Math.min(GIF_MAX_SHORT_SIDE, Math.floor(n / 2) * 2),
  );

const runGifEncode = ({
  inputPath,
  outputPath,
  start,
  duration,
  shortSide,
  colors,
}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const command = ffmpeg(inputPath)
      .seekInput(start) // fast seek: trim er start
      .noAudio()
      .duration(duration) // trim er length (max 15s)
      .outputOptions(["-vf", buildGifFilter(shortSide, colors), "-loop", "0"])
      .format("gif")
      .on("end", finish(resolve))
      .on("error", finish(reject));

    timer = setTimeout(() => {
      command.kill("SIGKILL");
      finish(reject)(new Error("ffmpeg timeout"));
    }, FFMPEG_TIMEOUT_MS);

    command.save(outputPath);
  });

// clip er majhkhan theke 3s ekta choto GIF baniye size mepe dekhi,
// tarpor 30MB er moddhe fit hoy emon shob cheye boro resolution ber kori (max 1080)
const estimateShortSide = async ({ inputPath, probePath, start, duration }) => {
  try {
    const probeDuration = Math.min(PROBE_SECONDS, duration);
    const probeStart = start + Math.max(0, (duration - probeDuration) / 2);

    await runGifEncode({
      inputPath,
      outputPath: probePath,
      start: probeStart,
      duration: probeDuration,
      shortSide: PROBE_SHORT_SIDE,
      colors: 256,
    });

    const { size } = await fs.stat(probePath);
    const bytesPerFrame = size / (GIF_FPS * probeDuration);
    const totalBytesAtProbeSize = bytesPerFrame * GIF_FPS * duration;
    const ratio = GIF_TARGET_BYTES / totalBytesAtProbeSize;

    return clampShortSide(
      PROBE_SHORT_SIDE * Math.pow(ratio, 1 / GIF_SIZE_EXPONENT),
    );
  } catch (error) {
    // probe fail hole safe default
    console.error("GIF size probe failed:", error.message);
    return 480;
  }
};

// video buffer -> gif buffer (max 15s, max 1080p, max 30MB)
const convertVideoToGifBuffer = async (file, { start, duration }) => {
  const id = crypto.randomUUID();
  const inputExt = path.extname(file.originalname).toLowerCase() || ".mp4";
  const inputPath = path.join(os.tmpdir(), `${id}${inputExt}`);
  const outputPath = path.join(os.tmpdir(), `${id}.gif`);
  const probePath = path.join(os.tmpdir(), `${id}-probe.gif`);

  try {
    await fs.writeFile(inputPath, file.buffer);

    let shortSide = await estimateShortSide({
      inputPath,
      probePath,
      start,
      duration,
    });
    let colors = 256;

    for (let attempt = 1; attempt <= GIF_MAX_ATTEMPTS; attempt++) {
      await runGifEncode({
        inputPath,
        outputPath,
        start,
        duration,
        shortSide,
        colors,
      });

      const { size } = await fs.stat(outputPath);
      if (size <= GIF_MAX_BYTES) {
        return await fs.readFile(outputPath);
      }

      // 30MB er beshi hoyeche: size ~ side^2 dhore resolution kombai, color o kombai
      if (shortSide <= GIF_MIN_SHORT_SIDE) break;
      shortSide = clampShortSide(
        shortSide * Math.sqrt(GIF_TARGET_BYTES / size),
      );
      colors = 128;
    }

    throw httpError(
      "This clip is too heavy to fit in 30MB. Please choose a shorter clip",
    );
  } catch (error) {
    if (error.statusCode) throw error;
    console.error("Video to GIF conversion failed:", error.message);
    throw httpError(
      "Video could not be converted to GIF. Please try a shorter clip or a different file",
    );
  } finally {
    await Promise.allSettled([
      fs.unlink(inputPath),
      fs.unlink(outputPath),
      fs.unlink(probePath),
    ]);
  }
};

// image hole ja ache tai (trim token bad diye), video hole gif file object baniye dey
const prepareMediaFile = async (file) => {
  const { cleanName, start, duration } = parseTrim(file.originalname);
  const cleanFile = { ...file, originalname: cleanName };

  if (!isVideoFile(file)) return cleanFile;

  await acquireSlot();
  try {
    const gifBuffer = await convertVideoToGifBuffer(cleanFile, {
      start,
      duration,
    });
    return {
      ...cleanFile,
      buffer: gifBuffer,
      size: gifBuffer.length,
      mimetype: "image/gif",
      originalname: `${sanitizeName(cleanName)}.gif`,
    };
  } finally {
    releaseSlot();
  }
};

// product + banner + ads shobar jonno common upload (video hole GIF hoye jay)
const uploadPreparedFile = async (folder, file) => {
  const prepared = await prepareMediaFile(file);
  return uploadToR2(
    prepared.buffer,
    buildFileName(folder, prepared),
    prepared.mimetype,
  );
};

const uploadSimpleImages = async (files = []) => {
  if (!files?.length) return [];

  const mediaFiles = files
    .filter((f) => /^image\d+$/.test(f.fieldname))
    // fieldname er number diye order thik rakhi
    .sort(
      (a, b) =>
        Number(a.fieldname.replace("image", "")) -
        Number(b.fieldname.replace("image", "")),
    );
  if (!mediaFiles.length) return [];

  return Promise.all(
    mediaFiles.map((file) => uploadPreparedFile("products", file)),
  );
};

const uploadVariantImages = async (files = []) => {
  if (!files?.length) return {};

  const variantFiles = files.filter((f) =>
    /^variantImage_\d+$/.test(f.fieldname),
  );
  if (!variantFiles.length) return {};

  const uploaded = await Promise.all(
    variantFiles.map(async (file) => {
      const idx = file.fieldname.split("_")[1];
      const url = await uploadPreparedFile("products/variants", file);
      return { idx, url };
    }),
  );

  return uploaded.reduce((map, { idx, url }) => {
    (map[idx] ||= []).push(url);
    return map;
  }, {});
};

// original file er size check (video: 100MB, image: 5MB)
const assertBannerSourceSize = (file) => {
  const isVideo = isVideoFile(file);
  const maxSize = isVideo ? MAX_SOURCE_VIDEO_SIZE : MAX_BANNER_IMAGE_SIZE;

  if (file.size > maxSize) {
    throw httpError(
      `${isVideo ? "Video" : "Image"} must be under ${maxSize / 1024 / 1024}MB`,
    );
  }
};

const uploadBannerMedia = async (files = []) => {
  const file = files.find((f) => ["media", "image"].includes(f.fieldname));
  if (!file) return null;

  assertBannerSourceSize(file);

  const url = await uploadPreparedFile("amp-store/banner", file);

  // video GIF hoye jay, tai mediaType shobshomoy "image"
  return { url, mediaType: "image" };
};

const uploadAdsMedia = async (files = []) => {
  const file = files.find((f) =>
    ["media", "video", "image"].includes(f.fieldname),
  );
  if (!file) return null;

  assertBannerSourceSize(file);

  const url = await uploadPreparedFile("amp-store/ads", file);

  return { url, mediaType: "gif" };
};

module.exports = {
  uploadSimpleImages,
  uploadVariantImages,
  uploadBannerMedia,
  uploadAdsMedia,
};