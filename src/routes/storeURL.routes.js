const router = require("express").Router();

const { getStoreByUniqueId } = require("../controller/storeURL.controller");

router.get("/:storeUniqueId", getStoreByUniqueId);

module.exports = router;