const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");
const { getReport, downloadReport } = require("../controller/report.controller.js");

router.get("/:type/download", verifyJwt, authorize("STORE"), downloadReport);
router.get("/:type", verifyJwt, authorize("STORE"), getReport);

module.exports = router;