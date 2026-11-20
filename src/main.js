
import './style.css';
import { io } from 'socket.io-client';

const SERVER_URL = 'https://radio-yar.freesrv.com';

const socket = io(SERVER_URL, {
  autoConnect: true,
  reconnection: true
});

const app = document.querySelector('#app');

let currentUser = JSON.parse(localStorage.getItem('radioyar-user') || 'null');
let stations = JSON.parse(localStorage.getItem('radioyar-stations') || '[]');

let activeStation = null;
let localStream = null;
let listenerConnection = null;
let ownerConnections = new Map();
let pendingCandidates = new Map();
let isMuted = false;
let currentVolume = 1;

window.onlineStations = [];

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const samples = [
  { id: 'sample-1', name: 'رادیو موسیقی', description: 'موسیقی برای لحظه‌های خوب' },
  { id: 'sample-2', name: 'رادیو آرامش', description: 'آرامش در تمام لحظه‌ها' },
  { id: 'sample-3', name: 'رادیو شب', description: 'همراه شب‌های شما' }
];

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function saveData() {
  localStorage.setItem('radioyar-user', JSON.stringify(currentUser));
  localStorage.setItem('radioyar-stations', JSON.stringify(stations));
}

function showMessage(message) {
  const old = document.querySelector('.toast');
  if (old) old.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

function createPlayer() {
  let player = document.querySelector('#livePlayer');

  if (!player) {
    player = document.createElement('section');
    player.id = 'livePlayer';

    player.style.cssText = `
      position:fixed;
      bottom:16px;
      left:16px;
      right:16px;
      z-index:1000;
      display:none;
      background:#201f32;
      border:1px solid #44415e;
      border-radius:18px;
      padding:16px;
      color:white;
      box-shadow:0 10px 35px #0008;
      max-width:600px;
      margin:auto;
    `;

    player.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap">
        <div>
          <strong id="playerTitle">رادیو زنده</strong>
          <div id="playerStatus" style="font-size:12px;color:#aaa;margin-top:5px">
            در حال اتصال
          </div>
        </div>
        <button id="stopLive" type="button">توقف پخش</button>
      </div>

      <div id="ownerControls" style="display:none;margin-top:15px">
        <button id="muteMic" type="button">قطع میکروفون</button>
      </div>

      <div id="listenerControls" style="display:none;margin-top:15px">
        <label for="volumeControl">بلندی صدا</label>
        <input id="volumeControl" type="range" min="0" max="100" value="100" style="width:100%">
      </div>

      <audio id="liveAudio" autoplay playsinline></audio>
    `;

    document.body.appendChild(player);

    player.querySelector('#stopLive').addEventListener('click', stopLive);
    player.querySelector('#muteMic').addEventListener('click', toggleMicrophone);

    player.querySelector('#volumeControl').addEventListener('input', event => {
      currentVolume = Number(event.target.value) / 100;
      player.querySelector('#liveAudio').volume = currentVolume;
    });
  }

  return player;
}

function showPlayer(title, owner = false) {
  const player = createPlayer();

  player.style.display = 'block';
  player.querySelector('#playerTitle').textContent = title;
  player.querySelector('#playerStatus').textContent =
    owner ? 'رادیوی شما در حال پخش است' : 'در حال گوش دادن';

  player.querySelector('#ownerControls').style.display =
    owner ? 'block' : 'none';

  player.querySelector('#listenerControls').style.display =
    owner ? 'none' : 'block';
}

function cleanupConnections() {
  if (listenerConnection) {
    listenerConnection.close();
    listenerConnection = null;
  }

  for (const connection of ownerConnections.values()) {
    connection.close();
  }

  ownerConnections.clear();
  pendingCandidates.clear();

  const audio = document.querySelector('#liveAudio');

  if (audio) {
    audio.pause();
    audio.srcObject = null;
  }
}

function cleanupLive() {
  cleanupConnections();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  activeStation = null;
  isMuted = false;

  const player = document.querySelector('#livePlayer');

  if (player) {
    player.style.display = 'none';
    const muteButton = player.querySelector('#muteMic');

    if (muteButton) {
      muteButton.textContent = 'قطع میکروفون';
    }
  }
}

function stopLive() {
  if (!activeStation) return;

  socket.emit('station:leave', activeStation.id);

  cleanupLive();
  showMessage('پخش زنده متوقف شد.');
  render();
}

function toggleMicrophone() {
  if (!localStream) return;

  isMuted = !isMuted;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  const button = document.querySelector('#muteMic');

  if (button) {
    button.textContent = isMuted
      ? 'روشن کردن میکروفون'
      : 'قطع میکروفون';
  }

  showMessage(isMuted ? 'میکروفون قطع شد.' : 'میکروفون روشن شد.');
}

async function startStation(station) {
  if (!socket.connected) {
    showMessage('اتصال به سرور برقرار نیست.');
    return;
  }

  if (activeStation) {
    showMessage('ابتدا پخش فعلی را متوقف کن.');
    return;
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });

    activeStation = {
      ...station,
      owner: true
    };

    socket.emit('station:create', {
      stationId: station.id,
      name: station.name,
      description: station.description || ''
    });

    showPlayer(station.name, true);
    showMessage('درخواست پخش زنده ارسال شد.');
  } catch (error) {
    cleanupLive();
    showMessage('دسترسی به میکروفون ممکن نشد.');
    console.error(error);
  }
}

function joinStation(station) {
  if (!socket.connected) {
    showMessage('اتصال به سرور برقرار نیست.');
    return;
  }

  if (activeStation) {
    showMessage('ابتدا پخش فعلی را متوقف کن.');
    return;
  }

  activeStation = {
    ...station,
    owner: false
  };

  socket.emit('station:join', station.id);
  showPlayer(station.name, false);
  showMessage('در حال اتصال به رادیو...');
}

async function createOwnerConnection(listenerId) {
  if (!activeStation || !activeStation.owner || !localStream) return;
  if (ownerConnections.has(listenerId)) return;

  const pc = new RTCPeerConnection(iceServers);

  ownerConnections.set(listenerId, pc);

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.onicecandidate = event => {
    if (event.candidate && activeStation) {
      socket.emit('webrtc:ice', {
        stationId: activeStation.id,
        targetId: listenerId,
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' ||
        pc.connectionState === 'closed') {
      pc.close();
      ownerConnections.delete(listenerId);
    }
  };

  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('webrtc:offer', {
      stationId: activeStation.id,
      targetId: listenerId,
      sdp: pc.localDescription
    });
  } catch (error) {
    console.error('Offer error:', error);
  }
}

socket.on('connect', () => {
  render();
});

socket.on('disconnect', () => {
  cleanupLive();
  showMessage('ارتباط با سرور قطع شد.');
  render();
});

socket.on('stations:update', onlineStations => {
  window.onlineStations = onlineStations || [];
  render();
});

socket.on('station:created', data => {
  showMessage(data.message || 'رادیو آماده پخش است.');
});

socket.on('station:error', message => {
  cleanupLive();
  showMessage(message);
  render();
});

socket.on('listener:joined', async data => {
  if (!activeStation || !activeStation.owner) return;
  if (data.stationId !== activeStation.id) return;

  await createOwnerConnection(data.listenerId);
});

socket.on('listener:left', data => {
  const connection = ownerConnections.get(data.listenerId);

  if (connection) connection.close();

  ownerConnections.delete(data.listenerId);
});

socket.on('webrtc:offer', async data => {
  if (!activeStation || activeStation.owner) return;
  if (data.stationId !== activeStation.id) return;

  cleanupConnections();

  const pc = new RTCPeerConnection(iceServers);
  listenerConnection = pc;

  pc.ontrack = event => {
    const audio = createPlayer().querySelector('#liveAudio');
    audio.srcObject = event.streams[0];
    audio.volume = currentVolume;

    audio.play().catch(() => {
      showMessage('برای شنیدن صدا، روی صفحه یک بار کلیک کن.');
    });
  };

  pc.onicecandidate = event => {
    if (event.candidate && activeStation) {
      socket.emit('webrtc:ice', {
        stationId: activeStation.id,
        targetId: data.from,
        candidate: event.candidate
      });
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('webrtc:answer', {
      stationId: activeStation.id,
      targetId: data.from,
      sdp: pc.localDescription
    });

    const queued = pendingCandidates.get(data.from) || [];

    for (const candidate of queued) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    pendingCandidates.delete(data.from);
  } catch (error) {
    console.error('Answer error:', error);
    showMessage('اتصال صوتی برقرار نشد.');
  }
});

socket.on('webrtc:answer', async data => {
  const pc = ownerConnections.get(data.from);

  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } catch (error) {
    console.error(error);
  }
});

socket.on('webrtc:ice', async data => {
  const pc = activeStation?.owner
    ? ownerConnections.get(data.from)
    : listenerConnection;

  if (!pc) {
    const list = pendingCandidates.get(data.from) || [];
    list.push(data.candidate);
    pendingCandidates.set(data.from, list);
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (error) {
    console.error('ICE error:', error);
  }
});

socket.on('station:ended', data => {
  if (activeStation?.id !== data.stationId) return;

  cleanupLive();
  showMessage('پخش این رادیو پایان یافت.');
  render();
});

function stationCard(station, mine = false) {
  return `
    <article class="station-card">
      <div class="station-icon">📻</div>
      <h3>${escapeHTML(station.name)}</h3>
      <p>${escapeHTML(station.description || 'رادیوی اینترنتی')}</p>

      ${
        mine
          ? `<button class="startStationBtn" data-id="${escapeHTML(station.id)}">
               شروع پخش زنده
             </button>`
          : `<button class="sampleBtn" data-id="${escapeHTML(station.id)}">
               مشاهده
             </button>`
      }
    </article>
  `;
}

function render() {
  if (!app) return;

  if (!currentUser) {
    app.innerHTML = `
      <main class="auth-page">
        <section class="auth-card">
          <div class="logo">📻</div>
          <h1>رادیو‌یار</h1>
          <p>رادیوی خودت را بساز و صدایت را به دیگران برسان.</p>

          <form id="loginForm">
            <input name="name" placeholder="نام شما" required maxlength="40">
            <button type="submit">ورود به رادیو‌یار</button>
          </form>
        </section>
      </main>
    `;

    document.querySelector('#loginForm').addEventListener('submit', event => {
      event.preventDefault();

      const name = new FormData(event.target).get('name').trim();

      if (!name) return;

      currentUser = {
        id: crypto.randomUUID(),
        name
      };

      saveData();
      render();
    });

    return;
  }

  const onlineStations = window.onlineStations;

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">📻 رادیو‌یار</div>
      <div class="user-area">
        <span>${escapeHTML(currentUser.name)}</span>
        <button id="logoutBtn">خروج</button>
      </div>
    </header>

    <main class="dashboard">
      <section class="hero">
        <h1>به رادیو‌یار خوش آمدی</h1>
        <p>رادیوی خودت را بساز و با دیگران به اشتراک بگذار.</p>
        <button id="createStationBtn">＋ ساخت رادیوی جدید</button>
      </section>

      <section class="section">
        <h2>رادیوهای زنده</h2>
        <div class="station-grid">
          ${
            onlineStations.length
              ? onlineStations.map(item => `
                  <article class="station-card">
                    <div class="station-icon">📡</div>
                    <h3>${escapeHTML(item.name)}</h3>
                    <p>👥 ${item.listeners} شنونده</p>
                    ${
                      activeStation?.id === item.id && activeStation.owner
                        ? '<button disabled>رادیوی شما</button>'
                        : `<button class="joinStationBtn" data-id="${escapeHTML(item.id)}">گوش دادن</button>`
                    }
                  </article>
                `).join('')
              : '<p>در حال حاضر رادیوی زنده‌ای وجود ندارد.</p>'
          }
        </div>
      </section>

      <section class="section">
        <h2>رادیوهای پیشنهادی</h2>
        <div class="station-grid">
          ${samples.map(station => stationCard(station, false)).join('')}
        </div>
      </section>

      <section class="section">
        <h2>رادیوهای من</h2>
        <div class="station-grid">
          ${
            stations.length
              ? stations.map(station => stationCard(station, true)).join('')
              : '<p>هنوز رادیویی نساخته‌ای.</p>'
          }
        </div>
      </section>
    </main>

    <div id="stationModal" class="modal hidden">
      <form id="stationForm" class="modal-card">
        <button type="button" id="closeModal" class="close-modal">×</button>
        <h2>ساخت رادیو</h2>
        <input name="name" placeholder="نام رادیو" maxlength="60" required>
        <input name="description" placeholder="توضیح کوتاه" maxlength="160">
        <button type="submit">ساخت رادیو</button>
      </form>
    </div>
  `;

  document.querySelector('#logoutBtn').addEventListener('click', () => {
    if (activeStation) stopLive();

    currentUser = null;
    saveData();
    render();
  });

  document.querySelector('#createStationBtn').addEventListener('click', () => {
    document.querySelector('#stationModal').classList.remove('hidden');
  });

  document.querySelector('#closeModal').addEventListener('click', () => {
    document.querySelector('#stationModal').classList.add('hidden');
  });

  document.querySelector('#stationForm').addEventListener('submit', event => {
    event.preventDefault();

    const form = new FormData(event.target);
    const name = String(form.get('name') || '').trim();
    const description = String(form.get('description') || '').trim();

    if (!name) return;

    const station = {
      id: crypto.randomUUID(),
      name,
      description,
      ownerId: currentUser.id
    };

    stations.unshift(station);
    saveData();

    document.querySelector('#stationModal').classList.add('hidden');

    event.target.reset();
    render();
    showMessage('رادیو ساخته شد.');
  });

  document.querySelectorAll('.startStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      const station = stations.find(
        item => item.id === button.dataset.id
      );

      if (station) {
        startStation(station);
      }
    });
  });

  document.querySelectorAll('.joinStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      const station = onlineStations.find(
        item => item.id === button.dataset.id
      );

      if (station) {
        joinStation(station);
      }
    });
  });

  document.querySelectorAll('.sampleBtn').forEach(button => {
    button.addEventListener('click', () => {
      showMessage('این رادیو نمونه است و هنوز پخش زنده ندارد.');
    });
  });
}

createPlayer();
render();
