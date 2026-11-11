const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const c = require("../controller/ticket.controller.js");

// ---------- CUSTOMER (login kora user) ----------
router.get("/my", verifyJwt, c.myList);
router.get("/my/unread", verifyJwt, c.myUnread);
router.get("/my/:id", verifyJwt, c.myGet);

// ---------- STORE / SUPPORT ----------
router.get("/store", verifyJwt, authorize("STORE"), c.storeList);
router.post("/store", verifyJwt, authorize("STORE"), c.storeCreate);
router.get("/store/:id", verifyJwt, authorize("STORE"), c.storeGet);
router.patch("/store/:id", verifyJwt, authorize("STORE"), c.storeUpdate);

module.exports = router;