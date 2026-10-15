// Private review queue: headlines that did not go public (failed checks, AI refusals, internal-only sources).
// The token comes from the URL fragment (#t=…, never sent to the server) or the form, and lives in sessionStorage.

const KEY = 'aovivo-revisao-token';
const REFRESH_MS = 60_000;
const $ = (id) => document.getElementById(id);
const el = {
  login: $('login'), token: $('token'), bar: $('bar'), filter: $('filter'), refresh: $('refresh'),
  logout: $('logout'), count: $('count'), msg: $('msg'), list: $('list'),
};

let items = [];
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

function render() {
  const mode = el.filter.value;
  const shown = items.filter((it) => mode === 'todos' || (mode === 'interno') === Boolean(it.internalOnly));
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
  el.count.textContent = `${shown.length} de ${items.length}`;
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
  el.login.hidden = true;
  el.bar.hidden = false;
  say(items.length ? '' : 'Nada na fila de revisão.');
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
