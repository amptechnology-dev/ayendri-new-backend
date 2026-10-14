const router = require("express").Router();

const verifyJwt = require("../middleware/verifiyUser.js");
const authorize = require("../middleware/authorize.js");

const {
  createWorker,
  getAllWorkers,
  getSingleWorker,
  updateWorker,
  deleteWorker,
} = require("../controller/worker.controller.js");

router.post("/create-worker", verifyJwt, authorize("STORE"), createWorker);
router.get("/all-workers", verifyJwt, authorize("STORE"), getAllWorkers);
router.get("/single-worker/:id", verifyJwt, authorize("STORE"), getSingleWorker);
router.put("/update-worker/:id", verifyJwt, authorize("STORE"), updateWorker);
router.delete("/delete-worker/:id", verifyJwt, authorize("STORE"), deleteWorker);

module.exports = router;