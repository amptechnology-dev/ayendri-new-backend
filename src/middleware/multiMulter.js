const multer = require("multer");
const path = require("path");

const storage = multer.memoryStorage();

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
];

const ALLOWED_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".avif",
  ".mp4",
  ".webm",
  ".mov",
];

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();

  if (
    !ALLOWED_MIME_TYPES.includes(file.mimetype) ||
    !ALLOWED_EXTENSIONS.includes(ext)
  ) {
    return cb(
      new Error(
        "Only image (jpg, png, webp, gif, avif) and video (mp4, webm, mov) files are allowed",
      ),
      false,
    );
  }
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 100 * 1024 * 1024, // video source 100MB (image er limit helper/frontend e check hoy)
    files: 30,
  },
});

const uploadMultiImages = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: "File too large. Maximum size is 100MB per file",
        LIMIT_FILE_COUNT: "Too many files uploaded",
      };
      return res.status(400).json({
        success: false,
        message: messages[err.code] || err.message,
      });
    }

    return res.status(400).json({ success: false, message: err.message });
  });
};

module.exports = {
  uploadMultiImages,
  ALLOWED_MIME_TYPES,
};