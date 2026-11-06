// Private review queue: headlines that did not go public (failed checks, AI refusals, internal-only sources).
// The token comes from the URL fragment (#t=…, never sent to the server) or the form, and lives in sessionStorage.

const KEY = 'aovivo-revisao-token';
const REFRESH_MS = 60_000;
const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), token: $('token'), bar: $('bar'), filter: $('filter'), refresh: $('refresh'),
  logout: $('logout'), count: $('count'), msg: $('msg'), list: $('list'),
  decBox: $('dec-box'), decList: $('dec-list'), skipBox: $('skip-box'), skipSum: $('skip-sum'), skipList: $('skip-list'),
};

let items = [];
let decifras = [];
let timer = null;

const store = {
  get() { try { return sessionStorage.getItem(KEY) || ''; } catch { return ''; } },
  set(v) { try { sessionStorage.setItem(KEY, v); } catch { /* private mode: keep it in memory only */ } },
  clear() { try { sessionStorage.removeItem(KEY); } catch { /* ignore */ } },
};
let token = '';

const fmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Element with text children only (never HTML). */
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

function webUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function say(text, error = false) {
  el.msg.textContent = text;
  el.msg.classList.toggle('error', error);
}

const SIGNATURE = 'Platom.AI — Inteligência Financeira em Linguagem Clara';

/** The decifra in the agent's delivery format, to copy into the other apps. */
function asText(d) {
  return [
    d.title, '', d.subtitle, '', d.date, '', 'Resumo', '', d.summary, '', 'PlatomAI decifra', '', (d.analysis || []).join('\n\n'), '',
    'Impacto nos mercados', '', ...(d.impact || []).map((i) => `- ${i.label}: ${i.text}`), '', 'Mensagem-chave', '', d.keyMessage, '', SIGNATURE,
  ].join('\n');
}

function meta(it, kindText, kindClass) {
  const when = Date.parse(it.publishedAt);
  const link = webUrl(it.url);
  return h('div', { class: 'meta' },
    h('time', { class: 'time', datetime: it.publishedAt }, Number.isNaN(when) ? '--' : fmt.format(when)),
    h('span', { class: 'tag' }, String(it.tag || it.sourceName || 'Fonte')),
    h('span', { class: kindClass }, kindText),
    String(it.sourceName || ''),
    ...(link ? [h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'documento ↗')] : []),
  );
}

async function act(it, action, buttons) {
  for (const b of buttons) b.disabled = true;
  say(action === 'aprovar' ? 'Publicando…' : 'Descartando…');
  let res;
  try {
    res = await fetch(`/api/revisao/decifra/${encodeURIComponent(it.id)}/${action}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  } catch {
    for (const b of buttons) b.disabled = false;
    say('Sem conexão com o servidor. Tente de novo.', true);
    return;
  }
  if (res.status === 401) { store.clear(); token = ''; showLogin('Token inválido.'); return; }
  if (!res.ok && res.status !== 409) {
    for (const b of buttons) b.disabled = false;
    say(`Erro ${res.status}.`, true);
    return;
  }
  say(res.status === 409 ? 'Este texto já tinha sido revisado.' : action === 'aprovar' ? 'Publicado no site.' : 'Descartado.');
  decifras = decifras.filter((d) => d.id !== it.id);
  render();
}

function decifraCard(it) {
  const d = it.decifra;
  const sec = (title, ...body) => h('div', { class: 'dec-sec' }, h('h3', {}, title), ...body);
  const approve = h('button', { type: 'button' }, 'Aprovar e publicar');
  const discard = h('button', { type: 'button', class: 'ghost' }, 'Descartar');
  const copy = h('button', { type: 'button', class: 'ghost' }, 'Copiar texto');
  approve.addEventListener('click', () => act(it, 'aprovar', [approve, discard]));
  discard.addEventListener('click', () => act(it, 'descartar', [approve, discard]));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(asText(d));
      say('Texto copiado.');
    } catch {
      say('Não foi possível copiar (o navegador bloqueou).', true);
    }
  });
  const checks = Array.isArray(d.checks) ? d.checks : [];
  return h('li', { class: 'item dec' },
    meta(it, checks.length ? 'decifra com alerta' : 'decifra', checks.length ? 'kind check' : 'kind dec-kind'),
    h('div', { class: 'reason' }, `Manchete publicada: ${String(it.headline || '')}`),
    ...(checks.length ? [h('ul', { class: 'checks' }, ...checks.map((c) => h('li', {}, String(c))))] : []),
    h('article', { class: 'dec-text' },
      h('h2', {}, String(d.title || '')),
      h('p', { class: 'dec-sub' }, String(d.subtitle || '')),
      h('p', { class: 'dec-date' }, String(d.date || '')),
      sec('Resumo', h('p', {}, String(d.summary || ''))),
      sec('PlatomAI decifra', ...(d.analysis || []).map((p) => h('p', {}, String(p)))),
      sec('Impacto nos mercados', h('ul', {}, ...(d.impact || []).map((i) => h('li', {}, h('strong', {}, `${i.label}:`), ` ${i.text}`)))),
      sec('Mensagem-chave', h('p', {}, String(d.keyMessage || ''))),
      h('p', { class: 'dec-sign' }, SIGNATURE),
    ),
    h('div', { class: 'actions' }, approve, discard, copy),
  );
}

function renderDecifras(mode) {
  const waiting = decifras.filter((it) => it.decifra && it.decifra.status === 'revisar');
  const skipped = decifras.filter((it) => it.decifraSkipped);
  el.decBox.hidden = !(mode === 'todos' || mode === 'decifra') || (!waiting.length && !skipped.length);
  el.decList.replaceChildren(...waiting.map(decifraCard));
  if (!waiting.length) el.decList.replaceChildren(h('li', { class: 'item' }, h('div', { class: 'reason' }, 'Nenhum texto esperando aprovação.')));
  el.skipBox.hidden = !skipped.length;
  el.skipSum.textContent = `O agente respondeu NÃO VALE TEXTO (${skipped.length})`;
  el.skipList.replaceChildren(...skipped.map((it) => h('li', { class: 'item' },
    meta(it, 'não vale texto', 'kind'),
    h('div', { class: 'headline' }, String(it.headline || '')),
    h('div', { class: 'reason' }, String(it.decifraSkipped)),
  )));
  return waiting.length;
}

function render() {
  const mode = el.filter.value;
  const waiting = renderDecifras(mode);
  const shown = mode === 'decifra' ? [] : items.filter((it) => mode === 'todos' || (mode === 'interno') === Boolean(it.internalOnly));
  el.list.replaceChildren(
    ...shown.map((it) => {
      const when = Date.parse(it.publishedAt);
      const link = webUrl(it.url);
      return h('li', { class: 'item' },
        h('div', { class: 'meta' },
          h('time', { class: 'time', datetime: it.publishedAt }, Number.isNaN(when) ? '--' : fmt.format(when)),
          h('span', { class: 'tag' }, String(it.tag || it.sourceName || 'Fonte')),
          h('span', { class: it.internalOnly ? 'kind' : 'kind check' }, it.internalOnly ? 'uso interno' : 'checagem'),
          String(it.sourceName || ''),
          ...(link ? [h('a', { href: link, target: '_blank', rel: 'noopener noreferrer' }, 'fonte ↗')] : []),
        ),
        h('div', { class: 'headline', lang: it.lang === 'en' ? 'en' : null }, String(it.headline || '')),
        ...(it.reviewReason ? [h('div', { class: 'reason' }, String(it.reviewReason))] : []),
      );
    }),
  );
  el.list.hidden = mode === 'decifra';
  el.count.textContent = mode === 'decifra' ? `${waiting} para aprovar` : `${shown.length} de ${items.length}${waiting ? ` · ${waiting} decifra para aprovar` : ''}`;
}

function showLogin(message = '') {
  clearInterval(timer);
  el.bar.hidden = true;
  el.login.hidden = false;
  el.list.replaceChildren();
  say(message, Boolean(message));
  el.token.focus();
}

async function load() {
  say('Carregando…');
  let res;
  try {
    res = await fetch('/api/revisao?limit=300', { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' });
  } catch {
    say('Sem conexão com o servidor. Tente de novo.', true);
    return;
  }
  if (res.status === 401) {
    store.clear();
    token = '';
    showLogin('Token inválido.');
    return;
  }
  if (res.status === 404) {
    showLogin('A revisão está desligada neste servidor (defina REVIEW_TOKEN).');
    return;
  }
  if (!res.ok) {
    say(`Erro ${res.status} ao carregar a fila.`, true);
    return;
  }
  const body = await res.json();
  items = Array.isArray(body.items) ? body.items : [];
  decifras = Array.isArray(body.decifras) ? body.decifras : [];
  el.login.hidden = true;
  el.bar.hidden = false;
  say(items.length || decifras.length ? '' : 'Nada na fila de revisão.');
  render();
}

function start(t) {
  token = t;
  store.set(t);
  load();
  clearInterval(timer);
  timer = setInterval(load, REFRESH_MS);
}

el.login.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = el.token.value.trim();
  el.token.value = '';
  if (t) start(t);
});
el.refresh.addEventListener('click', load);
el.filter.addEventListener('change', render);
el.logout.addEventListener('click', () => {
  store.clear();
  token = '';
  showLogin();
});

// #t=<token> in the link logs in once; the fragment is removed so it does not stay in the address bar or history.
const fromHash = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromHash) history.replaceState(null, '', location.pathname + location.search);
const initial = fromHash || store.get();
if (initial) start(initial);
else showLogin();
