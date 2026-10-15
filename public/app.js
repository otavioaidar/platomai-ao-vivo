/*
 * PlatomAI Ao Vivo — front-end estático (ES module, sem dependências).
 *
 * Seções:
 *   1. Configuração
 *   2. Utilitários (DOM seguro, armazenamento, datas no fuso de Brasília)
 *   3. Estado + normalização dos dados da API
 *   4. Fita de manchetes (renderização com reaproveitamento de nós)
 *   5. Alertas (som WebAudio, notificações, aria-live, contador no título)
 *   6. Sincronização (GET /api/headlines) e tempo real (SSE /api/stream)
 *   7. Coluna lateral (agenda e fontes)
 *   8. Controles, relógio e inicialização
 *
 * Nenhum texto vindo da API passa por innerHTML: tudo vira nó de texto.
 */

// ---------------------------------------------------------------------------
// 1. Configuração
// ---------------------------------------------------------------------------

const TZ = 'America/Sao_Paulo';
const BASE_TITLE = 'PlatomAI Ao Vivo';

const API = {
  headlines: '/api/headlines?limit=150',
  stream: '/api/stream',
  agenda: '/api/agenda',
  status: '/api/status',
};

const MAX_ITEMS = 600;                 // teto de manchetes mantidas em memória
const AGENDA_EVERY = 5 * 60_000;       // recarrega a agenda
const STATUS_EVERY = 60_000;           // recarrega o status das fontes
const RELATIVE_EVERY = 30_000;         // atualiza "há 2 min", "em 1h05"
const POLL_WHILE_DOWN = 30_000;        // sem SSE, consulta a lista neste ritmo
const STREAM_SILENCE_LIMIT = 75_000;   // sem nenhum evento (nem ping) → reconecta
const REPLAY_ALERT_WINDOW = 10 * 60_000; // itens recuperados após queda: só alerta se recentes

const KEYS = {
  filter: 'platomai-ao-vivo:filtro',
  notify: 'platomai-ao-vivo:notificacoes',
};

const FILTERS = {
  tudo: () => true,
  brasil: (it) => it.region === 'BR',
  mundo: (it) => it.region === 'INTL',
  urgentes: (it) => it.urgency === 'urgente' || it.urgency === 'alta',
};

const CONN_TEXT = {
  connecting: 'Conectando…',
  live: 'Ao vivo',
  reconnecting: 'Reconectando…',
  offline: 'Offline',
};

// ---------------------------------------------------------------------------
// 2. Utilitários
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);

/** Cria um elemento. Filhos string viram nós de texto (nunca HTML). */
function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

/** localStorage pode não existir ou lançar exceção (modo privado, bloqueio). */
const store = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, value); } catch { /* sem armazenamento: segue sem lembrar */ }
  },
};

const str = (v) => (typeof v === 'string' ? v : '');

/** Minúsculas e sem acento, para a busca aceitar "inflacao" e "inflação". */
const fold = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function safeUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

async function getJSON(url, timeoutMs = 15_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Datas: tudo exibido no horário de Brasília, independentemente do fuso do aparelho.
const fmt = {
  hms: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
  hm: new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  ymd: new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }),
  weekday: new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', weekday: 'short' }),
};

/** Chave do dia (AAAA-MM-DD) no fuso de Brasília. */
function dayKey(ts) {
  const p = {};
  for (const { type, value } of fmt.ymd.formatToParts(ts)) p[type] = value;
  return `${p.year}-${p.month}-${p.day}`;
}

function keyToUTC(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Rótulo de dia: Hoje / Ontem / Amanhã / dd/mm (com dia da semana ao lado). */
function dayLabel(key, todayKey) {
  const offset = Math.round((keyToUTC(todayKey) - keyToUTC(key)) / 86_400_000);
  const [, m, d] = key.split('-');
  const ddmm = `${d}/${m}`;
  if (offset === 0) return { main: 'Hoje', sub: ddmm };
  if (offset === 1) return { main: 'Ontem', sub: ddmm };
  if (offset === -1) return { main: 'Amanhã', sub: ddmm };
  return { main: ddmm, sub: fmt.weekday.format(keyToUTC(key)).replace('.', '') };
}

function since(ts, now) {
  const sec = Math.round((now - ts) / 1000);
  if (sec < 45) return 'agora';
  const min = Math.round(sec / 60);
  if (min < 60) return `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'há 1 dia' : `há ${days} dias`;
}

function until(ts, now) {
  const min = Math.round((ts - now) / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `em ${min} min`;
  const hours = Math.floor(min / 60);
  const rest = min % 60;
  if (hours < 24) return rest ? `em ${hours}h${String(rest).padStart(2, '0')}` : `em ${hours}h`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'em 1 dia' : `em ${days} dias`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// 3. Estado e normalização
// ---------------------------------------------------------------------------

const el = {
  conn: $('#conn'),
  connText: $('#conn-text'),
  clock: $('#clock'),
  feed: $('#feed'),
  feedState: $('#feed-state'),
  count: $('#count'),
  chips: [...document.querySelectorAll('[data-filter]')],
  search: $('#q'),
  sound: $('#sound-btn'),
  soundLabel: $('#sound-label'),
  notify: $('#notify-btn'),
  notifyLabel: $('#notify-label'),
  side: $('#side'),
  sideToggle: $('#side-toggle'),
  sideNext: $('#side-next'),
  agenda: $('#agenda'),
  ai: $('#ai-status'),
  sources: $('#fontes'),
  sourcesSub: $('#fontes-sub'),
  announcer: $('#announcer'),
};

const notifSupported = 'Notification' in window;

const state = {
  items: new Map(),    // id → manchete normalizada
  sorted: null,        // cache da lista ordenada (mais nova primeiro)
  filter: 'tudo',
  terms: [],           // termos da busca, já sem acento
  loaded: false,       // primeira carga de /api/headlines concluída
  loadFailed: false,
  sound: false,        // sempre começa desligado (política de autoplay)
  notify: false,
  unread: 0,
  agenda: null,
  agendaFailed: false,
  status: null,
  statusFailed: false,
};

function normalizeHeadline(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = raw.id == null ? '' : String(raw.id);
  const ts = Date.parse(raw.publishedAt);
  const headline = str(raw.headline).trim();
  if (!id || !Number.isFinite(ts) || !headline) return null;

  const item = {
    raw,
    id,
    ts,
    sortTs: ts,
    day: dayKey(ts),
    tag: str(raw.tag).trim() || str(raw.sourceName).trim() || 'Fonte',
    sourceName: str(raw.sourceName).trim(),
    region: str(raw.region),
    urgency: raw.urgency === 'urgente' || raw.urgency === 'alta' ? raw.urgency : 'normal',
    headline,
    explainer: str(raw.explainer).trim() || null,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === 'string') : [],
    url: safeUrl(raw.url),
    method: str(raw.method),
    status: str(raw.status),
    backfill: raw.backfill === true,
    sig: JSON.stringify(raw),
  };
  item.haystack = fold([item.headline, item.explainer, item.tag, item.sourceName, ...item.topics].join(' \u0000 '));
  return item;
}

function normalizeAgenda(raw) {
  const ts = Date.parse(raw?.when);
  if (!Number.isFinite(ts)) return null;
  return {
    ts,
    day: dayKey(ts),
    title: str(raw.title).trim() || 'Divulgação',
    source: str(raw.source).trim(),
    done: raw.done === true,
  };
}

function normalizeStatus(raw) {
  const sources = Array.isArray(raw?.sources) ? raw.sources : [];
  return {
    ai: { enabled: raw?.ai?.enabled === true, model: str(raw?.ai?.model) },
    sources: sources.map((s) => {
      const okTs = Date.parse(s?.lastOkAt);
      return {
        name: str(s?.name).trim() || str(s?.id).trim() || 'Fonte',
        okTs: Number.isFinite(okTs) ? okTs : null,
        error: str(s?.lastError).trim() || null,
      };
    }),
  };
}

function sortedItems() {
  if (!state.sorted) {
    state.sorted = [...state.items.values()].sort(
      (a, b) => b.sortTs - a.sortTs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  }
  return state.sorted;
}

function putItem(item) {
  state.items.set(item.id, item);
  state.sorted = null;
}

function trimItems() {
  if (state.items.size <= MAX_ITEMS) return;
  for (const old of sortedItems().slice(MAX_ITEMS)) state.items.delete(old.id);
  state.sorted = null;
}

const passesFilter = (it) => FILTERS[state.filter](it);
const passesSearch = (it) => state.terms.every((t) => it.haystack.includes(t));

// ---------------------------------------------------------------------------
// 4. Fita de manchetes
// ---------------------------------------------------------------------------

const rowCache = new Map();   // id → { item, node }
const dayCache = new Map();   // AAAA-MM-DD → { node, main, sub, list }
const fresh = new Set();          // ids que acabaram de chegar (destaque)
const freshExplainer = new Set(); // ids cujo "PlatomAI explica" acabou de chegar
let lastStateSig = '';
let renderQueued = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  // Em aba oculta o rAF pausa: a fita é montada quando o leitor volta.
  requestAnimationFrame(() => {
    renderQueued = false;
    renderFeed();
  });
}

function buildRow(item) {
  const node = h('li', { class: `row u-${item.urgency}`, 'data-id': item.id });

  const regionName = item.region === 'INTL' ? 'Internacional' : item.region === 'BR' ? 'Brasil' : '';
  const tagTitle = [item.sourceName, regionName].filter(Boolean).join(' · ');

  const text = h('p', { class: 't-text' });
  if (item.urgency === 'urgente') text.append(h('span', { class: 'flag flag-urgente' }, 'URGENTE'), ' ');
  else if (item.urgency === 'alta') text.append(h('span', { class: 'flag flag-alta' }, 'ALTA'), ' ');
  text.append(h('span', { class: 't-head' }, item.headline));
  if (item.status === 'revisar') text.append(' ', h('span', { class: 'badge' }, 'em revisão'));
  if (item.method === 'rascunho') text.append(' ', h('span', { class: 'badge' }, 'rascunho (IA desligada)'));

  node.append(
    h('time', { class: 't-time', datetime: new Date(item.ts).toISOString() }, fmt.hms.format(item.ts)),
    h('span', { class: `t-tag${item.region === 'INTL' ? ' r-intl' : ''}`, title: tagTitle || null }, item.tag),
    text,
  );

  if (item.url) {
    const label = item.sourceName ? `Fonte: ${item.sourceName} (abre em nova aba)` : 'Fonte (abre em nova aba)';
    node.append(
      h('a', { class: 't-src', href: item.url, target: '_blank', rel: 'noopener', 'aria-label': label },
        'fonte', h('span', { 'aria-hidden': 'true' }, ' ↗')),
    );
  }

  if (item.explainer) {
    node.append(
      h('p', { class: `t-expl${freshExplainer.has(item.id) ? ' is-fresh' : ''}` },
        h('span', { class: 't-expl-lbl' }, 'PlatomAI explica:'), ' ', item.explainer),
    );
  }

  if (fresh.has(item.id)) {
    node.classList.add('is-new');
    const done = () => node.classList.remove('is-new');
    node.addEventListener('animationend', (ev) => { if (ev.animationName === 'flash') done(); });
    setTimeout(done, 6000); // garante a limpeza com animações desligadas
  }
  return node;
}

function rowFor(item) {
  const cached = rowCache.get(item.id);
  if (cached && cached.item === item) return cached.node;
  const node = buildRow(item);
  rowCache.set(item.id, { item, node });
  return node;
}

function dayFor(key) {
  let day = dayCache.get(key);
  if (!day) {
    const main = h('span', { class: 'day-main' });
    const sub = h('span', { class: 'day-sub' });
    const id = `dia-${key}`;
    const list = h('ol', { class: 'rows', 'aria-labelledby': id });
    day = { node: h('section', { class: 'day' }, h('h2', { class: 'day-head', id }, main, ' ', sub), list), main, sub, list };
    dayCache.set(key, day);
  }
  return day;
}

/** Deixa os filhos de `parent` iguais a `wanted`, mexendo no mínimo de nós. */
function reconcile(parent, wanted) {
  const keep = new Set(wanted);
  for (const child of [...parent.children]) if (!keep.has(child)) child.remove();
  let cursor = parent.firstElementChild;
  for (const node of wanted) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function renderFeed() {
  const all = sortedItems();
  const visible = all.filter((it) => passesFilter(it) && passesSearch(it));
  const todayKey = dayKey(Date.now());

  const groups = new Map();
  for (const it of visible) {
    let list = groups.get(it.day);
    if (!list) groups.set(it.day, (list = []));
    list.push(it);
  }

  const focusedId = document.activeElement?.closest?.('.row')?.dataset.id;

  const sections = [];
  for (const [key, items] of groups) {
    const day = dayFor(key);
    const label = dayLabel(key, todayKey);
    setText(day.main, label.main);
    setText(day.sub, label.sub);
    reconcile(day.list, items.map(rowFor));
    sections.push(day.node);
  }
  reconcile(el.feed, sections);

  for (const key of dayCache.keys()) if (!groups.has(key)) dayCache.delete(key);
  for (const id of rowCache.keys()) if (!state.items.has(id)) rowCache.delete(id);
  fresh.clear();
  freshExplainer.clear();

  // Se uma atualização trocou a linha que tinha o foco, devolve o foco ao link novo.
  if (focusedId && !el.feed.contains(document.activeElement)) {
    rowCache.get(focusedId)?.node.querySelector('.t-src')?.focus({ preventScroll: true });
  }

  el.feed.setAttribute('aria-busy', String(!state.loaded && !state.loadFailed));
  el.count.textContent = all.length === 0 ? ''
    : visible.length === all.length ? plural(all.length, 'manchete', 'manchetes')
      : `${visible.length} de ${all.length}`;
  renderFeedState(visible.length, all.length);
}

function renderFeedState(shown, total) {
  let kind = '';
  if (total === 0) kind = state.loaded ? 'empty' : state.loadFailed ? 'error' : 'loading';
  else if (shown === 0) kind = 'nomatch';

  el.feed.hidden = shown === 0;
  const sig = `${kind}|${kind === 'nomatch' ? `${state.filter}|${el.search.value.trim()}` : ''}`;
  if (sig === lastStateSig) return;
  lastStateSig = sig;

  const box = el.feedState;
  box.hidden = !kind;
  box.dataset.kind = kind;
  if (!kind) { box.replaceChildren(); return; }

  const title = (text) => h('p', { class: 'fs-title' }, text);
  const button = (text, onClick) => {
    const b = h('button', { type: 'button', class: 'fs-btn' }, text);
    b.addEventListener('click', onClick);
    return b;
  };

  if (kind === 'loading') {
    box.replaceChildren(title('Carregando manchetes'));
  } else if (kind === 'error') {
    box.replaceChildren(
      title('Não foi possível carregar as manchetes'),
      h('p', null, 'Verifique sua conexão. Vamos tentar de novo automaticamente.'),
      button('Tentar agora', () => syncHeadlines()),
    );
  } else if (kind === 'empty') {
    box.replaceChildren(
      title('Nenhuma manchete por enquanto'),
      h('p', null, 'Assim que uma fonte oficial publicar, a manchete aparece aqui sozinha.'),
    );
  } else {
    const query = el.search.value.trim();
    box.replaceChildren(
      title(query ? `Nada encontrado para “${query}”` : 'Nenhuma manchete neste filtro'),
      h('p', null, 'Novas manchetes que combinarem com o filtro aparecem aqui sozinhas.'),
      button('Limpar busca e filtros', () => {
        el.search.value = '';
        state.terms = [];
        setFilter('tudo');
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 5. Alertas
// ---------------------------------------------------------------------------

const audio = { ctx: null, lastAt: 0, lastRank: 0 };

function audioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!audio.ctx) {
    try { audio.ctx = new Ctor(); } catch { return null; }
  }
  if (audio.ctx.state === 'suspended') audio.ctx.resume().catch(() => {});
  return audio.ctx;
}

function tone(ctx, at, freq, dur = 0.14, peak = 0.22) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

/** Urgente: dois bipes. Alta: um bipe. Rajadas viram um único aviso. */
function beep(urgency) {
  const rank = urgency === 'urgente' ? 2 : urgency === 'alta' ? 1 : 0;
  if (!rank || !state.sound) return;
  const now = performance.now();
  if (now - audio.lastAt < 1500 && rank <= audio.lastRank) return;
  const ctx = audioContext();
  if (!ctx) return;
  audio.lastAt = now;
  audio.lastRank = rank;
  const t = ctx.currentTime + 0.03;
  if (rank === 2) {
    tone(ctx, t, 988);
    tone(ctx, t + 0.21, 988);
  } else {
    tone(ctx, t, 740);
  }
}

let announceTimer = 0;
function announce(text) {
  clearTimeout(announceTimer);
  el.announcer.textContent = '';
  announceTimer = setTimeout(() => { el.announcer.textContent = text; }, 150);
}

function notifyUrgent(item) {
  if (!state.notify || !notifSupported || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && document.hasFocus()) return; // já está vendo a fita
  try {
    const n = new Notification(`URGENTE · ${item.tag}`, { body: item.headline, tag: `platomai-${item.id}`, lang: 'pt-BR' });
    n.addEventListener('click', () => { window.focus(); n.close(); });
  } catch {
    /* alguns navegadores móveis só notificam via service worker */
  }
}

function updateTitle() {
  document.title = state.unread > 0 ? `(${state.unread}) ${BASE_TITLE}` : BASE_TITLE;
}

function resetUnread() {
  if (!state.unread) return;
  state.unread = 0;
  updateTitle();
}

/** Uma manchete realmente nova chegou (ao vivo ou recuperada após queda). */
function onArrival(item, { replay = false } = {}) {
  if (item.backfill) return;
  fresh.add(item.id);
  if (replay && Date.now() - item.ts > REPLAY_ALERT_WINDOW) return;
  if (!passesFilter(item)) return; // alertas seguem o filtro escolhido (a busca não conta)

  if (document.visibilityState === 'hidden') {
    state.unread += 1;
    updateTitle();
  }
  if (item.urgency === 'urgente') {
    announce(`Urgente: ${item.headline}`);
    notifyUrgent(item);
  }
  beep(item.urgency);
}

// ---------------------------------------------------------------------------
// 6. Sincronização e tempo real
// ---------------------------------------------------------------------------

/** Junta uma lista completa (snapshot) ao que já temos, por id. */
function mergeSnapshot(list, { replay }) {
  for (const raw of list) {
    const item = normalizeHeadline(raw);
    if (!item) continue;
    const prev = state.items.get(item.id);
    if (prev) {
      if (prev.sig !== item.sig) replaceItem(prev, item);
      continue;
    }
    putItem(item);
    if (replay) onArrival(item, { replay: true });
  }
  trimItems();
}

/** Troca uma manchete existente mantendo sua posição na fita. */
function replaceItem(prev, item) {
  item.sortTs = prev.sortTs;
  item.day = prev.day;
  if (!prev.explainer && item.explainer) freshExplainer.add(item.id);
  putItem(item);
}

function ingestHeadline(raw) {
  const item = normalizeHeadline(raw);
  if (!item) return;
  const prev = state.items.get(item.id);
  if (prev) {
    if (prev.sig !== item.sig) replaceItem(prev, item);
  } else {
    putItem(item);
    onArrival(item);
    trimItems();
  }
  scheduleRender();
}

function ingestUpdate(raw) {
  if (!raw || raw.id == null) return;
  const prev = state.items.get(String(raw.id));
  // O evento pode trazer o objeto inteiro ou só os campos alterados.
  const item = normalizeHeadline(prev ? { ...prev.raw, ...raw } : raw);
  if (!item) return;
  if (!prev) putItem(item); // atualização de algo que ainda não tínhamos: entra sem alerta
  else if (prev.sig !== item.sig) replaceItem(prev, item);
  else return;
  scheduleRender();
}

let syncPromise = null;
let syncAgain = false;
let loadRetryTimer = 0;
let loadRetries = 0;

/** GET /api/headlines + merge. Chamadas simultâneas viram no máximo mais uma. */
function syncHeadlines() {
  if (syncPromise) {
    syncAgain = true;
    return syncPromise;
  }
  clearTimeout(loadRetryTimer);
  syncPromise = (async () => {
    do {
      syncAgain = false;
      try {
        const data = await getJSON(API.headlines);
        mergeSnapshot(Array.isArray(data?.items) ? data.items : [], { replay: state.loaded });
        state.loaded = true;
        state.loadFailed = false;
        loadRetries = 0;
      } catch {
        state.loadFailed = true;
        if (!state.loaded) {
          loadRetries += 1;
          loadRetryTimer = setTimeout(syncHeadlines, Math.min(60_000, 5_000 * loadRetries));
        }
      }
      scheduleRender();
    } while (syncAgain);
  })().finally(() => {
    syncPromise = null;
    if (syncAgain) syncHeadlines();
  });
  return syncPromise;
}

const live = { es: null, everOpen: false, failures: 0, retryTimer: 0, silenceTimer: 0, pollTimer: 0 };

function setConn(mode) {
  if (el.conn.dataset.state === mode) return;
  el.conn.dataset.state = mode;
  el.connText.textContent = CONN_TEXT[mode];
}

function armSilenceWatch() {
  clearTimeout(live.silenceTimer);
  live.silenceTimer = setTimeout(() => {
    live.failures += 1;
    connect();
  }, STREAM_SILENCE_LIMIT);
}

function startPolling() {
  if (!live.pollTimer) live.pollTimer = setInterval(syncHeadlines, POLL_WHILE_DOWN);
}

function stopPolling() {
  clearInterval(live.pollTimer);
  live.pollTimer = 0;
}

function scheduleReconnect() {
  clearTimeout(live.retryTimer);
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(live.failures, 5)) + Math.random() * 500;
  live.retryTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(live.retryTimer);
  clearTimeout(live.silenceTimer);
  live.es?.close();
  if (navigator.onLine === false || live.failures >= 3) setConn('offline');
  else setConn(live.everOpen || live.failures ? 'reconnecting' : 'connecting');

  let es;
  try {
    es = new EventSource(API.stream);
  } catch {
    live.failures += 1;
    scheduleReconnect();
    return;
  }
  live.es = es;
  const current = (fn) => (ev) => { if (es === live.es) fn(ev); };

  es.addEventListener('open', current(() => {
    live.everOpen = true;
    live.failures = 0;
    setConn('live');
    stopPolling();
    armSilenceWatch();
    syncHeadlines(); // cobre o que saiu enquanto estávamos fora (merge por id)
  }));

  es.addEventListener('headline', current((ev) => {
    armSilenceWatch();
    const data = parseJSON(ev.data);
    if (data) ingestHeadline(data);
  }));

  es.addEventListener('update', current((ev) => {
    armSilenceWatch();
    const data = parseJSON(ev.data);
    if (data) ingestUpdate(data);
  }));

  es.addEventListener('ping', current(armSilenceWatch));
  es.addEventListener('message', current(armSilenceWatch));

  es.addEventListener('error', current(() => {
    clearTimeout(live.silenceTimer);
    live.failures += 1;
    // CONNECTING: o navegador tenta sozinho. CLOSED: precisamos reabrir.
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
    setConn(navigator.onLine === false || live.failures >= 3 ? 'offline' : 'reconnecting');
    startPolling();
  }));
}

// ---------------------------------------------------------------------------
// 7. Coluna lateral
// ---------------------------------------------------------------------------

async function loadAgenda() {
  try {
    const data = await getJSON(API.agenda);
    state.agenda = (Array.isArray(data?.items) ? data.items : [])
      .map(normalizeAgenda)
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
    state.agendaFailed = false;
  } catch {
    state.agendaFailed = true;
  }
  renderAgenda();
}

async function loadStatus() {
  try {
    state.status = normalizeStatus(await getJSON(API.status));
    state.statusFailed = false;
  } catch {
    state.statusFailed = true;
  }
  renderStatus();
}

const sideMsg = (text, bad = false) => h('p', { class: `side-msg${bad ? ' is-bad' : ''}` }, text);

function renderAgenda() {
  const now = Date.now();
  const todayKey = dayKey(now);
  const parts = [];
  const events = state.agenda;
  const next = events?.find((ev) => !ev.done && ev.ts >= now) ?? null;

  if (!events) {
    parts.push(state.agendaFailed
      ? sideMsg('Não foi possível carregar a agenda. Tentaremos de novo em instantes.', true)
      : sideMsg('Carregando agenda…'));
  } else if (!events.length) {
    parts.push(sideMsg('Nenhuma divulgação prevista.'));
  } else {
    if (state.agendaFailed) parts.push(sideMsg('Falha ao atualizar. Mostrando a última versão.', true));
    let currentDay = null;
    let list = null;
    for (const ev of events) {
      if (ev.day !== currentDay) {
        currentDay = ev.day;
        const label = dayLabel(ev.day, todayKey);
        list = h('ul', { class: 'ag-list' });
        parts.push(h('h3', { class: 'ag-day' }, label.main, ' ', h('span', { class: 'ag-day-sub' }, label.sub)), list);
      }
      const past = ev.done || ev.ts < now;
      list.append(
        h('li', { class: `ag-item${past ? ' is-past' : ''}${ev === next ? ' is-next' : ''}` },
          h('time', { class: 'ag-time', datetime: new Date(ev.ts).toISOString() }, fmt.hm.format(ev.ts)),
          h('div', null,
            h('p', { class: 'ag-line' },
              ev.source ? h('span', { class: 'ag-src' }, ev.source) : null,
              h('span', { class: 'ag-title' }, ev.title),
              ev.done ? h('span', { class: 'ag-done' }, h('span', { 'aria-hidden': 'true' }, ' ✓'), h('span', { class: 'sr-only' }, ' (divulgado)')) : null),
            ev === next ? h('p', { class: 'ag-eta' }, until(ev.ts, now)) : null)),
      );
    }
  }
  el.agenda.replaceChildren(...parts);

  // Resumo no botão recolhível (telas estreitas).
  if (next) el.sideNext.textContent = `Próximo: ${fmt.hm.format(next.ts)} · ${next.title}`;
  else if (events) el.sideNext.textContent = 'Sem divulgações pendentes';
  else el.sideNext.textContent = state.agendaFailed ? 'Agenda indisponível' : 'Carregando agenda…';
}

function renderStatus() {
  const status = state.status;
  const now = Date.now();

  if (!status) {
    el.ai.className = 'ai-line';
    el.ai.textContent = state.statusFailed ? 'Status indisponível no momento.' : 'Carregando status…';
    el.sources.replaceChildren();
    el.sourcesSub.textContent = '';
    return;
  }

  const on = status.ai.enabled;
  el.ai.className = `ai-line${on ? '' : ' is-off'}`;
  el.ai.replaceChildren(
    h('span', { class: `ai-dot${on ? '' : ' off'}`, 'aria-hidden': 'true' }),
    h('span', null, on ? 'IA ligada' : 'IA desligada: manchetes saem como rascunho'),
    on && status.ai.model ? h('span', { class: 'ai-model' }, status.ai.model) : null,
  );

  el.sources.replaceChildren(...status.sources.map((src) => {
    const kind = src.error ? 'is-err' : src.okTs ? 'is-ok' : 'is-never';
    return h('li', { class: `src-item ${kind}` },
      h('span', { class: 'src-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'src-name', title: src.name }, src.name),
      h('span', { class: 'src-when' },
        h('span', { class: 'sr-only' }, src.okTs ? 'última leitura ' : ''),
        src.okTs ? since(src.okTs, now) : 'sem leitura'),
      src.error ? h('p', { class: 'src-err', title: src.error }, h('span', { class: 'sr-only' }, 'Erro: '), src.error) : null);
  }));

  const failing = status.sources.filter((s) => s.error).length;
  el.sourcesSub.className = `card-sub${failing ? ' is-bad' : ''}`;
  el.sourcesSub.textContent = failing
    ? `${failing} com falha`
    : plural(status.sources.length, 'fonte', 'fontes');
  if (state.statusFailed) el.sourcesSub.textContent += ' · desatualizado';
}

// ---------------------------------------------------------------------------
// 8. Controles, relógio e inicialização
// ---------------------------------------------------------------------------

function setFilter(name) {
  state.filter = FILTERS[name] ? name : 'tudo';
  store.set(KEYS.filter, state.filter);
  for (const chip of el.chips) chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));
  renderFeed();
}

function renderToggles() {
  el.sound.setAttribute('aria-pressed', String(state.sound));
  el.soundLabel.textContent = state.sound ? 'Som: ligado' : 'Som: desligado';
  el.sound.title = 'Bipe para manchetes urgentes (dois) e de alta prioridade (um)';

  if (!notifSupported) {
    el.notify.hidden = true;
    return;
  }
  el.notify.hidden = false;
  const perm = Notification.permission;
  const on = state.notify && perm === 'granted';
  el.notify.setAttribute('aria-pressed', String(on));
  el.notifyLabel.textContent = perm === 'denied' ? 'Notificações bloqueadas'
    : on ? 'Notificações: ligadas' : 'Notificações: desligadas';
  el.notify.title = perm === 'denied'
    ? 'Libere as notificações deste site nas configurações do navegador'
    : 'Aviso do navegador quando sair manchete urgente com a aba em segundo plano';
}

async function toggleNotify() {
  if (!notifSupported) return;
  if (state.notify) {
    state.notify = false;
  } else {
    let perm = Notification.permission;
    if (perm === 'default') {
      try { perm = await Notification.requestPermission(); } catch { perm = Notification.permission; }
    }
    if (perm === 'granted') state.notify = true;
    else if (perm === 'denied') announce('Notificações bloqueadas. Libere nas configurações do navegador.');
  }
  store.set(KEYS.notify, state.notify ? '1' : '0');
  renderToggles();
}

function toggleSound() {
  state.sound = !state.sound;
  if (state.sound) {
    // O clique libera o áudio; um bipe curto confirma que está funcionando.
    const ctx = audioContext();
    if (ctx) tone(ctx, ctx.currentTime + 0.03, 740, 0.09, 0.12);
  }
  renderToggles();
}

let lastClockDay = '';
function tick() {
  const now = Date.now();
  el.clock.textContent = fmt.hms.format(now);
  el.clock.dateTime = new Date(now).toISOString();
  const key = dayKey(now);
  if (key !== lastClockDay) {
    // Virou o dia: "Hoje" passa a ser "Ontem".
    const first = !lastClockDay;
    lastClockDay = key;
    if (!first) { renderFeed(); renderAgenda(); }
  }
}

function init() {
  // Preferências salvas
  const savedFilter = store.get(KEYS.filter);
  if (savedFilter && FILTERS[savedFilter]) state.filter = savedFilter;
  state.notify = store.get(KEYS.notify) === '1' && notifSupported && Notification.permission === 'granted';
  for (const chip of el.chips) chip.setAttribute('aria-pressed', String(chip.dataset.filter === state.filter));

  // Filtros e busca
  for (const chip of el.chips) chip.addEventListener('click', () => setFilter(chip.dataset.filter));
  let searchTimer = 0;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.terms = fold(el.search.value).split(/\s+/).filter(Boolean);
      renderFeed();
    }, 120);
  });

  // Som e notificações
  el.sound.addEventListener('click', toggleSound);
  el.notify.addEventListener('click', toggleNotify);
  renderToggles();

  // Coluna lateral recolhível (telas estreitas)
  el.sideToggle.addEventListener('click', () => {
    const open = el.side.dataset.open !== 'true';
    el.side.dataset.open = String(open);
    el.sideToggle.setAttribute('aria-expanded', String(open));
  });

  // Contador de não lidas no título
  window.addEventListener('focus', resetUnread);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resetUnread();
  });

  // Rede
  window.addEventListener('offline', () => setConn('offline'));
  window.addEventListener('online', () => { live.failures = 0; connect(); });

  // Relógio alinhado ao segundo
  tick();
  setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (Date.now() % 1000));

  renderFeed();
  renderAgenda();
  renderStatus();

  syncHeadlines();
  connect();
  loadAgenda();
  loadStatus();
  setInterval(loadAgenda, AGENDA_EVERY);
  setInterval(loadStatus, STATUS_EVERY);
  setInterval(() => { renderAgenda(); renderStatus(); }, RELATIVE_EVERY);
}

init();
