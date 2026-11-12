const router = require("express").Router();
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const c = require("../controller/ticket.controller.js");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpe?g|png|webp)$/.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error("Only JPG, PNG or WEBP images are allowed")),
});

const uploadImages = (req, res, next) =>
  upload.array("images", 5)(req, res, (err) => {
    if (err) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "Each image must be under 5MB"
        : err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE" ? "You can upload up to 5 images"
        : err.message;
      return res.status(400).json({ success: false, message });
    }
    next();
  });

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many tickets raised, please try again later" },
});

// ---------- CUSTOMER (login kora user) ----------
router.post("/my", verifyJwt, createLimiter, uploadImages, c.myCreate);
router.get("/my", verifyJwt, c.myList);
router.get("/my/unread", verifyJwt, c.myUnread);
router.get("/my/orders", verifyJwt, c.myOrders);            // must be BEFORE "/my/:id"
router.get("/my/:id", verifyJwt, c.myGet);
router.patch("/my/:id/close", verifyJwt, c.myClose);

// ---------- STORE / SUPPORT ----------
router.get("/store", verifyJwt, authorize("STORE"), c.storeList);
router.post("/store", verifyJwt, authorize("STORE"), c.storeCreate);
router.get("/store/:id", verifyJwt, authorize("STORE"), c.storeGet);
router.patch("/store/:id", verifyJwt, authorize("STORE"), c.storeUpdate);

module.exports = router;