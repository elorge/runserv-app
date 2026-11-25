// backend/src/controllers/notification.controller.js
const prisma = require('../lib/prisma');
const { AppError } = require('../middleware/errorHandler');

exports.getNotifications = async (req, res) => {
  const { page = 1, limit = 20, unreadOnly } = req.query;
  const skip = (page - 1) * limit;

  const where = {
    userId: req.user.id,
    ...(unreadOnly === 'true' && { isRead: false })
  };

  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: parseInt(skip),
      take: parseInt(limit)
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: req.user.id, isRead: false } })
  ]);

  res.status(200).json({
    success: true,
    data: {
      notifications,
      unreadCount,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    }
  });
};

exports.markAsRead = async (req, res) => {
  const { id } = req.params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) throw new AppError('Notification not found', 404);
  if (notification.userId !== req.user.id) throw new AppError('Unauthorized', 403);

  const updated = await prisma.notification.update({
    where: { id },
    data: { isRead: true }
  });

  res.status(200).json({
    success: true,
    message: 'Notification marked as read',
    data: { notification: updated }
  });
};

exports.markAllAsRead = async (req, res) => {
  const { count } = await prisma.notification.updateMany({
    where: { userId: req.user.id, isRead: false },
    data: { isRead: true }
  });

  res.status(200).json({
    success: true,
    message: `${count} notification(s) marked as read`
  });
};

exports.deleteNotification = async (req, res) => {
  const { id } = req.params;

  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification) throw new AppError('Notification not found', 404);
  if (notification.userId !== req.user.id) throw new AppError('Unauthorized', 403);

  await prisma.notification.delete({ where: { id } });

  res.status(200).json({ success: true, message: 'Notification deleted' });
};

exports.clearAll = async (req, res) => {
  const { count } = await prisma.notification.deleteMany({
    where: { userId: req.user.id }
  });

  res.status(200).json({ success: true, message: `${count} notification(s) cleared` });
};

exports.getUnreadCount = async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.user.id, isRead: false }
    });
    res.status(200).json({ success: true, data: { count } });
  } catch (err) {
    console.error('[notifications] getUnreadCount error:', err.message, err.code);
    res.status(503).json({ success: false, message: err.message });
  }
};

// ─── WP-08: push device tokens ────────────────────────────────────────────────
const PLATFORMS = ['ios', 'android', 'web'];
const cleanStr = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** POST /notifications/devices — register or refresh. The token is unique: it is reassigned to the current user and un-revoked. */
exports.registerDevice = async (req, res) => {
  if (typeof req.body?.token !== 'string') throw new AppError('token is required', 400);
  const token = cleanStr(req.body.token, 4096);
  const platform = String(req.body?.platform || '').toLowerCase();
  if (!token) throw new AppError('token is required', 400);
  if (!PLATFORMS.includes(platform)) throw new AppError('platform must be ios, android or web', 400);
  const fields = { userId: req.user.id, platform, appVariant: cleanStr(req.body?.appVariant, 40), deviceId: cleanStr(req.body?.deviceId, 200), lastSeenAt: new Date(), revokedAt: null };
  let device;
  try {
    device = await prisma.deviceToken.upsert({ where: { token }, create: { token, ...fields }, update: fields });
  } catch (e) {
    if (e.code !== 'P2002') throw e;               // concurrent first registration of the same token: the row exists now, update it
    device = await prisma.deviceToken.update({ where: { token }, data: fields });
  }
  if (fields.deviceId) {                            // one active token per physical device and user: a rotated token replaces the old one
    await prisma.deviceToken.updateMany({ where: { userId: req.user.id, deviceId: fields.deviceId, revokedAt: null, token: { not: token } }, data: { revokedAt: new Date() } });
  }
  res.status(200).json({ success: true, data: { device: { id: device.id, platform: device.platform, appVariant: device.appVariant, lastSeenAt: device.lastSeenAt } } });
};

/** DELETE /notifications/devices — revoke on logout. Body or query: { token } or { deviceId }. Only the caller's own tokens. */
exports.unregisterDevice = async (req, res) => {
  const token = cleanStr(req.body?.token ?? req.query?.token, 4096);
  const deviceId = cleanStr(req.body?.deviceId ?? req.query?.deviceId, 200);
  if (!token && !deviceId) throw new AppError('token or deviceId is required', 400);
  const where = { userId: req.user.id, revokedAt: null, ...(token ? { token } : { deviceId }) };
  const { count } = await prisma.deviceToken.updateMany({ where, data: { revokedAt: new Date() } });
  res.status(200).json({ success: true, data: { revoked: count } });
};

module.exports = exports;