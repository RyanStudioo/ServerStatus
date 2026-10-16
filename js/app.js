// Server Status - reads ./config.json and pings each server's
// healthchecks.io status URL to display its state.

const CONFIG_URL = './config.json';
const DEFAULT_REFRESH_SECONDS = 60;

const STATUS_LABELS = {
  up: 'Up',
  grace: 'Late (grace period)',
  down: 'Down',
  new: 'New',
  paused: 'Paused',
};

// Lower sorts first: troubled servers float to the top of the page.
const SEVERITY = { down: 0, error: 1, grace: 2, new: 3, paused: 4, up: 5 };

const servers = [];

let banner;
let baseTitle = document.title;

const faviconIco = document.querySelector('link[rel="icon"][sizes="any"]');
const faviconSvg = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
const originalFaviconHrefs = [faviconIco, faviconSvg].map((link) => link && link.getAttribute('href'));

// Red-dot favicons shown in the browser tab while any server is down.
const alertIconPng = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.beginPath();
  ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fillStyle = '#dc2626';
  ctx.fill();
  return canvas.toDataURL('image/png');
})();

const alertIconSvg = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#dc2626"/></svg>',
)}`;

function slugify(name, fallbackIndex) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `server-${fallbackIndex}`;
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildCard(server, index) {
  let id = slugify(server.name, index);
  // Ensure unique element ids if several servers share a name.
  while (servers.some((s) => s.id === id)) id = `${id}-${index + 1}`;

  const card = createEl('div', 'server-card');
  card.id = id;

  const statusLine = createEl('p', 'server-status');
  const dot = createEl('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const text = createEl('span');
  text.setAttribute('role', 'status');
  text.textContent = 'Checking…';
  statusLine.append(dot, text);

  const details = createEl('p', 'server-details');

  card.append(createEl('h2', null, server.name), statusLine, details);
  document.getElementById('servers').append(card);

  servers.push({ ...server, id, dot, text, details, status: null, error: null });
}

async function checkServer(server) {
  let status;
  try {
    const response = await fetch(server.url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    status = (await response.json()).status;
  } catch (err) {
    server.status = null;
    server.error = err.message;
    server.dot.className = 'status-dot error';
    server.text.textContent = 'Status unavailable';
    server.details.textContent = `Could not reach healthchecks.io (${err.message})`;
    refreshOverview();
    return;
  }

  server.status = status;
  server.error = null;
  const known = STATUS_LABELS[status];
  server.dot.className = known ? `status-dot ${status}` : 'status-dot';
  server.text.textContent = known || String(status);

  const checkedAt = new Date().toLocaleTimeString();
  server.details.textContent = `Last checked at ${checkedAt}`;
  refreshOverview();
}

function checkAll() {
  servers.forEach(checkServer);
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function setBanner(state, text) {
  banner.className = `overall-status ${state}`;
  banner.textContent = text;
}

function serverSeverity(server) {
  if (server.error) return SEVERITY.error;
  return SEVERITY[server.status] ?? 6;
}

function sortCards() {
  const container = document.getElementById('servers');
  [...servers]
    .map((server, index) => ({ server, index }))
    .sort((a, b) => serverSeverity(a.server) - serverSeverity(b.server) || a.index - b.index)
    .forEach(({ server }) => container.append(document.getElementById(server.id)));
}

function updateTab(downCount) {
  if (downCount > 0) {
    document.title = `🔴 ${plural(downCount, 'server')} down — ${baseTitle}`;
    if (faviconIco) faviconIco.href = alertIconPng;
    if (faviconSvg) faviconSvg.href = alertIconSvg;
  } else {
    document.title = baseTitle;
    if (faviconIco && originalFaviconHrefs[0]) faviconIco.href = originalFaviconHrefs[0];
    if (faviconSvg && originalFaviconHrefs[1]) faviconSvg.href = originalFaviconHrefs[1];
  }
}

function refreshOverview() {
  const total = servers.length;
  if (total === 0) return;

  const down = servers.filter((s) => s.status === 'down').length;
  const grace = servers.filter((s) => s.status === 'grace').length;
  const errors = servers.filter((s) => s.error).length;
  const pending = servers.filter((s) => !s.error && s.status === null).length;

  if (down > 0) {
    setBanner('down', `${plural(down, 'server')} of ${total} down`);
  } else if (errors > 0) {
    setBanner('error', `Status unavailable for ${plural(errors, 'server')}`);
  } else if (grace > 0) {
    setBanner('grace', `${plural(grace, 'server')} late (grace period)`);
  } else if (pending > 0) {
    setBanner('checking', 'Checking statuses…');
  } else {
    setBanner('up', 'All systems operational');
  }

  updateTab(down);
  sortCards();
}

async function init() {
  banner = createEl('div', 'overall-status checking', 'Checking statuses…');
  banner.setAttribute('role', 'status');
  document.getElementById('servers').before(banner);

  let config;
  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    config = await response.json();
  } catch (err) {
    setBanner('error', 'Could not load config.json');
    document.getElementById('servers').append(
      createEl('p', 'server-details', `Could not load config.json (${err.message})`),
    );
    return;
  }

  // Apply page-wide settings from the config.
  if (config.pageTitle) {
    document.title = config.pageTitle;
    document.querySelector('h1').textContent = config.pageTitle;
    baseTitle = config.pageTitle;
  }
  if (config.description) {
    document.querySelector('meta[name="description"]').setAttribute('content', config.description);
  }

  const entries = Array.isArray(config.servers)
    ? config.servers.filter((s) => s && s.name && s.url)
    : [];

  if (entries.length === 0) {
    setBanner('error', 'No servers configured');
    document.getElementById('servers').append(
      createEl('p', 'server-details', 'No servers configured in config.json.'),
    );
    return;
  }

  entries.forEach(buildCard);
  checkAll();

  const refreshMs =
    Math.max(5, Number(config.refreshSeconds) || DEFAULT_REFRESH_SECONDS) * 1000;
  setInterval(checkAll, refreshMs);
}

init();
