const Notification = require("../models/Notification");
const { readPaging } = require("../utils/queryHelpers");

/**
 * The in-app notification bell's API.
 *
 * OWNERSHIP RULE, ENFORCED ON EVERY ROUTE: every query filters on
 * `user: req.user._id`, from the verified session, never from an id the
 * request supplies. There is no code path here that can return or modify
 * another person's notifications.
 */

/**
 * GET /api/notifications?page=&limit=
 * Newest first. Also returns the unread count, so a page load can paint
 * the bell badge without a second request.
 */
const listNotifications = async (req, res) => {
  const { page, limit, skip } = readPaging(req.query, { defaultLimit: 20, maxLimit: 50 });

  const filter = { user: req.user._id };

  const [items, total, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, isRead: false }),
  ]);

  res.status(200).json({
    notifications: items.map((n) => n.toPublicJSON()),
    page,
    limit,
    total,
    unreadCount,
  });
};

/** GET /api/notifications/unread-count -- for the bell badge, polled lightly. */
const unreadCount = async (req, res) => {
  const count = await Notification.countDocuments({ user: req.user._id, isRead: false });
  res.status(200).json({ unreadCount: count });
};

/** PATCH /api/notifications/:id/read */
const markAsRead = async (req, res) => {
  const notification = await Notification.findOne({ _id: req.params.id, user: req.user._id });
  if (!notification) {
    return res.status(404).json({ errors: [{ message: "Notification not found" }] });
  }

  if (!notification.isRead) {
    notification.isRead = true;
    notification.readAt = new Date();
    await notification.save();
  }

  res.status(200).json({ notification: notification.toPublicJSON() });
};

/** PATCH /api/notifications/read-all */
const markAllAsRead = async (req, res) => {
  const result = await Notification.updateMany(
    { user: req.user._id, isRead: false },
    { $set: { isRead: true, readAt: new Date() } }
  );

  res.status(200).json({ message: "All notifications marked as read.", updated: result.modifiedCount });
};

/** DELETE /api/notifications/:id */
const deleteNotification = async (req, res) => {
  const result = await Notification.deleteOne({ _id: req.params.id, user: req.user._id });
  if (result.deletedCount === 0) {
    return res.status(404).json({ errors: [{ message: "Notification not found" }] });
  }
  res.status(200).json({ message: "Notification deleted." });
};

module.exports = { listNotifications, unreadCount, markAsRead, markAllAsRead, deleteNotification };
