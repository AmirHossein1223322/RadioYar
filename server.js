
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// اطلاعات رادیوها تا زمان خاموش شدن سرور حفظ می‌شوند.
const stations = new Map();

app.get('/', (req, res) => {
  res.json({
    app: 'RadioYar',
    status: 'online',
    message: 'سرور رادیو‌یار فعال است',
    totalStations: stations.size,
    liveStations: getPublicStations().length
  });
});

app.get('/api/stations', (req, res) => {
  res.json(
    Array.from(stations.entries()).map(([id, station]) => ({
      id,
      name: station.name,
      description: station.description,
      online: station.online,
      listeners: station.members.size
    }))
  );
});

function getPublicStations() {
  return Array.from(stations.entries())
    .filter(([, station]) => station.online)
    .map(([id, station]) => ({
      id,
      name: station.name,
      listeners: Math.max(0, station.members.size - 1)
    }));
}

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

  socket.on('station:create', data => {
    const stationId = String(data?.stationId || '');
    const name = String(data?.name || '').trim();
    const description = String(data?.description || '').trim();

    if (!stationId || !name || name.length > 60) {
      socket.emit('station:error', 'اطلاعات رادیو معتبر نیست.');
      return;
    }

    const existing = stations.get(stationId);

    if (existing?.online) {
      socket.emit('station:error', 'این رادیو هم‌اکنون فعال است.');
      return;
    }

    stations.set(stationId, {
      name,
      description,
      owner: socket.id,
      online: true,
      members: new Set([socket.id])
    });

    socket.join(stationId);

    socket.emit('station:created', {
      stationId,
      message: 'رادیو آماده پخش است'
    });

    updateStations();
  });

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

  socket.on('station:leave', stationId => {
    leaveStation(socket, String(stationId || ''));
  });

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
