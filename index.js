const express = require("express");
const dotenv = require("dotenv");
const path = require("path");
const cors = require("cors");
const Conect = require("./src/db/Connent.js");
const cookieParser = require("cookie-parser");
const { expireUnpaidOrders } = require("./src/controller/payment.controller.js");

dotenv.config();

const app = express();
Conect();

app.use(
  cors({
    origin: [process.env.FRONTEND_URL, process.env.FRONTEND_URL_2],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  }),
);
app.use(cookieParser());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/.well-known/assetlinks.json", (req, res) => {
  const fingerprints = (process.env.APP_SHA256_FINGERPRINTS || "")
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  res.set("Content-Type", "application/json");
  res.json([
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: process.env.ANDROID_PACKAGE_NAME, 
        sha256_cert_fingerprints: fingerprints,
      },
    },
  ]);
});

app.use(express.static(path.join(__dirname, "public")));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "src", "views"));

const registerRoutes = require("./src/routes/register.routes.js");
const loginRoutes = require("./src/routes/login.routes.js");
const productRoutes = require("./src/routes/product.routes.js");
const dashboardRoutes = require("./src/routes/dashboard.routes.js");
const reviewRoutes = require("./src/routes/review.routes.js");
const categoryRoutes = require("./src/routes/category.routes.js");
const adsRoutes = require("./src/routes/ads.route.js");
const storeActionRoutes = require("./src/routes/storeAction.routes.js");
const cartRoutes = require("./src/routes/cart.routes.js");
const orderRoutes = require("./src/routes/order.routes.js");
const profileRoutes = require("./src/routes/profile.routes.js");
const storeurlroutes = require("./src/routes/storeURL.routes.js");
const bannerRoutes = require("./src/routes/banner.route.js");
const wishlistRoutes = require("./src/routes/wishlist.route.js");
const productreviewRoutes = require("./src/routes/productReview.route.js");
const notificationRoutes = require("./src/routes/notification.route.js");
const storeSettingRoutes = require("./src/routes/storeSetting.routes.js");
const workerRoutes = require("./src/routes/worker.routes.js");
const stockRoutes = require("./src/routes/stock.routes.js");
const companyRoutes = require("./src/routes/company.routes.js");
const storeVisitRoutes = require("./src/routes/storeVisit.route.js")
const appReleaseRoutes = require("./src/routes/appRelease.route.js");
const installRoutes = require("./src/routes/install.routes.js");
const paymentRoutes = require("./src/routes/payment.routes.js");
const deliveryRoutes = require("./src/routes/delivery.routes.js");

app.use("/api/register", registerRoutes);
app.use("/api/login", loginRoutes);
app.use("/api/product", productRoutes);
app.use("/api/review", reviewRoutes);
app.use("/api/ads", adsRoutes);
app.use("/api/category", categoryRoutes);
app.use("/api/store-action", storeActionRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/profile", profileRoutes);
app.use("/store", storeurlroutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/banner", bannerRoutes);
app.use("/api/wishlist", wishlistRoutes);
app.use("/api/product", productreviewRoutes);
app.use("/api/notifications",notificationRoutes);
app.use("/api/store-settings", storeSettingRoutes);
app.use("/api/worker", workerRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/company", companyRoutes);
app.use("/api/store-visit",storeVisitRoutes)
app.use("/api/app-release", appReleaseRoutes);
app.use("/api/install", installRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/delivery", deliveryRoutes);

setInterval(() => {
  expireUnpaidOrders().catch((e) => console.error("Expire orders error:", e));
}, 5 * 60 * 1000);

const port = process.env.PORT || 8090;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server is running on port ${port}`);
});
