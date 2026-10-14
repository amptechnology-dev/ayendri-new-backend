const multer = require("multer");
const path = require("path");

const MAX_APK_SIZE = 200 * 1024 * 1024; // 200MB

// browser/OS bhede APK er mimetype alada alada ashe
const ALLOWED_MIME_TYPES = [
  "application/vnd.android.package-archive",
  "application/octet-stream",
  "application/zip",
  "application/x-zip-compressed",
];

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== ".apk" || !ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      return cb(new Error("Only .apk file is allowed"), false);
    }
    cb(null, true);
  },
  limits: { fileSize: MAX_APK_SIZE, files: 1 },
});

// field name: "apk". JSON body (file chhara) dile multer skip kore next() kore
const uploadApk = (req, res, next) => {
  upload.single("apk")(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: "APK too large. Maximum size is 200MB",
        LIMIT_FILE_COUNT: "Only one APK allowed",
        LIMIT_UNEXPECTED_FILE: "APK field name must be 'apk'",
      };
      return res.status(400).json({
        success: false,
        message: messages[err.code] || err.message,
      });
    }
    return res.status(400).json({ success: false, message: err.message });
  });
};

module.exports = { uploadApk };