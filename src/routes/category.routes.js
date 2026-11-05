const router = require("express").Router();
const {
  createCategory,
  allCategories,
  singleCategory,
  updateCategory,
  deleteCategory,
} = require("../controller/category.controller.js");
const verifyJwt = require("../middleware/verifiyUser.js");
const { uploadMultiImages } = require("../middleware/multiMulter.js");

router.post("/", verifyJwt, uploadMultiImages, createCategory);
router.get("/", allCategories);
router.get("/product", (req, res) => {
  req.query.type = "PRODUCT";
  return allCategories(req, res);
});
router.get("/service", (req, res) => {
  req.query.type = "SERVICE";
  return allCategories(req, res);
});
router.get("/:categoryId", singleCategory);
router.put("/:categoryId", verifyJwt, uploadMultiImages, updateCategory);
router.delete("/:categoryId", verifyJwt, deleteCategory);

module.exports = router;
