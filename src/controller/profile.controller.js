const CartModel = require("../model/cart.model.js");
const { serializeCart } = require("./cart.controller.js");
const { getOrdersGroupedByStore } = require("./order.controller.js");

// GET /profile/cart-and-orders
// user profile e: kon store theke ki ki cart e ache + kon store theke ki ki order koreche
// inactive / unverified store er cart item ar order dekhabe na
const getCartAndOrders = async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;

    const [cart, orders] = await Promise.all([
      CartModel.findOne({ userId }),
      getOrdersGroupedByStore(userId, { ordersPerStore: 5 }),
    ]);

    return res.status(200).json({
      success: true,
      cart: await serializeCart(cart, { hideUnavailableStores: true }), // stores[] -> items[]
      orders, // stores[] -> orders[]
    });
  } catch (error) {
    console.error("Get Cart And Orders Error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Internal server error" });
  }
};

module.exports = { getCartAndOrders };