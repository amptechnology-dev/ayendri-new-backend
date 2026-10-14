const UserModel = require("../model/user.model");

const authorize = (...allowedRoles) => {
    return async (req, res, next) => {
        try {
            const userId = req.user && req.user.id;
            if (!userId) {
                return res.status(401).json({ message: "Unauthorized: Please login" });
            }

            const user = await UserModel.findById(userId);
            if (!user) {
                return res.status(404).json({ message: "User not found" });
            }

            if (!allowedRoles.includes(user.role)) {
                return res.status(403).json({
                    message: "You are not eligible to access this resource",
                    yourRole: user.role,
                    requiredRoles: allowedRoles
                });
            }
            req.user = user;
            next();
        } catch (error) {
            console.error("Authorization error:", error);
            res.status(500).json({ message: "Server error" });
        }
    };
};

module.exports = authorize;