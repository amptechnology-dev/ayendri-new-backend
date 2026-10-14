const router = require("express").Router();
const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  getStockOverview,
  updateStock,
  getStockLogs,
  getLowStockProducts,
} = require("../controller/stock.controller.js");

router.get("/overview", verifyJwt, authorize("STORE"), getStockOverview);
router.get("/low-stock", verifyJwt, authorize("STORE"), getLowStockProducts);
router.get("/logs/:productId", verifyJwt, authorize("STORE"), getStockLogs);
router.patch("/update", verifyJwt, authorize("STORE"), updateStock);

module.exports = router;