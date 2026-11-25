// backend/src/services/socket.service.js
const jwt    = require('jsonwebtoken');
const prisma = require('../lib/prisma');
const { logger } = require('../utils/logger');
const tracking = require('./tracking.service');
const fleetService = require('./fleet.service');

// Store active socket connections: userId -> socketId
const activeSockets = new Map();

// ─────────────────────────────────────────────
// AUTHENTICATION MIDDLEWARE
// ─────────────────────────────────────────────

const verifySocketAuth = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error: no token'));

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const user = await prisma.user.findUnique({
      where:  { id: decoded.userId },
      select: { id: true, role: true, firstName: true, lastName: true, isActive: true, isSuspended: true, passwordChangedAt: true, sessionsRevokedAt: true },
    });

    if (!user)          return next(new Error('User not found'));
    if (!user.isActive) return next(new Error('Account is deactivated'));
    // Same rules as the HTTP middleware: a suspended user, or a token issued before a password change, gets no live channel.
    if (user.isSuspended) return next(new Error('Account is suspended'));
    if (user.passwordChangedAt && decoded.iat < Math.floor(user.passwordChangedAt.getTime() / 1000)) return next(new Error('Password was changed'));

    if (require('./tokenRevocation.service').issuedBeforeRevocation(decoded, user.sessionsRevokedAt)) return next(new Error('Session ended'));
    if (await require('./tokenRevocation.service').isRevoked(token, decoded)) return next(new Error('Session ended'));
    socket.userId   = user.id;
    socket.userRole = user.role;
    socket.userName = `${user.firstName} ${user.lastName}`;

    next();
  } catch (error) {
    logger.error('Socket auth error:', error.message);
    next(new Error('Authentication error'));
  }
};

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

// ── Safety helpers ───────────────────────────────────────────────────────────
const isStaffRole = (r) => ['ADMIN', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT'].includes(r);
const num = (v, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const cleanCoords = (d) => { const lat = num(d?.lat, -90, 90); const lng = num(d?.lng, -180, 180); return lat === null || lng === null ? null : { lat, lng }; };
const ID = /^[0-9a-zA-Z-]{8,64}$/;

/** The trip a room/channel name points at, with its two people. Only live trips count. */
const tripParties = async (kind, id) => {
  if (!ID.test(String(id || ''))) return null;
  if (kind === 'ride') {
    const r = await prisma.ride.findUnique({ where: { id }, select: { customerId: true, driverId: true, status: true } });
    return r && ['REQUESTED', 'ACCEPTED', 'ARRIVED', 'IN_PROGRESS'].includes(r.status) ? [r.customerId, r.driverId].filter(Boolean) : null;
  }
  if (kind === 'delivery') {
    const d = await prisma.delivery.findUnique({ where: { id }, select: { customerId: true, partnerId: true, status: true } });
    return d && ['PENDING', 'ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'].includes(d.status) ? [d.customerId, d.partnerId].filter(Boolean) : null;
  }
  return null;
};

/** For a call channel "ride_<id>" / "delivery_<id>": the OTHER person, if `userId` is a party to it. */
const counterpart = async (userId, channelName) => {
  const [kind, ...rest] = String(channelName || '').split('_');
  const parties = await tripParties(kind, rest.join('_'));
  if (!parties || !parties.includes(userId)) return null;
  return parties.find((p) => p !== userId) || null;
};

/** What differs between the two live-location roles; everything else is shared. */
const LIVE_ROLES = {
  DRIVER: {
    model: 'driverProfile', room: 'drivers:online', updateEvent: 'driver:location:update', tripKey: 'rideId',
    activeTrip: (userId) => prisma.ride.findFirst({ where: { driverId: userId, status: { in: ['ACCEPTED', 'ARRIVED', 'IN_PROGRESS'] } }, select: { id: true, customerId: true } }),
  },
  DELIVERY_PARTNER: {
    model: 'deliveryPartnerProfile', room: 'partners:online', updateEvent: 'partner:location:update', tripKey: 'deliveryId',
    activeTrip: (userId) => prisma.delivery.findFirst({ where: { partnerId: userId, status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } }, select: { id: true, customerId: true } }),
  },
};

const initializeSocketHandlers = (io) => {
  // Inject io into notification service so controllers can emit
  const notificationService = require('./notification.service');
  notificationService.setIO(io);

  io.use(verifySocketAuth);

  io.on('connection', (socket) => {
    logger.info(`[Socket] Connected: ${socket.userName} (${socket.userId}) role=${socket.userRole}`);

    // Flood guard: at most 30 events in any 5 seconds per connection (location pings are ~1 per second).
    let windowStart = Date.now(); let seen = 0;
    socket.use((_packet, next) => {
      const now = Date.now();
      if (now - windowStart > 5000) { windowStart = now; seen = 0; }
      if (++seen > 30) return next(new Error('Too many events'));
      return next();
    });

// Disconnect any existing ghost socket for this user
const existingSocketId = activeSockets.get(socket.userId);
if (existingSocketId && existingSocketId !== socket.id) {
  const existingSocket = io.sockets.sockets.get(existingSocketId);
  if (existingSocket) {
    logger.info(`[Socket] Kicking ghost socket ${existingSocketId} for user ${socket.userId}`);
    existingSocket.disconnect(true);
  }
}

activeSockets.set(socket.userId, socket.id);
socket.join(`user:${socket.userId}`);
logger.info(`[Socket] ${socket.userName} (${socket.userId}) joined room user:${socket.userId}`);
    // ── LIVE LOCATION: drivers and couriers (one handler for both roles) ─────────────────────────────────────────────
    // Both roles share the rules in tracking.service: consent on the current wording is checked on EVERY ping, pings are
    // validated (range, accuracy, age, impossible jumps), and exact position goes ONLY to the customer on the assigned trip.
    // Either event prefix is accepted from either role ("driver:*" and "partner:*"), so older courier builds that send
    // "driver:location" keep working.
    const live = LIVE_ROLES[socket.userRole] || null;
    const reject = (reason, extra = {}) => socket.emit('location:rejected', { reason, ...extra });
    const livePick = {
      isApproved: true, isOnline: true, currentLat: true, currentLng: true, lastLocationAt: true,
      locationConsentAt: true, locationConsentVersion: true, locationConsentRevokedAt: true,
    };
    const loadLive = () => prisma[live.model].findUnique({ where: { userId: socket.userId }, select: livePick });

    // Join the dispatch pool, then VERIFY. Joining and consent withdrawal can interleave (withdrawal removes the socket from
    // the room before our join lands), so after joining we re-read the profile and leave again if it no longer qualifies.
    const joinPoolVerified = async () => {
      socket.join(live.room);
      const again = await loadLive();
      if (!tracking.canJoinDispatchPool(again)) { socket.leave(live.room); return false; }
      return true;
    };

    // Reconnect: rejoin the dispatch pool only when APPROVED, online, consent valid on the current wording AND a fresh GPS fix
    // is on file. A driver who is online without a usable fix waits (WAITING_FOR_LOCATION) and joins on the first valid ping.
    if (live) {
      loadLive().then(async (profile) => {
        if (tracking.canJoinDispatchPool(profile)) {
          if (await joinPoolVerified()) logger.info(`[Socket] ${socket.userRole} auto-rejoined ${live.room} on reconnect: ${socket.userId}`);
        }
      }).catch((err) => logger.error('[Socket] auto-rejoin error:', err.message));
    }

    const onOnline = async (data) => {
      if (!live) return;
      try {
        const profile = await loadLive();
        // Only an APPROVED person may receive requests.
        if (!profile?.isApproved) { socket.leave(live.room); return reject('NOT_APPROVED', { message: 'Your profile is not approved yet.' }); }
        if (!tracking.hasValidConsent(profile)) {
          socket.leave(live.room);
          return reject('LOCATION_CONSENT_REQUIRED', { message: 'Allow Runserv to share your live location before going online.' });
        }
        // Fleet drivers: the vehicle, its approved documents and the driver/vehicle match are re-checked at every go-online.
        try { await fleetService.assertDriverDispatchable(socket.userId); }
        catch (e) {
          socket.leave(live.room);
          return reject(e.code || 'DISPATCH_NOT_ALLOWED', { message: e.statusCode === 403 ? e.message : 'Could not confirm you can take jobs right now. Try again.' });
        }
        // A valid, fresh first fix is REQUIRED. Without one the driver stays out of the dispatch pool (guide §5.4 step 2).
        const ping = tracking.validatePing(data, null, Date.now(), { requireAccuracy: true });
        if (!ping.ok) { socket.leave(live.room); return reject('LOCATION_FIX_REQUIRED', { detail: ping.reason, message: 'Waiting for a good GPS fix before you can go online.' }); }
        try {
          // Atomic: the write only lands if approval + consent are STILL valid in the same statement.
          await prisma[live.model].update({
            where: { userId: socket.userId, ...tracking.consentedWhere() },
            data: {
              isOnline: true,
              currentLat:     ping.fix.lat,
              currentLng:     ping.fix.lng,
              lastLocationAt: new Date(ping.fix.at),
              locationAccuracy: ping.fix.accuracy,
              locationHeading:  ping.fix.heading,
            },
          });
        } catch (e) {
          if (e?.code === 'P2025') { socket.leave(live.room); return reject('LOCATION_CONSENT_REQUIRED', { message: 'Allow Runserv to share your live location before going online.' }); }
          throw e;
        }
        if (await joinPoolVerified()) logger.info(`[Socket] ${socket.userRole} online: ${socket.userId}`);
      } catch (err) { logger.error('[Socket] online error:', err.message); }
    };

    const onOffline = async () => {
      if (!live) return;
      try {
        // ATOMIC: the "no trip in progress" condition is part of the same UPDATE, so a trip accepted a moment ago cannot be
        // overwritten by a stale check. No match = either a trip is active or there is no profile.
        await prisma[live.model].update({
          where: { userId: socket.userId, ...tracking.notOnTripWhere(socket.userRole) },
          data: { isOnline: false, currentLat: null, currentLng: null, lastLocationAt: null, locationAccuracy: null, locationHeading: null },
        });
        socket.leave(live.room);
        logger.info(`[Socket] ${socket.userRole} offline: ${socket.userId}`);
      } catch (err) {
        if (err?.code === 'P2025') return reject('ACTIVE_TRIP');
        logger.error('[Socket] offline error:', err.message);
      }
    };

    const onLocation = async (data) => {
      if (!live) return;
      try {
        const profile = await loadLive();
        if (!profile || !tracking.hasValidConsent(profile)) {
          socket.leave(live.room);
          return reject('LOCATION_CONSENT_REQUIRED', { message: 'Allow Runserv to share your live location.' });
        }
        if (!profile.isOnline) return reject('NOT_ONLINE');

        const prev = Number.isFinite(profile.currentLat) && Number.isFinite(profile.currentLng) && profile.lastLocationAt
          ? { lat: profile.currentLat, lng: profile.currentLng, at: profile.lastLocationAt } : null;
        const ping = tracking.validatePing(data, prev);
        if (!ping.ok) { if (ping.reason !== 'TOO_SOON') reject(ping.reason); return; }   // too-soon pings are simply dropped
        const { fix } = ping;

        try {
          // Consent is part of the write itself: a ping that lands just after withdrawal is stored nowhere.
          await prisma[live.model].update({
            where: { userId: socket.userId, isOnline: true, ...tracking.consentedWhere() },
            data: { currentLat: fix.lat, currentLng: fix.lng, lastLocationAt: new Date(fix.at), locationAccuracy: fix.accuracy, locationHeading: fix.heading },
          });
        } catch (e) {
          if (e?.code === 'P2025') { socket.leave(live.room); return reject('LOCATION_CONSENT_REQUIRED', { message: 'Allow Runserv to share your live location.' }); }
          throw e;
        }
        // First valid fix after reconnecting / WAITING_FOR_LOCATION: now the driver may join the dispatch pool.
        if (!socket.rooms || !socket.rooms.has(live.room)) await joinPoolVerified();

        const trip = await live.activeTrip(socket.userId);
        if (trip) {
          io.to(`user:${trip.customerId}`).emit(live.updateEvent, {
            [live.tripKey]: trip.id,
            lat: fix.lat, lng: fix.lng, heading: fix.heading, speed: fix.speed, accuracy: fix.accuracy,
            timestamp: new Date(fix.at), stale: false,
          });
        }
      } catch (err) { logger.error('[Socket] location error:', err.message); }
    };

    for (const prefix of ['driver', 'partner']) {
      socket.on(`${prefix}:online`, onOnline);
      socket.on(`${prefix}:offline`, onOffline);
      socket.on(`${prefix}:location`, onLocation);
    }

    // ── RIDE ROOM ──────────────────────────────────

    // Joining a room is allowed only for the two people on that trip (staff may watch any). Before, any signed-in user
    // who knew or guessed a trip id could listen in on another person's live trip.
    const joinTrip = async (kind, id) => {
      try {
        if (isStaffRole(socket.userRole)) { if (ID.test(String(id || ''))) socket.join(`${kind}:${id}`); return; }
        const parties = await tripParties(kind, id);
        if (parties && parties.includes(socket.userId)) socket.join(`${kind}:${id}`);
      } catch (err) { logger.error(`[Socket] ${kind}:join error:`, err.message); }
    };
    socket.on('ride:join',  (rideId)  => joinTrip('ride', rideId));
    socket.on('ride:leave', (rideId)  => socket.leave(`ride:${String(rideId)}`));

    // ── DELIVERY ROOM ──────────────────────────────

    socket.on('delivery:join',  (deliveryId) => joinTrip('delivery', deliveryId));
    socket.on('delivery:leave', (deliveryId) => socket.leave(`delivery:${deliveryId}`));

    // ── CALL SIGNALING ─────────────────────────────

    // A call can only be placed between the two people on the same live trip (the channel name says which trip), so a user
    // cannot ring strangers, spoof who is calling, or push call events at someone else's session.
    socket.on('call:initiate', async (data) => {
      try {
        const other = await counterpart(socket.userId, data?.channelName);
        if (!other || other !== data?.targetUserId) return;
        const caller = await prisma.user.findUnique({
          where:  { id: socket.userId },
          select: { id: true, firstName: true, lastName: true, profileImage: true, role: true },
        });
        io.to(`user:${other}`).emit('call:incoming', {
          callerId:    socket.userId,
          callerName:  `${caller.firstName} ${caller.lastName}`,
          callerImage: caller.profileImage,          // from the account, not from the request
          channelName: data.channelName,
          callType:    data.callType === 'video' ? 'video' : 'voice',
        });
        logger.info(`[Socket] call:initiate ${socket.userId} → ${other} (${data.callType})`);
      } catch (err) {
        logger.error('[Socket] call:initiate error:', err.message);
      }
    });

    const relay = (event, build) => async (data) => {
      try {
        const other = await counterpart(socket.userId, data?.channelName);
        if (!other) return;
        io.to(`user:${other}`).emit(event, build(data));
      } catch (err) { logger.error(`[Socket] ${event} error:`, err.message); }
    };
    socket.on('call:accept', relay('call:accepted', (d) => ({ acceptedBy: socket.userId, channelName: d.channelName })));
    socket.on('call:reject', relay('call:rejected', (d) => ({ rejectedBy: socket.userId, channelName: d.channelName, reason: String(d.reason ?? 'declined').slice(0, 40) })));
    socket.on('call:end', relay('call:ended', (d) => ({ endedBy: socket.userId, channelName: d.channelName })));
    socket.on('call:toggle_video', relay('call:video_toggled', (d) => ({ byUserId: socket.userId, videoEnabled: !!d.videoEnabled })));

    // ── SOS / EMERGENCY ────────────────────────────

    let lastSos = 0;
    socket.on('emergency:trigger', async (data) => {
      try {
        if (Date.now() - lastSos < 10000) return;       // one alert per 10 seconds per person: no flooding the control room
        lastSos = Date.now();
        const location = cleanCoords(data) || null;       // only numbers are forwarded and logged, never free text
        logger.warn(`[EMERGENCY] User ${socket.userId} triggered SOS. Location: ${JSON.stringify(location)}`);
        // Keep a durable record: the live alert below is lost if no staff member is connected at that moment.
        require('../utils/auditLog').logActivity({ userId: socket.userId, action: 'emergency_triggered', entityType: 'User', entityId: socket.userId, details: { location, role: socket.userRole } });

        io.to('admins:online').emit('emergency:alert', {
          userId:    socket.userId,
          userName:  socket.userName,
          userRole:  socket.userRole,
          location,
          timestamp: new Date(),
        });

        socket.emit('emergency:acknowledged', { message: 'Help is on the way. Stay safe.' });
      } catch (err) {
        logger.error('[Socket] emergency:trigger error:', err.message);
      }
    });

    // ── ADMIN ROOM ─────────────────────────────────

    if (['ADMIN', 'SUPER_ADMIN', 'MODERATOR', 'SUPPORT'].includes(socket.userRole)) {
      socket.join('admins:online');
    }

// ── DISCONNECT ─────────────────────────────────

    // Mark offline (as before) and, unless a trip is in progress, ALSO erase the stored coordinates so a disconnected driver's
    // last position does not sit in the database indefinitely (guide §6). During a trip the last fix is kept so the customer
    // still sees a "last seen" position; it is cleared when the driver next goes offline normally.
    const markOfflineAndForget = async () => {
      const role = LIVE_ROLES[socket.userRole];
      if (!role) return;
      await prisma[role.model].updateMany({ where: { userId: socket.userId }, data: { isOnline: false } });
      await prisma[role.model].updateMany({
        where: { userId: socket.userId, ...tracking.notOnTripWhere(socket.userRole) },
        data: { currentLat: null, currentLng: null, lastLocationAt: null, locationAccuracy: null, locationHeading: null },
      });
    };

    socket.on('disconnect', async (reason) => {
      logger.info(`[Socket] Disconnected: ${socket.userName} (${socket.userId}) reason=${reason}`);

      if (reason === 'transport close' || reason === 'ping timeout') {
        setTimeout(async () => {
          const current = activeSockets.get(socket.userId);
          if (current && current !== socket.id) return;
          activeSockets.delete(socket.userId);
          try { await markOfflineAndForget(); }
          catch (err) { logger.error('[Socket] delayed disconnect cleanup error:', err.message); }
        }, 15000);
        return;
      }

      activeSockets.delete(socket.userId);
      try { await markOfflineAndForget(); }
      catch (err) { logger.error('[Socket] disconnect cleanup error:', err.message); }
    });

  }); 
};    

// ─────────────────────────────────────────────
// UTILITY EXPORTS
// ─────────────────────────────────────────────

const emitToUser          = (io, userId, event, data) => io?.to(`user:${userId}`).emit(event, data);
const broadcastToDrivers  = (io, event, data)          => io?.to('drivers:online').emit(event, data);
const broadcastToPartners = (io, event, data)          => io?.to('partners:online').emit(event, data);
const emitToPartner       = (io, partnerId, event, data) => io?.to(`user:${partnerId}`).emit(event, data);
/** Trip-specific location sharing stops: tell both people and the trip room that no more positions will arrive. */
const emitTrackingEnded = (io, kind, tripId, userIds = [], reason = 'ENDED') => {
  if (!io) return;
  const payload = { [kind === 'ride' ? 'rideId' : 'deliveryId']: tripId, reason, at: new Date() };
  for (const u of userIds.filter(Boolean)) io.to(`user:${u}`).emit(`${kind}:tracking:ended`, payload);
  io.to(`${kind}:${tripId}`).emit(`${kind}:tracking:ended`, payload);
};
const getSocketId         = (userId) => activeSockets.get(userId) || null;

module.exports = {
  _test: { cleanCoords, counterpart, tripParties },
  initializeSocketHandlers,
  emitToUser,
  broadcastToDrivers,
  broadcastToPartners,
  emitToPartner,
  getSocketId,
  emitTrackingEnded,
};