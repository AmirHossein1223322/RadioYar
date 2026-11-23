
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
let favorites = JSON.parse(localStorage.getItem('radioyar-favorites') || '[]');

let activeStation = null;
let localStream = null;
let listenerConnection = null;
let ownerConnections = new Map();
let pendingCandidates = new Map();
let isMuted = false;
let currentVolume = 1;
let chatMessages = [];
let stationSearchText = '';
let categoryFilter = 'همه';

window.onlineStations = [];

const stationCategories = [
  'عمومی',
  'موسیقی',
  'اخبار',
  'ورزشی',
  'گفت‌وگو',
  'سرگرمی',
  'آموزشی'
];

const iceServers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

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
  localStorage.setItem('radioyar-favorites', JSON.stringify(favorites));
}

function isFavorite(id) {
  return favorites.some(item => String(item.id) === String(id));
}

// افزودن یا حذف علاقه‌مندی
function toggleFavorite(station) {
  if (!station || !station.id) return;

  if (isFavorite(station.id)) {
    favorites = favorites.filter(
      item => String(item.id) !== String(station.id)
    );

    showMessage('از علاقه‌مندی‌ها حذف شد.');
  } else {
    favorites.unshift({
      id: station.id,
      name: station.name || 'رادیو بدون نام',
      description: station.description || '',
      category: station.category || 'عمومی'
    });

    showMessage('⭐ به علاقه‌مندی‌ها اضافه شد.');
  }

  saveData();
  render();
}

// دکمه علاقه‌مندی
function favoriteButton(station) {
  const favorite = isFavorite(station.id);

  return `
    <button
      class="favoriteBtn"
      data-id="${escapeHTML(station.id)}"
      type="button"
      style="
        background:${favorite ? '#f59e0b' : '#38364f'};
        color:white;
        margin-top:8px;
      "
    >
      ${favorite ? '⭐ حذف از علاقه‌مندی‌ها' : '☆ افزودن به علاقه‌مندی‌ها'}
    </button>
  `;
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

// نمایش پیام چت
function appendChatMessage(data) {
  const box = document.querySelector('#chatMessages');
  if (!box) return;

  if (chatMessages.length === 0) {
    box.innerHTML = '';
  }

  chatMessages.push(data);

  if (chatMessages.length > 100) {
    chatMessages.shift();
  }

  box.innerHTML = chatMessages.map(item => `
    <div style="
      margin-bottom:10px;
      padding:8px;
      background:#25243a;
      border-radius:8px;
      overflow-wrap:anywhere;
    ">
      <strong style="color:#a78bfa">
        ${escapeHTML(item.senderName)}
      </strong>
      <div style="margin-top:4px">
        ${escapeHTML(item.message)}
      </div>
    </div>
  `).join('');

  box.scrollTop = box.scrollHeight;
}

// پاک کردن چت
function resetChat() {
  chatMessages = [];

  const box = document.querySelector('#chatMessages');

  if (box) {
    box.innerHTML = '<p style="color:#aaa">هنوز پیامی ارسال نشده است.</p>';
  }
}

// ساخت پنل پخش زنده
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
      max-height:85vh;
      overflow-y:auto;
    `;

    player.innerHTML = `
      <div style="
        display:flex;
        justify-content:space-between;
        gap:12px;
        align-items:center;
        flex-wrap:wrap;
      ">
        <div>
          <strong id="playerTitle">رادیو زنده</strong>
          <div id="playerStatus" style="
            font-size:12px;
            color:#aaa;
            margin-top:5px;
          ">
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
        <input
          id="volumeControl"
          type="range"
          min="0"
          max="100"
          value="100"
          style="width:100%"
        >
      </div>

      <audio id="liveAudio" autoplay playsinline></audio>

      <div id="chatPanel" style="
        margin-top:15px;
        border-top:1px solid #44415e;
        padding-top:12px;
      ">
        <strong>💬 گفت‌وگوی زنده</strong>

        <div id="chatMessages" style="
          height:180px;
          overflow-y:auto;
          margin:10px 0;
          padding:10px;
          background:#171625;
          border-radius:10px;
          font-size:13px;
        ">
          <p style="color:#aaa">هنوز پیامی ارسال نشده است.</p>
        </div>

        <form id="chatForm" style="display:flex;gap:8px">
          <input
            id="chatInput"
            type="text"
            maxlength="500"
            placeholder="پیامت را بنویس..."
            required
            style="flex:1;min-width:0"
          >
          <button type="submit">ارسال</button>
        </form>
      </div>
    `;

    document.body.appendChild(player);

    player.querySelector('#stopLive').addEventListener('click', stopLive);
    player.querySelector('#muteMic').addEventListener('click', toggleMicrophone);

    player.querySelector('#volumeControl').addEventListener('input', event => {
      currentVolume = Number(event.target.value) / 100;
      player.querySelector('#liveAudio').volume = currentVolume;
    });

    player.querySelector('#chatForm').addEventListener('submit', event => {
      event.preventDefault();

      const input = player.querySelector('#chatInput');
      const message = input.value.trim();

      if (!message || !activeStation) return;

      if (!socket.connected) {
        showMessage('اتصال به سرور برقرار نیست.');
        return;
      }

      socket.emit('chat:send', {
        stationId: activeStation.id,
        senderName: currentUser?.name || 'کاربر',
        message
      });

      input.value = '';
    });
  }

  return player;
}

// نمایش پنل پخش
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

  resetChat();
}

// پاک کردن اتصال‌ها
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

// پایان پخش
function cleanupLive() {
  cleanupConnections();

  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }

  resetChat();

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

// توقف رادیو
function stopLive() {
  if (!activeStation) return;

  socket.emit('station:leave', activeStation.id);

  cleanupLive();
  showMessage('پخش زنده متوقف شد.');
  render();
}

// کنترل میکروفون
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

// شروع رادیو
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
      category: station.category || 'عمومی',
      owner: true
    };

    socket.emit('station:create', {
      stationId: station.id,
      name: station.name,
      description: station.description || '',
      category: station.category || 'عمومی'
    });

    showPlayer(station.name, true);
    showMessage('درخواست پخش زنده ارسال شد.');

  } catch (error) {
    console.error(error);
    cleanupLive();
    showMessage('دسترسی به میکروفون ممکن نشد.');
  }
}

// ورود شنونده به رادیو
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

// اتصال صاحب رادیو به شنونده
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
    if (
      pc.connectionState === 'failed' ||
      pc.connectionState === 'closed'
    ) {
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

// رویدادهای سرور
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
  showMessage(message || 'خطایی در رادیو رخ داد.');
  render();
});

// دریافت پیام چت
socket.on('chat:message', data => {
  if (!activeStation) return;
  if (data.stationId !== activeStation.id) return;

  appendChatMessage(data);
});

// ورود شنونده
socket.on('listener:joined', async data => {
  if (!activeStation || !activeStation.owner) return;
  if (data.stationId !== activeStation.id) return;

  await createOwnerConnection(data.listenerId);
});

// خروج شنونده
socket.on('listener:left', data => {
  const connection = ownerConnections.get(data.listenerId);

  if (connection) connection.close();
  ownerConnections.delete(data.listenerId);
});

// دریافت پیشنهاد اتصال صوتی
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

// دریافت پاسخ اتصال
socket.on('webrtc:answer', async data => {
  const pc = ownerConnections.get(data.from);
  if (!pc) return;

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } catch (error) {
    console.error(error);
  }
});

// دریافت ICE
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

// پایان رادیو از طرف سرور
socket.on('station:ended', data => {
  if (activeStation?.id !== data.stationId) return;

  cleanupLive();
  showMessage('پخش این رادیو پایان یافت.');
  render();
});

// ساخت فهرست دسته‌بندی‌ها
function renderCategoryOptions(selected = 'عمومی') {
  return stationCategories.map(category => `
    <option
      value="${escapeHTML(category)}"
      ${category === selected ? 'selected' : ''}
    >
      ${escapeHTML(category)}
    </option>
  `).join('');
}

// کارت رادیوهای زنده
function renderOnlineStations() {
  const search = stationSearchText.trim().toLocaleLowerCase('fa');

  const filteredStations = window.onlineStations.filter(station => {
    const matchesSearch = String(station.name || '')
      .toLocaleLowerCase('fa')
      .includes(search);

    const matchesCategory =
      categoryFilter === 'همه' ||
      (station.category || 'عمومی') === categoryFilter;

    return matchesSearch && matchesCategory;
  });

  if (!filteredStations.length) {
    return `
      <p>
        ${
          search || categoryFilter !== 'همه'
            ? 'رادیویی با این مشخصات پیدا نشد.'
            : 'در حال حاضر رادیوی زنده‌ای وجود ندارد.'
        }
      </p>
    `;
  }

  return filteredStations.map(item => `
    <article class="station-card">
      <div class="station-icon">📡</div>

      <h3>${escapeHTML(item.name)}</h3>

      <p>${escapeHTML(item.description || 'رادیوی اینترنتی')}</p>

      <p>🏷️ ${escapeHTML(item.category || 'عمومی')}</p>

      <p>👥 ${Number(item.listeners) || 0} شنونده</p>

      ${
        activeStation?.id === item.id && activeStation.owner
          ? '<button disabled>رادیوی شما</button>'
          : `
            <button
              class="joinStationBtn"
              data-id="${escapeHTML(item.id)}"
              type="button"
            >
              گوش دادن
            </button>
          `
      }

      ${favoriteButton(item)}
    </article>
  `).join('');
}

// کارت رادیوهای ساخته‌شده توسط کاربر
function renderMyStations() {
  if (!stations.length) {
    return '<p>هنوز رادیویی نساخته‌ای.</p>';
  }

  return stations.map(station => `
    <article class="station-card">
      <div class="station-icon">📻</div>

      <h3>${escapeHTML(station.name)}</h3>

      <p>${escapeHTML(station.description || 'رادیوی اینترنتی')}</p>

      <p>🏷️ ${escapeHTML(station.category || 'عمومی')}</p>

      <button
        class="startStationBtn"
        data-id="${escapeHTML(station.id)}"
        type="button"
      >
        شروع پخش زنده
      </button>

      ${favoriteButton(station)}
    </article>
  `).join('');
}

// کارت علاقه‌مندی‌ها
function renderFavorites() {
  if (!favorites.length) {
    return '<p>هنوز رادیویی به علاقه‌مندی‌ها اضافه نکرده‌ای. روی دکمه ستاره یک رادیو بزن.</p>';
  }

  return favorites.map(favorite => {
    const onlineStation = window.onlineStations.find(
      item => String(item.id) === String(favorite.id)
    );

    const myStation = stations.find(
      item => String(item.id) === String(favorite.id)
    );

    const station = onlineStation || myStation || favorite;

    let actionButton = '';

    if (onlineStation) {
      actionButton = `
        <button
          class="joinStationBtn"
          data-id="${escapeHTML(station.id)}"
          type="button"
        >
          گوش دادن
        </button>
      `;
    } else if (myStation) {
      actionButton = `
        <button
          class="startStationBtn"
          data-id="${escapeHTML(station.id)}"
          type="button"
        >
          شروع پخش زنده
        </button>
      `;
    } else {
      actionButton = `
        <button type="button" disabled>
          در حال حاضر آفلاین
        </button>
      `;
    }

    return `
      <article class="station-card">
        <div class="station-icon">⭐</div>

        <h3>${escapeHTML(station.name)}</h3>

        <p>${escapeHTML(station.description || 'رادیوی اینترنتی')}</p>

        <p>🏷️ ${escapeHTML(station.category || 'عمومی')}</p>

        ${actionButton}

        <button
          class="favoriteBtn"
          data-id="${escapeHTML(station.id)}"
          type="button"
          style="background:#f59e0b;color:white;margin-top:8px"
        >
          ⭐ حذف از علاقه‌مندی‌ها
        </button>
      </article>
    `;
  }).join('');
}

// اتصال دکمه‌های ورود به رادیو
function attachJoinButtons() {
  document.querySelectorAll('.joinStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      const station = window.onlineStations.find(
        item => String(item.id) === String(button.dataset.id)
      );

      if (station) joinStation(station);
    });
  });
}

// اتصال دکمه‌های شروع رادیوی شخصی
function attachStartButtons() {
  document.querySelectorAll('.startStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      const station = stations.find(
        item => String(item.id) === String(button.dataset.id)
      );

      if (station) startStation(station);
    });
  });
}

// اتصال دکمه‌های علاقه‌مندی
function attachFavoriteButtons() {
  document.querySelectorAll('.favoriteBtn').forEach(button => {
    button.addEventListener('click', () => {
      const id = button.dataset.id;

      const station =
        window.onlineStations.find(item => String(item.id) === String(id)) ||
        stations.find(item => String(item.id) === String(id)) ||
        favorites.find(item => String(item.id) === String(id));

      if (station) toggleFavorite(station);
    });
  });
}

// صفحه اصلی
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
            <input
              name="name"
              placeholder="نام شما"
              required
              maxlength="40"
            >

            <button type="submit">ورود به رادیو‌یار</button>
          </form>
        </section>
      </main>
    `;

    document.querySelector('#loginForm').addEventListener('submit', event => {
      event.preventDefault();

      const name = String(
        new FormData(event.currentTarget).get('name') || ''
      ).trim();

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

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">📻 رادیو‌یار</div>

      <div class="user-area">
        <span>${escapeHTML(currentUser.name)}</span>

        <button id="logoutBtn" type="button">خروج</button>
      </div>
    </header>

    <main class="dashboard">

      <section class="hero">
        <h1>به رادیو‌یار خوش آمدی</h1>

        <p>رادیوی خودت را بساز و با دیگران به اشتراک بگذار.</p>

        <button id="createStationBtn" type="button">
          ＋ ساخت رادیوی جدید
        </button>
      </section>

      <section class="section">
        <h2>⭐ رادیوهای موردعلاقه من</h2>

        <div class="station-grid">
          ${renderFavorites()}
        </div>
      </section>

      <section class="section">
        <h2>رادیوهای زنده</h2>

        <input
          id="stationSearch"
          type="search"
          placeholder="🔍 جست‌وجوی نام رادیو..."
          value="${escapeHTML(stationSearchText)}"
          style="
            width:100%;
            max-width:450px;
            margin:12px 0;
            padding:13px;
            border-radius:12px;
          "
        >

        <select
          id="categoryFilter"
          style="
            width:100%;
            max-width:450px;
            margin:5px 0 15px;
            padding:13px;
            border-radius:12px;
          "
        >
          <option value="همه">همه دسته‌بندی‌ها</option>
          ${renderCategoryOptions()}
        </select>

        <div class="station-grid" id="onlineStationsGrid">
          ${renderOnlineStations()}
        </div>
      </section>

      <section class="section">
        <h2>رادیوهای من</h2>

        <div class="station-grid">
          ${renderMyStations()}
        </div>
      </section>

    </main>

    <div id="stationModal" class="modal hidden">
      <form id="stationForm" class="modal-card">

        <button
          type="button"
          id="closeModal"
          class="close-modal"
        >
          ×
        </button>

        <h2>ساخت رادیو</h2>

        <input
          name="name"
          placeholder="نام رادیو"
          maxlength="60"
          required
        >

        <input
          name="description"
          placeholder="توضیح کوتاه"
          maxlength="160"
        >

        <label for="stationCategory" style="display:block;margin:12px 0 6px">
          دسته‌بندی رادیو
        </label>

        <select
          id="stationCategory"
          name="category"
          required
          style="width:100%;padding:12px;border-radius:10px"
        >
          ${renderCategoryOptions()}
        </select>

        <button type="submit">ساخت رادیو</button>

      </form>
    </div>
  `;

  // جست‌وجوی نام رادیو
  document.querySelector('#stationSearch').addEventListener('input', event => {
    stationSearchText = event.target.value;

    const grid = document.querySelector('#onlineStationsGrid');

    if (grid) {
      grid.innerHTML = renderOnlineStations();
      attachJoinButtons();
      attachFavoriteButtons();
    }
  });

  // فیلتر دسته‌بندی
  document.querySelector('#categoryFilter').value = categoryFilter;

  document.querySelector('#categoryFilter').addEventListener('change', event => {
    categoryFilter = event.target.value;

    const grid = document.querySelector('#onlineStationsGrid');

    if (grid) {
      grid.innerHTML = renderOnlineStations();
      attachJoinButtons();
      attachFavoriteButtons();
    }
  });

  // خروج
  document.querySelector('#logoutBtn').addEventListener('click', () => {
    if (activeStation) stopLive();

    currentUser = null;
    saveData();
    render();
  });

  // باز کردن فرم ساخت رادیو
  document.querySelector('#createStationBtn').addEventListener('click', () => {
    const modal = document.querySelector('#stationModal');

    if (modal) {
      modal.classList.remove('hidden');
      modal.querySelector('input[name="name"]')?.focus();
    }
  });

  // بستن فرم
  document.querySelector('#closeModal').addEventListener('click', () => {
    document.querySelector('#stationModal')?.classList.add('hidden');
  });

  document.querySelector('#stationModal').addEventListener('click', event => {
    if (event.target.id === 'stationModal') {
      event.currentTarget.classList.add('hidden');
    }
  });

  // ساخت رادیوی جدید
  document.querySelector('#stationForm').addEventListener('submit', event => {
    event.preventDefault();

    try {
      const form = new FormData(event.currentTarget);

      const name = String(form.get('name') || '').trim();
      const description = String(form.get('description') || '').trim();
      const requestedCategory = String(form.get('category') || 'عمومی');

      const category = stationCategories.includes(requestedCategory)
        ? requestedCategory
        : 'عمومی';

      if (!name) {
        showMessage('نام رادیو را وارد کن.');
        return;
      }

      const station = {
        id: crypto.randomUUID(),
        name,
        description,
        category,
        ownerId: currentUser.id
      };

      stations.unshift(station);
      saveData();

      event.currentTarget.reset();

      document.querySelector('#stationModal')?.classList.add('hidden');

      render();
      showMessage('رادیو با موفقیت ساخته شد.');

    } catch (error) {
      console.error('Create station error:', error);
      showMessage('ساخت رادیو ناموفق بود. دوباره تلاش کن.');
    }
  });

  attachJoinButtons();
  attachStartButtons();
  attachFavoriteButtons();
}

createPlayer();
render();
