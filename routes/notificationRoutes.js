const express = require("express");
const { requireAuth } = require("../middleware/auth");
const validateObjectId = require("../middleware/validateObjectId");
const {
  listNotifications,
  unreadCount,
  markAsRead,
  markAllAsRead,
  deleteNotification,
} = require("../controllers/notificationController");

const router = express.Router();

// Every route here needs a real session -- notifications are always
// somebody's own, never public.
router.use(requireAuth);

router.get("/", listNotifications);
router.get("/unread-count", unreadCount);
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", validateObjectId("id"), markAsRead);
router.delete("/:id", validateObjectId("id"), deleteNotification);

module.exports = router;
