const router = require("express").Router();

const {trackStoreAction,activityReport} = require("../controller/storeAction.controller.js");
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

router.post("/", verifyJwt, trackStoreAction);
router.get("/", verifyJwt, activityReport);

module.exports = router;