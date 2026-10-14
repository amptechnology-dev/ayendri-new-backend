const jwt = require("jsonwebtoken");

const buildTokenPayload = (user) => {
  const payload = {
    userId: user._id,
    role: user.role,
    email: user.email,
    phone: user.phone,
    isActive: user.isActive,
  };

  if (user.role === "USER" && user.address) {
    payload.address = {
      addressLine: user.address.addressLine,
      area: user.address.area,
      city: user.address.city,
      state: user.address.state,
      pincode: user.address.pincode,
      country: user.address.country,
    };
  }

  return payload;
};

const buildResponseUser = (user) => {
  const responseUser = {
    id: user._id,
    email: user.email,
    role: user.role,
    phone: user.phone,
    isActive: user.isActive,
  };

  if (user.role === "USER" && user.address) {
    responseUser.address = user.address;
  }

  return responseUser;
};

const generateAuthToken = (user) =>
  jwt.sign(buildTokenPayload(user), process.env.TOKEN_SECRET, {
    expiresIn: process.env.TOKEN_EXPIRATION,
  });

const setAuthCookie = (res, token) => {
  res.cookie("login-token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    sameSite: "strict",
  });
};

module.exports = { generateAuthToken, setAuthCookie, buildResponseUser };