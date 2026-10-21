// Server Status - loads display settings from ./config.json and current
// status plus 28-day uptime from the ServerStatus API.

const CONFIG_URL = './config.json';
const DEFAULT_REFRESH_SECONDS = 60;
const DEFAULT_API_BASE_URL = '/api';

const STATUS_LABELS = {
  up: 'Up',
  grace: 'Late (grace period)',
  down: 'Down',
  new: 'New',
  paused: 'Paused',
  error: 'Status unavailable',
};

// Lower sorts first: troubled servers float to the top of the page.
const SEVERITY = { down: 0, error: 1, grace: 2, new: 3, paused: 4, up: 5 };

const cards = new Map();

let config = {};
let banner;
let bannerText;
let bannerMeta;
let baseTitle = document.title;
let lastUpdatedAt = null;

const faviconIco = document.querySelector('link[rel="icon"][sizes="any"]');
const faviconSvg = document.querySelector('link[rel="icon"][type="image/svg+xml"]');
const originalFaviconHrefs = [faviconIco, faviconSvg].map(
  (link) => link && link.getAttribute('href'),
);

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
  return slug || `server-${fallbackIndex + 1}`;
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function apiUrl(path) {
  const raw = String(config.apiBaseUrl || DEFAULT_API_BASE_URL).trim();
  const base = raw.replace(/\/+$/, '');
  return `${base}/${String(path).replace(/^\/+/, '')}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value));
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatDate(dateString) {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function formatRelative(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

  if (abs < 60) return rtf.format(diffSeconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
  return rtf.format(Math.round(diffSeconds / 86400), 'day');
}

function formatUpdated(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatSince(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function setBanner(state, text, meta = '') {
  banner.className = `overall-status ${state}`;
  bannerText.textContent = text;
  bannerMeta.textContent = meta;
}

function setEmptyState(message) {
  let el = document.getElementById('empty-state');

  if (!message) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = createEl('p', 'server-details empty-state');
    el.id = 'empty-state';
    document.getElementById('servers').append(el);
  }
  el.textContent = message;
}

function createCard(server, index, key) {
  const card = createEl('div', 'server-card');
  card.id = key.replace(/[^a-zA-Z0-9_-]/g, '-');

  const name = createEl('h2', null, server.name || `Server ${index + 1}`);

  const statusLine = createEl('p', 'server-status');
  const dot = createEl('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const text = createEl('span');
  text.setAttribute('role', 'status');
  text.textContent = 'Checking…';
  statusLine.append(dot, text);

  const details = createEl('p', 'server-details');

  const uptime = createEl('div', 'uptime');
  const uptimeHeader = createEl('div', 'uptime-header');
  const percent = createEl('span', 'uptime-percent', '—');
  const label = createEl('span', 'uptime-label');
  uptimeHeader.append(percent, label);

  const bars = createEl('div', 'uptime-bars');
  bars.setAttribute('role', 'img');

  const meta = createEl('p', 'uptime-meta');

  uptime.append(uptimeHeader, bars, meta);
  card.append(name, statusLine, details, uptime);
  document.getElementById('servers').append(card);

  const entry = {
    card,
    name,
    dot,
    text,
    details,
    percent,
    label,
    bars,
    meta,
    order: index,
    data: null,
  };
  cards.set(key, entry);
  return entry;
}

function renderBars(container, daily, windowDays) {
  const entries = Array.isArray(daily) ? daily.slice(-windowDays) : [];
  container.replaceChildren();

  for (let index = 0; index < windowDays; index += 1) {
    const day = entries[index];
    const bar = createEl('span', 'uptime-bar');

    if (!day || day.uptimePercent === null || day.uptimePercent === undefined) {
      bar.classList.add('unknown');
      bar.title = day ? `${formatDate(day.date)}: no data` : 'No data';
    } else {
      const percent = Number(day.uptimePercent);
      bar.classList.add(percent >= 99.995 ? 'up' : 'down');
      bar.title = `${formatDate(day.date)}: ${formatPercent(percent)}% uptime`;
    }

    bar.setAttribute('aria-hidden', 'true');
    container.append(bar);
  }
}

function renderCard(entry, server, windowDays) {
  const status = server.error ? 'error' : server.status || 'error';
  entry.name.textContent = server.name || 'Server';
  entry.dot.className = `status-dot ${status}`;
  entry.text.textContent = STATUS_LABELS[status] || String(status);
  entry.label.textContent = `${windowDays}-day uptime`;

  if (server.error) {
    entry.details.textContent = server.error;
  } else {
    const lastSample = formatRelative(server.lastSample);
    entry.details.textContent = lastSample
      ? `Last checked ${lastSample}${server.stale ? ' · stale' : ''}`
      : 'No status samples collected yet';
  }

  const uptime = server.uptime;
  if (!uptime) {
    entry.percent.textContent = '—';
    entry.percent.className = 'uptime-percent';
    renderBars(entry.bars, [], windowDays);
    entry.bars.setAttribute('aria-label', `${windowDays}-day uptime data unavailable`);
    entry.meta.textContent = server.uptimeError || 'Uptime data unavailable';
    return;
  }

  const percent = uptime.percent;
  entry.percent.textContent = percent === null ? '—' : `${formatPercent(percent)}%`;
  entry.percent.className =
    percent !== null && percent < 100 ? 'uptime-percent has-downtime' : 'uptime-percent';

  renderBars(entry.bars, uptime.daily, windowDays);
  entry.bars.setAttribute(
    'aria-label',
    percent === null
      ? `${windowDays}-day uptime data unavailable`
      : `${formatPercent(percent)} percent uptime over the past ${windowDays} days`,
  );

  const downSeconds = Number(uptime.downSeconds) || 0;
  const incidents = Number(uptime.incidents) || 0;
  const downtime = downSeconds > 0 ? `${formatDuration(downSeconds)} downtime` : 'No downtime';
  const meta = [`${downtime} · ${plural(incidents, 'incident')}`];

  if (
    uptime.dataSince &&
    Number(uptime.coverageSeconds) < windowDays * 24 * 60 * 60
  ) {
    meta.push(`tracking since ${formatSince(uptime.dataSince)}`);
  }

  entry.meta.textContent = meta.join(' · ');
}

function serverSeverity(server) {
  if (!server) return 6;
  if (server.error) return SEVERITY.error;
  return SEVERITY[server.status] ?? 6;
}

function sortCards() {
  const container = document.getElementById('servers');
  [...cards.values()]
    .sort((a, b) => serverSeverity(a.data) - serverSeverity(b.data) || a.order - b.order)
    .forEach((entry) => container.append(entry.card));
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

function renderOverview(payload) {
  const overall = payload.overall || {};
  const counts = overall.counts || {};
  const total = Number.isFinite(counts.total) ? counts.total : (payload.servers || []).length;
  const down = Number(counts.down) || 0;
  const grace = Number(counts.grace) || 0;
  const errors = Number(counts.error) || 0;
  const up = Number(counts.up) || 0;
  const windowDays = payload.window && payload.window.days ? payload.window.days : 28;

  lastUpdatedAt = payload.generatedAt ? new Date(payload.generatedAt) : new Date();

  const windowStart = payload.window && payload.window.start
    ? new Date(payload.window.start)
    : null;
  const dataSince = overall.dataSince ? new Date(overall.dataSince) : null;
  const partialCoverage =
    windowStart &&
    dataSince &&
    dataSince.getTime() - windowStart.getTime() > 60 * 60 * 1000;

  let uptimeText;
  if (overall.uptimePercent === null || overall.uptimePercent === undefined) {
    uptimeText = `${windowDays}-day uptime unavailable`;
  } else if (partialCoverage) {
    uptimeText = `${formatPercent(overall.uptimePercent)}% uptime since ${formatSince(dataSince)}`;
  } else {
    uptimeText = `${formatPercent(overall.uptimePercent)}% uptime over the past ${windowDays} days`;
  }

  const updated = formatUpdated(payload.generatedAt);
  const meta = updated ? `${uptimeText} · Updated ${updated}` : uptimeText;

  if (total === 0) {
    setBanner('unknown', 'No servers configured', meta);
  } else if (down > 0) {
    setBanner('down', `${plural(down, 'server')} of ${total} down`, meta);
  } else if (grace > 0) {
    setBanner('grace', `${plural(grace, 'server')} late (grace period)`, meta);
  } else if (errors > 0) {
    setBanner('error', `Status unavailable for ${plural(errors, 'server')}`, meta);
  } else if (up > 0) {
    setBanner('up', 'All systems operational', meta);
  } else {
    setBanner('unknown', 'No active checks', meta);
  }

  updateTab(down);
  sortCards();
}

function applyPayload(payload) {
  const servers = Array.isArray(payload.servers) ? payload.servers : [];
  const windowDays = payload.window && payload.window.days ? payload.window.days : 28;
  const seen = new Set();

  servers.forEach((server, index) => {
    const key = String(server.id || slugify(server.name, index));
    let entry = cards.get(key);

    if (!entry) {
      entry = createCard(server, index, key);
    }

    entry.order = index;
    entry.data = server;
    renderCard(entry, server, windowDays);
    seen.add(key);
  });

  for (const [key, entry] of cards) {
    if (!seen.has(key)) {
      entry.card.remove();
      cards.delete(key);
    }
  }

  setEmptyState(servers.length === 0 ? 'No servers are configured on the status API.' : null);
  renderOverview(payload);
}

function showLoadError(error) {
  const message = error && error.message
    ? `Could not load status (${error.message})`
    : 'Could not load status';

  const updated = lastUpdatedAt ? formatUpdated(lastUpdatedAt) : '';
  const meta = updated ? `Showing last known status from ${updated}` : '';
  setBanner('error', message, meta);

  if (cards.size === 0) {
    setEmptyState('The status API could not be reached.');
  }
}

async function loadStatus() {
  try {
    const response = await fetch(apiUrl('status'), {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        const body = await response.json();
        if (body && body.error && body.error.message) {
          message = body.error.message;
        }
      } catch {
        // Keep the HTTP status message.
      }
      throw new Error(message);
    }

    const payload = await response.json();
    if (!payload || !Array.isArray(payload.servers)) {
      throw new Error('The status API returned an unexpected response.');
    }

    applyPayload(payload);
  } catch (error) {
    showLoadError(error);
  }
}

async function init() {
  banner = createEl('div', 'overall-status checking');
  banner.setAttribute('role', 'status');
  bannerText = createEl('span', 'overall-status-text', 'Checking statuses…');
  bannerMeta = createEl('span', 'overall-status-meta');
  banner.append(bannerText, bannerMeta);
  document.getElementById('servers').before(banner);

  try {
    const response = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
  } catch (error) {
    config = {};
    console.warn(`Could not load config.json (${error.message}); using defaults.`);
  }

  if (config.pageTitle) {
    document.title = config.pageTitle;
    document.querySelector('h1').textContent = config.pageTitle;
    baseTitle = config.pageTitle;
  }
  if (config.description) {
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', config.description);
  }

  const refreshSeconds = Math.max(
    5,
    Number(config.refreshSeconds) || DEFAULT_REFRESH_SECONDS,
  );

  await loadStatus();
  setInterval(loadStatus, refreshSeconds * 1000);
}

init();
