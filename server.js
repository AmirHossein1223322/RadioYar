
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const stations = new Map();
const profiles = new Map();
const listeners = new Map();

// کاربران آنلاین و اتصال‌های هر کاربر
const onlineUsers = new Map();

function getOnlineCount() {
  return onlineUsers.size;
}

function broadcastOnlineUsers() {
  io.emit('users:update', getOnlineCount());
}

function addOnlineSocket(userId, socketId) {
  if (!onlineUsers.has(userId)) {
    onlineUsers.set(userId, new Set());
  }

  onlineUsers.get(userId).add(socketId);
  broadcastOnlineUsers();
}

function removeOnlineSocket(userId, socketId) {
  if (!userId) return;

  const connections = onlineUsers.get(userId);
  if (!connections) return;

  connections.delete(socketId);

  if (connections.size === 0) {
    onlineUsers.delete(userId);
  }

  broadcastOnlineUsers();
}

function getPublicStations() {
  return [...stations.values()].map(station => ({
    id: station.id,
    name: station.name,
    description: station.description,
    category: station.category,
    ownerId: station.ownerId,
    ownerName: station.ownerName,
    listeners: listeners.get(station.id)?.size || 0
  }));
}

function broadcastStations() {
  io.emit('stations:update', getPublicStations());
}

function getProfileList() {
  return [...profiles.values()].map(profile => ({
    ...profile,
    stationCount: [...stations.values()].filter(
      station => station.ownerId === profile.id
    ).length
  }));
}

app.get('/', (req, res) => {
  res.json({
    app: 'RadioYar',
    status: 'online',
    message: 'سرور رادیو‌یار فعال است',
    version: '1.0.0',
    totalProfiles: profiles.size,
    totalStations: stations.size,
    onlineUsers: getOnlineCount()
  });
});

app.get('/api/profiles', (req, res) => {
  res.json(getProfileList());
});

app.get('/api/profiles/:id', (req, res) => {
  const profile = profiles.get(req.params.id);

  if (!profile) {
    return res.status(404).json({
      error: 'پروفایل پیدا نشد'
    });
  }

  const userStations = [...stations.values()]
    .filter(station => station.ownerId === req.params.id)
    .map(station => ({
      ...station,
      online: true
    }));

  res.json({
    ...profile,
    stationCount: userStations.length,
    stations: userStations
  });
});

io.on('connection', socket => {
  console.log('User connected:', socket.id);

  socket.data.userId = null;
  socket.data.stationId = null;
  socket.data.isOwner = false;

  socket.emit('stations:update', getPublicStations());
  socket.emit('users:update', getOnlineCount());

  // ثبت یا به‌روزرسانی پروفایل
  socket.on('profile:update', profile => {
    if (!profile || !profile.id || !profile.name) return;

    const id = String(profile.id);

    // جلوگیری از باقی ماندن اتصال در حساب قبلی
    if (socket.data.userId && socket.data.userId !== id) {
      removeOnlineSocket(socket.data.userId, socket.id);
    }

    socket.data.userId = id;
    addOnlineSocket(id, socket.id);

    const safeProfile = {
      id,
      name: String(profile.name).slice(0, 40),
      bio: String(profile.bio || '').slice(0, 160),
      photo:
        typeof profile.photo === 'string' &&
        profile.photo.startsWith('data:image/jpeg;base64,') &&
        profile.photo.length <= 450000
          ? profile.photo
          : ''
    };

    profiles.set(id, safeProfile);

    socket.emit('profile:saved');
    io.emit('profiles:update', getProfileList());
  });

  // ساخت رادیو و شروع پخش
  socket.on('station:create', data => {
    if (!data) return;

    const stationId = String(data.stationId || '');

    if (!stationId || !data.name) return;

    if (!socket.data.userId) {
      socket.emit('station:error', 'ابتدا پروفایل خود را ثبت کن.');
      return;
    }

    if (socket.data.stationId) {
      socket.emit('station:error', 'ابتدا پخش قبلی را متوقف کن.');
      return;
    }

    const station = {
      id: stationId,
      name: String(data.name).slice(0, 60),
      description: String(data.description || '').slice(0, 160),
      category: String(data.category || 'عمومی'),
      ownerId: socket.data.userId,
      ownerName:
        profiles.get(socket.data.userId)?.name || 'کاربر',
      ownerSocketId: socket.id
    };

    stations.set(stationId, station);
    listeners.set(stationId, new Set());

    socket.data.stationId = stationId;
    socket.data.isOwner = true;

    socket.join(stationId);

    socket.emit('station:created', {
      message: 'رادیو آماده پخش زنده است.'
    });

    socket.emit('station:started', {
      stationId,
      name: station.name,
      ownerId: station.ownerId,
      ownerName: station.ownerName
    });

    broadcastStations();
    io.emit('profiles:update', getProfileList());
  });

  // ورود شنونده
  socket.on('station:join', stationId => {
    const id = String(stationId || '');
    const station = stations.get(id);

    if (!station) {
      socket.emit('station:error', 'این رادیو دیگر فعال نیست.');
      return;
    }

    if (socket.data.stationId) {
      leaveStation(socket);
    }

    socket.data.stationId = id;
    socket.data.isOwner = false;

    socket.join(id);

    if (!listeners.has(id)) {
      listeners.set(id, new Set());
    }

    listeners.get(id).add(socket.id);

    const count = listeners.get(id).size;

    io.to(station.ownerSocketId).emit('listener:joined', {
      stationId: id,
      listenerId: socket.id,
      listenerName:
        profiles.get(socket.data.userId)?.name || 'شنونده جدید',
      count
    });

    io.to(id).emit('listeners:update', {
      stationId: id,
      count
    });

    broadcastStations();
  });

  // خروج از رادیو
  socket.on('station:leave', () => {
    leaveStation(socket);
  });

  // پیام چت
  socket.on('chat:send', data => {
    const stationId = socket.data.stationId;

    if (!stationId || !stations.has(stationId)) return;

    const message = String(data?.message || '').slice(0, 500);

    if (!message.trim()) return;

    const chatMessage = {
      stationId,
      senderName:
        profiles.get(socket.data.userId)?.name ||
        String(data?.senderName || 'کاربر').slice(0, 40),
      message,
      time: Date.now()
    };

    io.to(stationId).emit('chat:message', chatMessage);
  });

  // پیشنهاد WebRTC
  socket.on('webrtc:offer', data => {
    if (!data?.targetId || !data?.sdp) return;

    io.to(data.targetId).emit('webrtc:offer', {
      from: socket.id,
      stationId: data.stationId,
      sdp: data.sdp
    });
  });

  // پاسخ WebRTC
  socket.on('webrtc:answer', data => {
    if (!data?.targetId || !data?.sdp) return;

    io.to(data.targetId).emit('webrtc:answer', {
      from: socket.id,
      stationId: data.stationId,
      sdp: data.sdp
    });
  });

  // تبادل ICE
  socket.on('webrtc:ice', data => {
    if (!data?.targetId || !data?.candidate) return;

    io.to(data.targetId).emit('webrtc:ice', {
      from: socket.id,
      stationId: data.stationId,
      candidate: data.candidate
    });
  });

  // مدیریت خروج از رادیو
  function leaveStation(currentSocket) {
    const stationId = currentSocket.data.stationId;

    if (!stationId) return;

    const station = stations.get(stationId);

    if (currentSocket.data.isOwner) {
      io.to(stationId).emit('station:ended', {
        stationId
      });

      stations.delete(stationId);
      listeners.delete(stationId);

      currentSocket.leave(stationId);
    } else {
      currentSocket.leave(stationId);

      const set = listeners.get(stationId);

      if (set) {
        set.delete(currentSocket.id);

        const count = set.size;

        if (station) {
          io.to(station.ownerSocketId).emit('listener:left', {
            stationId,
            listenerId: currentSocket.id,
            count
          });
        }

        io.to(stationId).emit('listeners:update', {
          stationId,
          count
        });
      }
    }

    currentSocket.data.stationId = null;
    currentSocket.data.isOwner = false;

    broadcastStations();
    io.emit('profiles:update', getProfileList());
  }

  // قطع اتصال
  socket.on('disconnect', () => {
    leaveStation(socket);

    removeOnlineSocket(socket.data.userId, socket.id);

    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 15595;

server.listen(PORT, () => {
  console.log(`RadioYar server running on port ${PORT}`);
});
