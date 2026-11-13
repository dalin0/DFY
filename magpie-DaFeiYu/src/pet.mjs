import { AnimationDirector } from './animation.mjs';
import { quotaEntries } from './quota-display.mjs';
import { providerIconSource, providerInitial } from './provider-icons.mjs';

const api = window.pet;
const videos = [...document.querySelectorAll('video')];
const lights = document.querySelector('#request-lights');
const stage = document.querySelector('#stage');
const hitCanvas = document.createElement('canvas');
hitCanvas.width = 256;
hitCanvas.height = 144;
const hitContext = hitCanvas.getContext('2d', { willReadFrequently: true });
let visible = 0;
let generation = 0;
let director;
let settings;
let activity;
let quota;
let pointerStart;
let dragging = false;
let animationTimer;
let lastInteractive;
let failureCount = 0;
window.petDiagnostics = { loaded: false, errors: [], played: [], transparent: false };

// ── 语音（A 状态播报 / B 回复朗读）──────────────────────────────────────────
const speech = 'speechSynthesis' in window ? window.speechSynthesis : null;
const voices = [];
function loadVoices() {
  if (!speech) return;
  const list = speech.getVoices();
  if (!list.length) return;
  voices.length = 0;
  voices.push(...list);
}
if (speech) { loadVoices(); speech.onvoiceschanged = loadVoices; }

// Apple 较新的中文音色语气比婷婷自然，按偏好从上往下挑。
const NATURAL_VOICES = [/^Flo/i, /^Eddy/i, /^Shelley/i, /^Sandy/i, /^Reed/i, /^Rocko/i, /^Grandma/i, /^Grandpa/i, /^Meijia/i, /^Tingting/i];
function pickVoice() {
  const wanted = voices.find(voice => voice.name === settings?.voice?.name);
  if (wanted) return wanted;
  const chinese = voices.filter(voice => /^zh/i.test(voice.lang));
  for (const pattern of NATURAL_VOICES) {
    const hit = chinese.find(voice => pattern.test(voice.name));
    if (hit) return hit;
  }
  return chinese[0] || voices[0];
}

function prosodyFor(text) {
  const sentence = String(text ?? '').trim();
  let pitch = 1;
  let rate = 1;
  if (/[?？]\s*$/.test(sentence)) { pitch += 0.12; rate *= 0.98; }
  else if (/[!！]\s*$/.test(sentence)) { pitch += 0.16; rate *= 1.05; }
  else if (/[~～]\s*$/.test(sentence)) { pitch += 0.08; rate *= 1.02; }
  if (/[哈嘿呜哎呀诶嘛呢啦]/u.test(sentence)) pitch += 0.04;
  if (sentence.length > 40) rate *= 0.97;
  return { pitch, rate };
}

function cleanReply(text) {
  return String(text ?? '')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^(大肥鱼|小肥鱼)[：:]\s*/, '')
    .trim();
}

function speak(text, prosody = {}) {
  if (!speech || !settings?.voice?.enabled) return;
  const plain = cleanReply(text).slice(0, 300);
  if (!plain) return;
  try {
    const utterance = new SpeechSynthesisUtterance(plain);
    utterance.lang = 'zh-CN';
    utterance.rate = Math.min(2, Math.max(0.5, (settings.voice.rate ?? 1) * (prosody.rate ?? 1)));
    utterance.pitch = Math.min(2, Math.max(0.5, prosody.pitch ?? 1));
    utterance.volume = settings.voice.volume ?? 0.9;
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    window.petDiagnostics.lastVoice = voice?.name ?? null;
    speech.speak(utterance);
  } catch { /* 语音失败不影响界面 */ }
}

let lastRequestCount = 0;
let lastAnnounceAt = 0;
function announceActivity(requests) {
  if (!settings?.voice?.enabled) { lastRequestCount = requests; return; }
  if (requests > 0 && lastRequestCount === 0 && settings.voice.announceStart !== false
      && Date.now() - lastAnnounceAt > 30000) {
    lastAnnounceAt = Date.now();
    speak(requests === 1 ? '有 1 个请求进行中' : `有 ${requests} 个请求进行中`);
  } else if (requests === 0 && lastRequestCount > 0 && settings.voice.announceEnd) {
    speak('请求都结束了');
  }
  lastRequestCount = requests;
}

function describe() {
  lights.dataset.visible = String(settings?.showBulbs !== false);
  renderQuota();
  const requests = activity.available && Number.isInteger(activity.activeCount) ? Math.max(0, activity.activeCount) : 0;
  announceActivity(requests);
  const description = activity.available ? requests ? `Magpie：${requests} 个进行中的请求（含排队）` : activity.label : 'Magpie 未连接，状态未知';
  lights.title = description;
  lights.setAttribute('aria-label', description);
  lights.classList.toggle('unavailable', !activity.available);
  if (lights.dataset.count !== String(requests)) {
    lights.replaceChildren();
    for (let index = 0; index < Math.min(8, Math.max(1, requests)); index++) {
      const bulb = document.querySelector('#bulb-template').content.firstElementChild.cloneNode(true);
      bulb.classList.toggle('lit', requests > 0);
      lights.append(bulb);
    }
    if (requests > 0) {
      const label = document.createElement('span');
      label.className = 'bulb-count';
      label.textContent = `${requests} 个请求`;
      lights.prepend(label);
    }
    if (requests > 8) {
      const more = document.createElement('span');
      more.className = 'bulb-more';
      more.textContent = `+${requests - 8}`;
      lights.append(more);
    }
    lights.dataset.count = String(requests);
  }
  const label = settings.paused ? '继续动画' : '暂停动画';
  const button = document.querySelector('#pause');
  button.title = label;
  button.setAttribute('aria-label', label);
  button.setAttribute('aria-pressed', String(settings.paused));
  document.querySelector('#pause-icon').toggleAttribute('hidden', settings.paused);
  document.querySelector('#play-icon').toggleAttribute('hidden', !settings.paused);
}

function renderQuota() {
  const container = document.querySelector('#account-quotas');
  if (settings?.showQuotas === false) { container.hidden = true; return; }
  container.hidden = false;
  const scrollOffset = container.scrollLeft;
  container.replaceChildren();
  for (const account of quotaEntries(quota, activity).filter(account => settings.hiddenQuotas?.[account.key] !== true)) {
    const badge = document.createElement('span');
    badge.className = 'account-quota';
    badge.classList.toggle('active', account.active);
    badge.classList.toggle('unavailable', !account.available);
    const source = providerIconSource(account.icon);
    if (source) {
      const logo = document.createElement('img');
      logo.className = 'account-logo';
      logo.src = source;
      logo.alt = '';
      badge.append(logo);
    } else {
      const logo = document.createElement('span');
      logo.className = 'account-logo fallback';
      logo.textContent = providerInitial(account);
      badge.append(logo);
    }
    const value = document.createElement('span');
    value.className = 'account-value';
    value.textContent = account.kind === 'balance' && !account.available ? '?' : account.text;
    badge.append(value);
    badge.title = `${account.label} · ${account.active ? '正在使用' : '当前未确认有请求使用'} · ${account.available ? '剩余 ' + account.text + (account.kind === 'balance' ? '（Magpie 缓存余额）' : '') : account.kind === 'balance' ? '余额待刷新' : '额度待刷新'}`;
    badge.setAttribute('aria-label', badge.title);
    container.append(badge);
  }
  container.scrollLeft = scrollOffset;
}

async function play(name) {
  if (!name) return;
  const request = ++generation;
  clearTimeout(animationTimer);
  const previous = videos[visible];
  const nextIndex = 1 - visible;
  const next = videos[nextIndex];
  next.pause();
  next.onended = null;
  next.src = new URL(`../assets/webm/${encodeURIComponent(name)}.webm`, import.meta.url).href;
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      next.onloadeddata = resolve;
      next.onerror = () => reject(new Error(`无法播放：${name}`));
      timeout = setTimeout(() => reject(new Error(`动画加载超时：${name}`)), 10000);
      next.load();
    });
    clearTimeout(timeout);
    if (request !== generation) return;
    await next.play();
    if (request !== generation) { next.pause(); return; }
    next.style.opacity = '1';
    previous.style.opacity = '0';
    previous.pause();
    visible = nextIndex;
    if (settings.paused) next.pause();
    next.onended = () => { if (request === generation && !dragging) play(director.next()); };
    failureCount = 0;
    window.petDiagnostics.loaded = true;
    window.petDiagnostics.played.push(name);
    window.petDiagnostics.played = window.petDiagnostics.played.slice(-20);
    window.petDiagnostics.video = { width: next.videoWidth, height: next.videoHeight, duration: next.duration };
  } catch (error) {
    clearTimeout(timeout);
    if (request !== generation) return;
    window.petDiagnostics.errors.push(error.message);
    document.querySelector('#next-action').title = '动画暂不可用，点击换一个动作';
    if (++failureCount < 3) animationTimer = setTimeout(() => play(director.select(director.catalog.idle[0])), 1000);
  }
}

function applySettings(value) {
  const wasPaused = settings?.paused;
  settings = value;
  director.paused = value.paused;
  director.active = value.active;
  director.activity = value.followTasks ? activity : { state: 'idle' };
  if (value.paused) videos[visible].pause();
  else if (wasPaused) {
    if (videos[visible].ended) play(director.next());
    else videos[visible].play().catch(() => {});
  }
  describe();
}

api.on('activity', value => {
  activity = value;
  if (!director) return;
  if (settings.followTasks) play(director.update(value));
  describe();
});
api.on('settings', value => { if (director) applySettings(value); });
api.on('quota', value => { quota = value; renderQuota(); });
api.on('play', name => {
  if (!director) return;
  if (settings.paused) api.setting('paused', false);
  play(director.select(name, true));
});
api.on('cursor', point => {
  if (!director) return;
  let interactive = dragging;
  if (!interactive) {
    interactive = [...document.querySelectorAll('.interactive')].some(element => {
      const bounds = element.getBoundingClientRect();
      return point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom;
    });
  }
  const bounds = stage.getBoundingClientRect();
  if (!interactive && point.x >= bounds.left && point.x < bounds.right && point.y >= bounds.top && point.y < bounds.bottom && videos[visible].readyState >= 2) {
    try {
      hitContext.clearRect(0, 0, 256, 144);
      hitContext.drawImage(videos[visible], 0, 0, 256, 144);
      const pixel = hitContext.getImageData(Math.floor((point.x - bounds.left) / bounds.width * 256), Math.floor((point.y - bounds.top) / bounds.height * 144), 1, 1).data;
      interactive = pixel[3] > 20;
    } catch { interactive = true; }
  }
  if (interactive !== lastInteractive) { api.interactive(interactive); lastInteractive = interactive; }
});

stage.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  speech?.cancel();
  pointerStart = { x: event.screenX, y: event.screenY };
  stage.setPointerCapture(event.pointerId);
});
stage.addEventListener('pointermove', event => {
  if (!pointerStart || settings.locked || dragging) return;
  if (Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y) > 5) {
    dragging = true;
    api.drag('start');
    play(director.select('被鼠标拖拽悬空反馈', true));
  }
});
stage.addEventListener('pointerup', () => {
  if (!pointerStart) return;
  if (dragging) { api.drag('end'); dragging = false; play(director.next()); }
  else {
    const options = director.catalog.clicks.filter(name => name !== director.current);
    play(director.select(options[Math.floor(Math.random() * options.length)], true));
  }
  pointerStart = null;
});
stage.addEventListener('lostpointercapture', () => {
  if (dragging) { api.drag('end'); dragging = false; }
  pointerStart = null;
});
document.addEventListener('contextmenu', event => { event.preventDefault(); api.menu(); });
document.querySelector('#next-action').onclick = () => play(director.select(director.program(), true, true));
document.querySelector('#pause').onclick = () => api.setting('paused', !settings.paused);
document.querySelector('#menu').onclick = () => api.menu();

// ── B：文本对话 + 朗读（流式，逐句开口）────────────────────────────────────
const bubble = document.querySelector('#bubble');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
let bubbleTimer;
let streamed = '';
let spokenUpTo = 0;
let fillerTimer;

function showBubble(text, ms = 12000) {
  bubble.textContent = String(text ?? '');
  bubble.hidden = false;
  clearTimeout(bubbleTimer);
  if (ms) bubbleTimer = setTimeout(() => { bubble.hidden = true; }, ms);
}

function toggleChat(open) {
  const next = open ?? chatForm.hidden;
  chatForm.hidden = !next;
  if (next) chatInput.focus();
}

function resetStream() { streamed = ''; spokenUpTo = 0; }

function drainSpeech(final) {
  const rest = streamed.slice(spokenUpTo);
  if (!rest) return;
  if (final) { spokenUpTo = streamed.length; speak(rest, prosodyFor(rest)); return; }
  const match = rest.match(/^([\s\S]*[。！？!?～\n])/);
  if (!match) return;
  spokenUpTo += match[1].length;
  speak(match[1], prosodyFor(match[1]));
}

api.on('chat-chunk', delta => {
  clearTimeout(fillerTimer);
  streamed += delta;
  showBubble(cleanReply(streamed) || '…', 0);
  drainSpeech(false);
});
api.on('chat-done', result => {
  clearTimeout(fillerTimer);
  if (result?.ok) {
    if (result.text) streamed = result.text;
    showBubble(cleanReply(streamed), 15000);
    if (settings.voice?.readReplies) drainSpeech(true);
  } else {
    showBubble(`没接上：${result?.error || '未知错误'}`);
  }
});
chatForm.addEventListener('submit', async event => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  chatForm.hidden = true;
  speech?.cancel();
  resetStream();
  showBubble('…她在想。', 0);
  if (settings.voice?.enabled) {
    fillerTimer = setTimeout(() => {
      if (!streamed) { showBubble('嗯……', 0); speak('嗯……'); }
    }, 1200);
  }
  try { await api.chat(text); } catch (error) { showBubble(`没接上：${String(error?.message ?? error).slice(0, 80)}`); }
});
document.querySelector('#chat').onclick = () => toggleChat();
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!chatForm.hidden) toggleChat(false);
  else speech?.cancel();
});
api.on('chat:open', () => toggleChat(true));

const dock = document.querySelector('#dock');
new ResizeObserver(() => api.resize(dock.offsetTop + dock.offsetHeight + 8)).observe(dock);
const initial = await api.getSnapshot();
settings = initial.settings;
activity = initial.activity;
quota = initial.quota;
director = new AnimationDirector(initial.catalog);
applySettings(settings);
await play(director.next());
setInterval(() => {
renderQuota();
if (videos[visible].readyState >= 2) {
  hitContext.clearRect(0, 0, 256, 144);
  hitContext.drawImage(videos[visible], 0, 0, 256, 144);
  const pixels = hitContext.getImageData(0, 0, 256, 144).data;
  let clear = 0;
  let opaque = 0;
  for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] < 16) clear++; if (pixels[index] > 200) opaque++; }
  window.petDiagnostics.transparent = clear > 5000 && opaque > 100;
  window.petDiagnostics.alpha = { clear, opaque };
}
}, 2000);
