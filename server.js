
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
  },
  maxHttpBufferSize: 1e6
});

const stations = new Map();
const profiles = new Map();

const stationCategories = [
  'عمومی',
  'موسیقی',
  'اخبار',
  'ورزشی',
  'گفت‌وگو',
  'سرگرمی',
  'آموزشی'
];

function getPublicStations() {
  return Array.from(stations.entries())
    .filter(([, station]) => station.online)
    .map(([id, station]) => ({
      id,
      name: station.name,
      description: station.description,
      category: station.category,
      ownerId: station.ownerId,
      ownerName: station.ownerName,
      listeners: Math.max(0, station.members.size - 1)
    }));
}

function getPublicProfile(userId) {
  const profile = profiles.get(userId);

  if (!profile) return null;

  const userStations = Array.from(stations.entries())
    .filter(([, station]) => station.ownerId === userId)
    .map(([id, station]) => ({
      id,
      name: station.name,
      description: station.description,
      category: station.category,
      online: station.online
    }));

  return {
    id: profile.id,
    name: profile.name,
    bio: profile.bio,
    photo: profile.photo,
    stationCount: userStations.length,
    stations: userStations
  };
}

app.get('/api/profiles', (req, res) => {
  const result = Array.from(profiles.keys())
    .map(id => getPublicProfile(id))
    .filter(Boolean);

  res.json(result);
});

app.get('/api/profiles/:id', (req, res) => {
  const profile = getPublicProfile(String(req.params.id));

  if (!profile) {
    return res.status(404).json({
      error: 'پروفایل پیدا نشد.'
    });
  }

  res.json(profile);
});

app.get('/', (req, res) => {
  res.json({
    app: 'RadioYar',
    status: 'online',
    message: 'سرور رادیو‌یار فعال است',
    totalStations: stations.size,
    liveStations: getPublicStations().length,
    totalProfiles: profiles.size,
    categories: stationCategories
  });
});

app.get('/api/stations', (req, res) => {
  res.json(getPublicStations());
});

function updateStations() {
  io.emit('stations:update', getPublicStations());
}

function endStation(stationId) {
  const station = stations.get(stationId);
  if (!station) return;

  for (const memberId of station.members) {
    io.to(memberId).emit('station:ended', { stationId });
  }

  station.online = false;
  station.owner = null;
  station.members.clear();

  updateStations();
}

function leaveStation(socket, stationId) {
  const station = stations.get(stationId);
  if (!station) return;

  if (station.owner === socket.id) {
    endStation(stationId);
    return;
  }

  if (!station.members.has(socket.id)) return;

  station.members.delete(socket.id);
  socket.leave(stationId);

  if (station.owner) {
    io.to(station.owner).emit('listener:left', {
      stationId,
      listenerId: socket.id
    });
  }

  updateStations();
}

io.on('connection', socket => {
  console.log('کاربر متصل شد:', socket.id);

  socket.emit('stations:update', getPublicStations());

  // ثبت یا به‌روزرسانی پروفایل عمومی
  socket.on('profile:update', data => {
    const id = String(data?.id || '').trim();
    const name = String(data?.name || '').trim();
    const bio = String(data?.bio || '').trim();
    const photo = String(data?.photo || '');

    if (!id || id.length > 80) return;

    if (!name || name.length > 40 || bio.length > 160) {
      socket.emit('profile:error', 'اطلاعات پروفایل معتبر نیست.');
      return;
    }

    if (
      photo &&
      (
        !photo.startsWith('data:image/jpeg;base64,') ||
        photo.length > 450000
      )
    ) {
      socket.emit('profile:error', 'عکس پروفایل معتبر نیست یا حجم آن زیاد است.');
      return;
    }

    const profile = {
      id,
      name,
      bio,
      photo
    };

    profiles.set(id, profile);
    socket.data.userId = id;

    socket.emit('profile:saved', {
      success: true,
      id
    });

    io.emit('profiles:update', {
      id,
      name
    });

    updateStations();
  });

  // ساخت رادیو و اعلام شروع پخش زنده
  socket.on('station:create', data => {
    const stationId = String(data?.stationId || '').trim();
    const name = String(data?.name || '').trim();
    const description = String(data?.description || '').trim();

    const requestedCategory = String(data?.category || 'عمومی').trim();

    const category = stationCategories.includes(requestedCategory)
      ? requestedCategory
      : 'عمومی';

    if (!stationId || !name || name.length > 60) {
      socket.emit('station:error', 'اطلاعات رادیو معتبر نیست.');
      return;
    }

    if (description.length > 160) {
      socket.emit('station:error', 'توضیحات رادیو بیش از حد طولانی است.');
      return;
    }

    const existing = stations.get(stationId);

    if (existing?.online) {
      socket.emit('station:error', 'این رادیو هم‌اکنون فعال است.');
      return;
    }

    const ownerId = socket.data.userId || '';
    const ownerProfile = profiles.get(ownerId);
    const ownerName = ownerProfile?.name || 'کاربر';

    stations.set(stationId, {
      name,
      description,
      category,
      ownerId,
      ownerName,
      owner: socket.id,
      online: true,
      members: new Set([socket.id])
    });

    socket.join(stationId);

    socket.emit('station:created', {
      stationId,
      message: 'رادیو آماده پخش است'
    });

    // ارسال اعلان شروع پخش زنده به کاربران متصل
    io.emit('station:started', {
      stationId,
      name,
      description,
      category,
      ownerId,
      ownerName,
      time: new Date().toISOString()
    });

    updateStations();
  });

  // ورود شنونده
  socket.on('station:join', stationId => {
    stationId = String(stationId || '');

    const station = stations.get(stationId);

    if (!station || !station.online || !station.owner) {
      socket.emit('station:error', 'این رادیو در حال حاضر فعال نیست.');
      return;
    }

    if (station.owner === socket.id) return;

    if (!station.members.has(socket.id)) {
      station.members.add(socket.id);
      socket.join(stationId);

      io.to(station.owner).emit('listener:joined', {
        stationId,
        listenerId: socket.id
      });

      updateStations();
    }
  });

  // چت زنده
  socket.on('chat:send', data => {
    const stationId = String(data?.stationId || '');
    const message = String(data?.message || '').trim();

    const station = stations.get(stationId);

    if (!station || !station.online) return;
    if (!station.members.has(socket.id)) return;
    if (!message || message.length > 500) return;

    const senderProfile = profiles.get(socket.data.userId);

    const chatMessage = {
      stationId,
      senderId: socket.id,
      senderName: senderProfile?.name || 'کاربر',
      message,
      time: new Date().toISOString()
    };

    io.to(stationId).emit('chat:message', chatMessage);
  });

  // WebRTC Offer
  socket.on('webrtc:offer', data => {
    const station = stations.get(data?.stationId);

    if (!station || station.owner !== socket.id) return;
    if (!station.members.has(data.targetId)) return;
    if (!data.sdp) return;

    io.to(data.targetId).emit('webrtc:offer', {
      stationId: data.stationId,
      from: socket.id,
      sdp: data.sdp
    });
  });

  // WebRTC Answer
  socket.on('webrtc:answer', data => {
    const station = stations.get(data?.stationId);

    if (!station || station.owner !== data.targetId) return;
    if (!station.members.has(socket.id)) return;
    if (!data.sdp) return;

    io.to(data.targetId).emit('webrtc:answer', {
      stationId: data.stationId,
      from: socket.id,
      sdp: data.sdp
    });
  });

  // ICE Candidate
  socket.on('webrtc:ice', data => {
    const station = stations.get(data?.stationId);

    if (!station) return;
    if (!station.members.has(socket.id)) return;
    if (!station.members.has(data.targetId)) return;
    if (!data.candidate) return;

    io.to(data.targetId).emit('webrtc:ice', {
      stationId: data.stationId,
      from: socket.id,
      candidate: data.candidate
    });
  });

  // خروج از رادیو
  socket.on('station:leave', stationId => {
    leaveStation(socket, String(stationId || ''));
  });

  // قطع اتصال
  socket.on('disconnect', () => {
    for (const [stationId, station] of stations) {
      if (station.owner === socket.id) {
        endStation(stationId);
      } else {
        leaveStation(socket, stationId);
      }
    }

    console.log('کاربر قطع شد:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`RadioYar server running on port ${PORT}`);
});
