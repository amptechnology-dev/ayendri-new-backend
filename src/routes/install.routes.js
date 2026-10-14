const router = require("express").Router();

const { claimInstall } = require("../controller/install.controller");

router.post("/claim", claimInstall);

module.exports = router;