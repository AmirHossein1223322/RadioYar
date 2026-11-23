
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
let profile = JSON.parse(localStorage.getItem('radioyar-profile') || 'null');

if (!profile || typeof profile !== 'object') {
  profile = {
    name: currentUser?.name || '',
    bio: '',
    photo: ''
  };
}

profile = {
  name: String(profile.name || currentUser?.name || ''),
  bio: String(profile.bio || ''),
  photo: typeof profile.photo === 'string' ? profile.photo : ''
};

if (currentUser && profile.name) {
  currentUser.name = profile.name;
}

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
let publicProfiles = [];

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

// تبدیل متن به HTML امن
function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

// ذخیره اطلاعات
function saveData() {
  localStorage.setItem('radioyar-user', JSON.stringify(currentUser));
  localStorage.setItem('radioyar-stations', JSON.stringify(stations));
  localStorage.setItem('radioyar-favorites', JSON.stringify(favorites));
  localStorage.setItem('radioyar-profile', JSON.stringify(profile));
}

// ارسال پروفایل به سرور
function syncProfileToServer() {
  if (!currentUser || !socket.connected) return;

  socket.emit('profile:update', {
    id: currentUser.id,
    name: profile.name || currentUser.name || 'کاربر',
    bio: profile.bio || '',
    photo: profile.photo || ''
  });
}

// دریافت فهرست پروفایل‌های عمومی
async function loadPublicProfiles() {
  try {
    const response = await fetch(`${SERVER_URL}/api/profiles`);

    if (!response.ok) {
      throw new Error('دریافت فهرست کاربران ناموفق بود.');
    }

    const result = await response.json();

    publicProfiles = Array.isArray(result) ? result : [];

  } catch (error) {
    console.error('Public profiles error:', error);
  }
}

// آواتار عمومی
function publicAvatarMarkup(user, size = 45) {
  if (user.photo) {
    return `
      <img
        src="${escapeHTML(user.photo)}"
        alt="عکس پروفایل"
        style="
          width:${size}px;
          height:${size}px;
          object-fit:cover;
          border-radius:50%;
        "
      >
    `;
  }

  const initial = String(user.name || 'ک').trim().charAt(0) || 'ک';

  return `
    <div style="
      width:${size}px;
      height:${size}px;
      display:flex;
      align-items:center;
      justify-content:center;
      border-radius:50%;
      background:linear-gradient(135deg,#7c3aed,#2563eb);
      color:white;
      font-size:${Math.round(size * 0.45)}px;
      font-weight:800;
      flex-shrink:0;
    ">${escapeHTML(initial)}</div>
  `;
}

// باز کردن پروفایل عمومی
async function openPublicProfile(userId) {
  if (!userId) return;

  if (String(userId) === String(currentUser?.id)) {
    document.querySelector('#profileModal')?.classList.remove('hidden');
    return;
  }

  try {
    const response = await fetch(
      `${SERVER_URL}/api/profiles/${encodeURIComponent(userId)}`
    );

    if (!response.ok) {
      showMessage('پروفایل این کاربر پیدا نشد.');
      return;
    }

    const user = await response.json();

    const oldModal = document.querySelector('#publicProfileModal');

    if (oldModal) {
      oldModal.remove();
    }

    const userStations = Array.isArray(user.stations)
      ? user.stations
      : [];

    const modal = document.createElement('div');

    modal.id = 'publicProfileModal';
    modal.className = 'modal';

    modal.innerHTML = `
      <section class="modal-card" style="
        width:min(100%,480px);
        max-height:85vh;
        overflow-y:auto;
        text-align:center;
      ">
        <button
          type="button"
          id="closePublicProfile"
          class="close-modal"
        >×</button>

        <div style="
          width:110px;
          height:110px;
          margin:20px auto;
          border-radius:50%;
          overflow:hidden;
          background:#38364f;
          display:flex;
          align-items:center;
          justify-content:center;
          border:3px solid #8b5cf6;
        ">
          ${publicAvatarMarkup(user, 110)}
        </div>

        <h2>${escapeHTML(user.name || 'کاربر')}</h2>

        <p style="
          color:#bbb;
          line-height:1.8;
          overflow-wrap:anywhere;
        ">
          ${escapeHTML(user.bio || 'این کاربر توضیحی ننوشته است.')}
        </p>

        <div style="
          margin:15px 0;
          padding:12px;
          background:#25243a;
          border-radius:12px;
        ">
          <strong style="font-size:24px">
            ${Number(user.stationCount) || userStations.length}
          </strong>

          <p style="color:#bbb;font-size:12px;margin:4px 0 0">
            رادیوی ساخته‌شده
          </p>
        </div>

        <h3 style="margin-top:20px">📻 رادیوهای این کاربر</h3>

        ${
          userStations.length
            ? userStations.map(station => `
                <div style="
                  text-align:right;
                  background:#25243a;
                  padding:12px;
                  margin-top:8px;
                  border-radius:10px;
                ">
                  <strong>${escapeHTML(station.name)}</strong>

                  <p style="font-size:12px;color:#bbb;margin-top:5px">
                    ${escapeHTML(station.category || 'عمومی')}
                    ${station.online ? ' · 🟢 آنلاین' : ' · آفلاین'}
                  </p>
                </div>
              `).join('')
            : '<p style="color:#aaa">هنوز رادیویی نساخته است.</p>'
        }
      </section>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#closePublicProfile').addEventListener(
      'click',
      () => modal.remove()
    );

    modal.addEventListener('click', event => {
      if (event.target === modal) {
        modal.remove();
      }
    });

  } catch (error) {
    console.error('Public profile error:', error);
    showMessage('دریافت پروفایل ناموفق بود.');
  }
}

// فهرست کاربران
function renderPublicProfiles() {
  if (!publicProfiles.length) {
    return '<p style="color:#aaa">هنوز کاربری ثبت نشده است.</p>';
  }

  return publicProfiles.map(user => `
    <article class="station-card">
      <div style="
        display:flex;
        align-items:center;
        gap:12px;
        margin-bottom:12px;
      ">
        ${publicAvatarMarkup(user, 48)}

        <div style="text-align:right;min-width:0">
          <strong>${escapeHTML(user.name || 'کاربر')}</strong>

          <p style="
            color:#aaa;
            font-size:12px;
            margin-top:5px;
          ">
            ${Number(user.stationCount) || 0} رادیو
          </p>
        </div>
      </div>

      <p style="
        color:#bbb;
        font-size:13px;
        overflow-wrap:anywhere;
      ">
        ${escapeHTML(user.bio || 'توضیحی ثبت نشده است.')}
      </p>

      <button
        class="viewProfileBtn"
        data-user-id="${escapeHTML(user.id)}"
        type="button"
      >
        مشاهده پروفایل
      </button>
    </article>
  `).join('');
}

// آواتار پروفایل شخصی
function profileAvatarMarkup() {
  if (profile.photo) {
    return `
      <img
        src="${escapeHTML(profile.photo)}"
        alt="عکس پروفایل"
        style="
          width:100%;
          height:100%;
          object-fit:cover;
          border-radius:50%;
        "
      >
    `;
  }

  const initial =
    (profile.name || currentUser?.name || 'ک').trim().charAt(0) || 'ک';

  return `
    <div style="
      width:100%;
      height:100%;
      display:flex;
      align-items:center;
      justify-content:center;
      border-radius:50%;
      background:linear-gradient(135deg,#7c3aed,#2563eb);
      color:white;
      font-size:42px;
      font-weight:800;
    ">${escapeHTML(initial)}</div>
  `;
}

// فهرست رادیوهای شخصی در پروفایل
function renderProfileStations() {
  if (!stations.length) {
    return '<p style="color:#aaa">هنوز رادیویی نساخته‌ای.</p>';
  }

  return `
    <div style="display:grid;gap:8px">
      ${stations.map(station => `
        <div style="
          padding:10px 12px;
          background:#25243a;
          border:1px solid #3c3954;
          border-radius:10px;
          text-align:right;
        ">
          <strong>${escapeHTML(station.name || 'رادیو بدون نام')}</strong>

          <div style="font-size:12px;color:#aaa;margin-top:4px">
            ${escapeHTML(station.category || 'عمومی')}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// کوچک‌کردن عکس برای ذخیره در گوشی و سرور
function resizeProfilePhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(new Error('خواندن عکس ناموفق بود.'));

    reader.onload = () => {
      const image = new Image();

      image.onerror = () => reject(new Error('فایل عکس قابل خواندن نیست.'));

      image.onload = () => {
        const maxSide = 320;
        const scale = Math.min(
          1,
          maxSide / Math.max(image.width, image.height)
        );

        const canvas = document.createElement('canvas');

        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));

        const context = canvas.getContext('2d');

        if (!context) {
          reject(new Error('پردازش عکس ممکن نشد.'));
          return;
        }

        context.drawImage(
          image,
          0,
          0,
          canvas.width,
          canvas.height
        );

        resolve(canvas.toDataURL('image/jpeg', 0.58));
      };

      image.src = String(reader.result || '');
    };

    reader.readAsDataURL(file);
  });
}

// بررسی علاقه‌مندی بودن
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

// نمایش پیام
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

        <button id="stopLive" type="button">
          توقف پخش
        </button>
      </div>

      <div id="ownerControls" style="display:none;margin-top:15px">
        <button id="muteMic" type="button">
          قطع میکروفون
        </button>
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
    // مطمئن می‌شویم پروفایل قبل از ساخت رادیو ارسال شده باشد
    syncProfileToServer();

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

// رویداد اتصال سرور
socket.on('connect', async () => {
  syncProfileToServer();
  await loadPublicProfiles();
  render();
});

// تأیید ذخیره پروفایل
socket.on('profile:saved', async () => {
  await loadPublicProfiles();
  render();
});

// دریافت خطاهای پروفایل
socket.on('profile:error', message => {
  showMessage(message || 'ذخیره پروفایل ناموفق بود.');
});

// به‌روزرسانی فهرست کاربران
socket.on('profiles:update', async () => {
  await loadPublicProfiles();
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

// ساخت کارت رادیوهای زنده
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
        item.ownerId
          ? `
            <button
              class="viewProfileBtn"
              data-user-id="${escapeHTML(item.ownerId)}"
              type="button"
              style="
                background:#38364f;
                color:#c4b5fd;
                margin-top:5px;
              "
            >
              👤 سازنده: ${escapeHTML(item.ownerName || 'مشاهده پروفایل')}
            </button>
          `
          : `
            <p style="font-size:12px;color:#aaa">
              سازنده: ${escapeHTML(item.ownerName || 'کاربر')}
            </p>
          `
      }

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

// ویرایش رادیوهای شخصی
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

      <button
        class="editStationBtn"
        data-id="${escapeHTML(station.id)}"
        type="button"
      >
        ✏️ ویرایش رادیو
      </button>

      <button
        class="deleteStationBtn"
        data-id="${escapeHTML(station.id)}"
        type="button"
        style="background:#dc2626;color:white"
      >
        🗑️ حذف رادیو
      </button>
    </article>
  `).join('');
}

// ویرایش رادیو
function editStation(id) {
  const station = stations.find(
    item => String(item.id) === String(id)
  );

  if (!station) return;

  if (activeStation && String(activeStation.id) === String(id)) {
    showMessage('برای ویرایش، ابتدا پخش رادیو را متوقف کن.');
    return;
  }

  const name = prompt('نام جدید رادیو:', station.name);

  if (name === null) return;

  if (!name.trim()) {
    showMessage('نام رادیو نمی‌تواند خالی باشد.');
    return;
  }

  const description = prompt(
    'توضیحات جدید:',
    station.description || ''
  );

  if (description === null) return;

  const category = prompt(
    'دسته‌بندی جدید را وارد کن:\n' + stationCategories.join('، '),
    station.category || 'عمومی'
  );

  if (category === null) return;

  const selectedCategory = category.trim();

  if (!stationCategories.includes(selectedCategory)) {
    showMessage('دسته‌بندی معتبر نیست.');
    return;
  }

  station.name = name.trim();
  station.description = description.trim();
  station.category = selectedCategory;

  favorites = favorites.map(item =>
    String(item.id) === String(id)
      ? {
          ...item,
          name: station.name,
          description: station.description,
          category: station.category
        }
      : item
  );

  saveData();
  render();

  showMessage('رادیو با موفقیت ویرایش شد.');
}

// حذف رادیو
function deleteStation(id) {
  const station = stations.find(
    item => String(item.id) === String(id)
  );

  if (!station) return;

  if (activeStation && String(activeStation.id) === String(id)) {
    showMessage('ابتدا پخش رادیو را متوقف کن.');
    return;
  }

  const confirmed = confirm(
    `آیا از حذف رادیوی «${station.name}» مطمئنی؟`
  );

  if (!confirmed) return;

  stations = stations.filter(
    item => String(item.id) !== String(id)
  );

  favorites = favorites.filter(
    item => String(item.id) !== String(id)
  );

  saveData();
  render();

  showMessage('رادیو حذف شد.');
}

// نمایش رادیوهای موردعلاقه
function renderFavorites() {
  if (!favorites.length) {
    return `
      <p>
        هنوز رادیویی به علاقه‌مندی‌ها اضافه نکرده‌ای.
        روی دکمه ستاره یک رادیو بزن.
      </p>
    `;
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

        <p>
          ${escapeHTML(station.description || 'رادیوی اینترنتی')}
        </p>

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

// اتصال دکمه‌های پروفایل عمومی
function attachProfileButtons() {
  document.querySelectorAll('.viewProfileBtn').forEach(button => {
    button.addEventListener('click', () => {
      openPublicProfile(button.dataset.userId);
    });
  });
}

// اتصال دکمه‌های ورود به رادیو
function attachJoinButtons() {
  document.querySelectorAll('.joinStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      const station = window.onlineStations.find(
        item => String(item.id) === String(button.dataset.id)
      );

      if (station) {
        joinStation(station);
      }
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

      if (station) {
        startStation(station);
      }
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

      if (station) {
        toggleFavorite(station);
      }
    });
  });
}

// اتصال دکمه‌های ویرایش و حذف
function attachManagementButtons() {
  document.querySelectorAll('.editStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      editStation(button.dataset.id);
    });
  });

  document.querySelectorAll('.deleteStationBtn').forEach(button => {
    button.addEventListener('click', () => {
      deleteStation(button.dataset.id);
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

            <button type="submit">
              ورود به رادیو‌یار
            </button>
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

      profile = {
        ...profile,
        name
      };

      saveData();

      syncProfileToServer();
      loadPublicProfiles().then(() => render());

      render();
    });

    return;
  }

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">📻 رادیو‌یار</div>

      <div class="user-area">
        <span>${escapeHTML(profile.name || currentUser.name)}</span>

        <button id="profileBtn" type="button">
          👤 پروفایل من
        </button>

        <button id="logoutBtn" type="button">
          خروج
        </button>
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
        <h2>👥 کاربران رادیو‌یار</h2>

        <div class="station-grid" id="publicProfilesGrid">
          ${renderPublicProfiles()}
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

        <button type="submit">
          ساخت رادیو
        </button>

      </form>
    </div>

    <div id="profileModal" class="modal hidden">
      <section class="modal-card" style="
        width:min(100%,520px);
        max-height:85vh;
        overflow-y:auto;
      ">
        <button
          type="button"
          id="closeProfileModal"
          class="close-modal"
        >×</button>

        <h2 style="margin-top:4px">پروفایل من</h2>

        <div style="
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:10px;
          margin:18px 0;
        ">
          <div id="profileAvatar" style="
            width:112px;
            height:112px;
            overflow:hidden;
            border-radius:50%;
            border:3px solid #8b5cf6;
          ">
            ${profileAvatarMarkup()}
          </div>

          <label for="profilePhotoInput" style="
            display:inline-block;
            padding:9px 14px;
            border-radius:10px;
            background:#4c1d95;
            color:white;
            cursor:pointer;
          ">📷 انتخاب عکس پروفایل</label>

          <input
            id="profilePhotoInput"
            type="file"
            accept="image/*"
            style="display:none"
          >
        </div>

        <form id="profileForm">
          <label for="profileName" style="display:block;margin:10px 0 6px">
            نام نمایشی
          </label>

          <input
            id="profileName"
            name="name"
            value="${escapeHTML(profile.name || currentUser.name)}"
            maxlength="40"
            required
            placeholder="نام نمایشی شما"
          >

          <label for="profileBio" style="display:block;margin:12px 0 6px">
            درباره من
          </label>

          <textarea
            id="profileBio"
            name="bio"
            maxlength="160"
            rows="3"
            placeholder="چند کلمه درباره خودت بنویس..."
            style="width:100%;resize:vertical;box-sizing:border-box"
          >${escapeHTML(profile.bio)}</textarea>

          <button type="submit" style="width:100%;margin-top:12px">
            💾 ذخیره پروفایل
          </button>
        </form>

        <div style="
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:10px;
          margin:18px 0;
        ">
          <div style="
            background:#25243a;
            padding:14px;
            border-radius:12px;
            text-align:center;
          ">
            <strong style="display:block;font-size:24px">
              ${stations.length}
            </strong>

            <span style="font-size:12px;color:#bbb">
              رادیوی ساخته‌شده
            </span>
          </div>

          <div style="
            background:#25243a;
            padding:14px;
            border-radius:12px;
            text-align:center;
          ">
            <strong style="display:block;font-size:24px">
              ${favorites.length}
            </strong>

            <span style="font-size:12px;color:#bbb">
              علاقه‌مندی
            </span>
          </div>
        </div>

        <h3 style="margin:12px 0">📻 رادیوهای من</h3>

        ${renderProfileStations()}

        <p style="
          font-size:11px;
          color:#aaa;
          line-height:1.8;
          margin-top:16px;
        ">
          نام، عکس و توضیحات این پروفایل برای کاربران دیگر قابل مشاهده است.
        </p>
      </section>
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
      attachProfileButtons();
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
      attachProfileButtons();
    }
  });

  // خروج
  document.querySelector('#logoutBtn').addEventListener('click', () => {
    if (activeStation) {
      stopLive();
    }

    currentUser = null;
    saveData();
    render();
  });

  // باز کردن پروفایل شخصی
  document.querySelector('#profileBtn').addEventListener('click', () => {
    document.querySelector('#profileModal')?.classList.remove('hidden');
  });

  // بستن پروفایل شخصی
  document.querySelector('#closeProfileModal').addEventListener('click', () => {
    document.querySelector('#profileModal')?.classList.add('hidden');
  });

  document.querySelector('#profileModal').addEventListener('click', event => {
    if (event.target.id === 'profileModal') {
      event.currentTarget.classList.add('hidden');
    }
  });

  // انتخاب عکس پروفایل
  document.querySelector('#profilePhotoInput').addEventListener('change', async event => {
    const file = event.currentTarget.files?.[0];

    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showMessage('لطفاً یک فایل تصویری انتخاب کن.');
      event.currentTarget.value = '';
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showMessage('حجم عکس باید کمتر از ۵ مگابایت باشد.');
      event.currentTarget.value = '';
      return;
    }

    try {
      const oldPhoto = profile.photo;

      profile.photo = await resizeProfilePhoto(file);

      try {
        saveData();
      } catch (storageError) {
        profile.photo = oldPhoto;
        throw storageError;
      }

      const avatar = document.querySelector('#profileAvatar');

      if (avatar) {
        avatar.innerHTML = profileAvatarMarkup();
      }

      syncProfileToServer();

      showMessage('عکس پروفایل ذخیره و برای سرور ارسال شد.');

    } catch (error) {
      console.error('Profile photo error:', error);
      showMessage('ذخیره عکس ناموفق بود. یک عکس دیگر انتخاب کن.');
    }

    event.currentTarget.value = '';
  });

  // ذخیره نام و توضیحات پروفایل
  document.querySelector('#profileForm').addEventListener('submit', event => {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const name = String(form.get('name') || '').trim();
    const bio = String(form.get('bio') || '').trim();

    if (!name) {
      showMessage('نام نمایشی را وارد کن.');
      return;
    }

    const previousProfile = { ...profile };
    const previousUser = { ...currentUser };

    profile = {
      ...profile,
      name,
      bio
    };

    currentUser = {
      ...currentUser,
      name
    };

    try {
      saveData();
      syncProfileToServer();

      render();

      showMessage('پروفایل ذخیره شد و برای سرور ارسال شد.');

    } catch (error) {
      profile = previousProfile;
      currentUser = previousUser;

      console.error('Profile save error:', error);

      showMessage('ذخیره پروفایل ممکن نشد.');
    }
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

  // اتصال دکمه‌ها
  attachJoinButtons();
  attachStartButtons();
  attachFavoriteButtons();
  attachManagementButtons();
  attachProfileButtons();
}

createPlayer();
render();
