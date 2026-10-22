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
let uptimeTextSpan;
let metaUpdated;
let refreshButton;
let legend;
let baseTitle = document.title;
let lastUpdatedAt = null;
let refreshing = false;

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Shared hover tooltip for the daily uptime bars.
let tooltip;
let tooltipDate;
let tooltipValue;
let tooltipDetail;

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

const SVG_NS = 'http://www.w3.org/2000/svg';

// A simple two-bay server rack for empty states.
const EMPTY_STATE_ICON =
  '<rect x="3" y="3.5" width="18" height="7.5" rx="2" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" />'
  + '<rect x="3" y="13" width="18" height="7.5" rx="2" fill="none" stroke="currentColor"'
  + ' stroke-width="1.5" />'
  + '<circle cx="7" cy="7.25" r="0.75" fill="currentColor" />'
  + '<circle cx="7" cy="16.75" r="0.75" fill="currentColor" />';

function createSvgIcon(paths) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
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

function formatFullDate(dateString) {
  if (!dateString) return '';
  const date = new Date(`${dateString}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
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

function formatSince(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

function setBanner(state, text) {
  banner.classList.remove('checking', 'up', 'grace', 'down', 'error', 'unknown');
  banner.classList.add(state);
  bannerText.textContent = text;
}

function setEmptyState(message) {
  let el = document.getElementById('empty-state');

  if (!message) {
    if (el) el.remove();
    return;
  }

  if (!el) {
    el = createEl('div', 'empty-state');
    el.id = 'empty-state';
    document.getElementById('servers').append(el);
  }
  el.replaceChildren(createSvgIcon(EMPTY_STATE_ICON), createEl('p', null, message));
}

function setRefreshing(value) {
  refreshing = value;
  banner.classList.toggle('refreshing', value);
  if (refreshButton) refreshButton.classList.toggle('spinning', value);
}

// Hides the whole meta line when both the uptime text and the updated stamp
// are empty.
function updateBannerMeta() {
  bannerMeta.hidden = !uptimeTextSpan.textContent && !metaUpdated.textContent;
}

// Keeps the "Updated …" stamp honest between API polls.
function tickBannerMeta() {
  metaUpdated.textContent = lastUpdatedAt ? `Updated ${formatRelative(lastUpdatedAt)}` : '';
  updateBannerMeta();
}

function createCard(server, index, key) {
  const card = createEl('div', 'server-card');
  card.id = key.replace(/[^a-zA-Z0-9_-]/g, '-');
  if (card.id) {
    // Lets View Transitions animate cards moving between sorted positions.
    card.style.viewTransitionName = `card-${card.id}`;
  }

  const name = createEl('h2');
  const nameLink = createEl('a', 'server-link', server.name || `Server ${index + 1}`);
  nameLink.href = `#${card.id}`;
  name.append(nameLink);

  const statusLine = createEl('p', 'server-status');
  const dot = createEl('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  const text = createEl('span');
  text.setAttribute('role', 'status');
  text.textContent = 'Checking…';
  statusLine.append(dot, text);

  const details = createEl('p', 'server-details');

  // Display-only process/service tags from the server config.
  const processes = createEl('ul', 'server-tags');
  processes.setAttribute('aria-label', 'Processes and services');
  processes.hidden = true;

  const uptime = createEl('div', 'uptime');
  const uptimeHeader = createEl('div', 'uptime-header');
  const percent = createEl('span', 'uptime-percent', '—');
  const label = createEl('span', 'uptime-label');
  uptimeHeader.append(percent, label);

  const bars = createEl('div', 'uptime-bars');
  // One tab stop for the whole strip; arrow keys move between days.
  bars.tabIndex = 0;
  bars.setAttribute('role', 'group');
  bars.addEventListener('keydown', (event) => {
    const barList = Array.from(bars.children);
    const current = barList.indexOf(document.activeElement);
    let next = null;

    if (event.key === 'ArrowRight') {
      next = current < 0 ? 0 : Math.min(current + 1, barList.length - 1);
    } else if (event.key === 'ArrowLeft') {
      next = current < 0 ? barList.length - 1 : Math.max(current - 1, 0);
    } else if (event.key === 'Home') {
      next = 0;
    } else if (event.key === 'End') {
      next = barList.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    if (barList[next]) barList[next].focus();
  });

  const meta = createEl('p', 'uptime-meta');

  uptime.append(uptimeHeader, bars, meta);
  card.append(name, statusLine, details, processes, uptime);
  document.getElementById('servers').append(card);

  const entry = {
    card,
    name,
    nameLink,
    dot,
    text,
    details,
    processes,
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
  hideDayTooltip();
  container.replaceChildren();

  for (let index = 0; index < windowDays; index += 1) {
    const day = entries[index];
    const bar = createEl('span', 'uptime-bar');
    bar.tabIndex = -1;
    bar.setAttribute('role', 'img');

    if (!day || day.uptimePercent === null || day.uptimePercent === undefined) {
      bar.classList.add('unknown');
      bar.setAttribute('aria-label', 'No data');
    } else {
      const percent = Number(day.uptimePercent);
      bar.classList.add(percent >= 99.995 ? 'up' : 'down');
      const downtime = Number(day.downSeconds) > 0
        ? `, ${formatDuration(day.downSeconds)} downtime`
        : '';
      bar.setAttribute(
        'aria-label',
        `${formatFullDate(day.date)}: ${formatPercent(percent)}% uptime${downtime}`,
      );
    }

    ensureBarDayTooltip(bar, day);
    container.append(bar);
  }
}

// Shared tooltip wiring for a single daily bar: hover, tap, and keyboard focus.
function ensureBarDayTooltip(bar, day) {
  bar.addEventListener('mouseenter', () => showDayTooltip(bar, day));
  bar.addEventListener('mouseleave', hideDayTooltip);
  bar.addEventListener('focus', () => showDayTooltip(bar, day));
  bar.addEventListener('blur', hideDayTooltip);
  // Touch taps get a click after the global pointerdown handler has reset
  // the tooltip, so tapping a bar (or anywhere else) works on mobile too.
  bar.addEventListener('click', () => showDayTooltip(bar, day));
}

/*
 * One tooltip element is shared by every bar in every card. Hovering a bar
 * fills it with that day's date and uptime and pins it above the bar. The
 * bars carry an aria-label instead, so the tooltip stays aria-hidden.
 */
function createTooltip() {
  tooltip = createEl('div', 'uptime-tooltip');
  tooltip.setAttribute('aria-hidden', 'true');
  tooltipDate = createEl('span', 'tooltip-date');
  tooltipValue = createEl('span', 'tooltip-value');
  tooltipDetail = createEl('span', 'tooltip-detail');
  tooltip.append(tooltipDate, tooltipValue, tooltipDetail);
  document.body.append(tooltip);

  // Keep the tooltip honest when the layout moves under the pointer.
  window.addEventListener('scroll', hideDayTooltip, { capture: true, passive: true });
  document.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') hideDayTooltip();
  });
}

function hideDayTooltip() {
  if (tooltip) tooltip.classList.remove('visible');
}

function showDayTooltip(bar, day) {
  if (!tooltip) return;

  const hasData = day && day.uptimePercent !== null && day.uptimePercent !== undefined;
  tooltipDate.textContent = hasData ? formatFullDate(day.date) : '';
  tooltipDate.hidden = !tooltipDate.textContent;
  tooltipValue.textContent = hasData
    ? `${formatPercent(Number(day.uptimePercent))}% uptime`
    : 'No data';
  tooltipDetail.textContent = hasData && Number(day.downSeconds) > 0
    ? `${formatDuration(day.downSeconds)} downtime`
    : '';
  tooltipDetail.hidden = !tooltipDetail.textContent;

  positionDayTooltip(bar);
  tooltip.classList.add('visible');
}

function positionDayTooltip(bar) {
  const rect = bar.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;

  const maxLeft = Math.max(margin, window.innerWidth - margin - width);
  const left = Math.min(
    Math.max(margin, rect.left + rect.width / 2 - width / 2),
    maxLeft,
  );
  let top = rect.top - height - gap;
  if (top < margin) top = rect.bottom + gap;

  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

/*
 * Runs a DOM update inside a View Transition when the browser supports it and
 * the user has not asked for reduced motion, so reordered cards glide into
 * place instead of teleporting.
 */
function withViewTransition(update) {
  if (!document.startViewTransition || prefersReducedMotion.matches) {
    update();
    return;
  }
  document.startViewTransition(update);
}

// Brief tinted pulse on a card whose status just changed.
function flashCard(card, kind) {
  card.classList.remove('flash-up', 'flash-down');
  // Force a reflow so re-adding the class restarts the animation.
  void card.offsetWidth;
  card.classList.add(kind);
  card.addEventListener(
    'animationend',
    () => card.classList.remove(kind),
    { once: true },
  );
}

function renderCard(entry, server, windowDays, previousStatus) {
  const status = server.error ? 'error' : server.status || 'error';
  entry.nameLink.textContent = server.name || 'Server';
  entry.dot.className = `status-dot ${status}`;
  entry.text.textContent = STATUS_LABELS[status] || String(status);
  entry.label.textContent = `${windowDays}-day uptime`;
  entry.card.classList.toggle('down', status === 'down');

  if (
    previousStatus
    && previousStatus !== status
    && !prefersReducedMotion.matches
  ) {
    flashCard(entry.card, status === 'up' ? 'flash-up' : 'flash-down');
  }

  if (server.error) {
    entry.details.textContent = server.error;
  } else {
    const lastSample = formatRelative(server.lastSample);
    entry.details.textContent = lastSample
      ? `Last checked ${lastSample}${server.stale ? ' · stale' : ''}`
      : 'No status samples collected yet';
  }

  const processList = Array.isArray(server.processes) ? server.processes : [];
  entry.processes.hidden = processList.length === 0;
  entry.processes.replaceChildren(
    ...processList.map((name) => createEl('li', 'server-tag', String(name))),
  );

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
  // Red for meaningful downtime; amber for the 99.x% edge cases.
  entry.percent.className = percent === null
    ? 'uptime-percent'
    : percent < 99
      ? 'uptime-percent has-downtime'
      : percent < 100
        ? 'uptime-percent has-minor-downtime'
        : 'uptime-percent';

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

  uptimeTextSpan.textContent = uptimeText;
  tickBannerMeta();

  if (total === 0) {
    setBanner('unknown', 'No servers configured');
  } else if (down > 0) {
    setBanner('down', `${plural(down, 'server')} of ${total} down`);
  } else if (grace > 0) {
    setBanner('grace', `${plural(grace, 'server')} late (grace period)`);
  } else if (errors > 0) {
    setBanner('error', `Status unavailable for ${plural(errors, 'server')}`);
  } else if (up > 0) {
    setBanner('up', 'All systems operational');
  } else {
    setBanner('unknown', 'No active checks');
  }

  updateTab(down);
  sortCards();
}

function applyPayload(payload) {
  const servers = Array.isArray(payload.servers) ? payload.servers : [];
  const windowDays = payload.window && payload.window.days ? payload.window.days : 28;

  withViewTransition(() => {
    const seen = new Set();

    servers.forEach((server, index) => {
      const key = String(server.id || slugify(server.name, index));
      let entry = cards.get(key);
      const previousStatus = entry && entry.data
        ? (entry.data.error ? 'error' : entry.data.status || 'error')
        : null;

      if (!entry) {
        entry = createCard(server, index, key);
      }

      entry.order = index;
      entry.data = server;
      renderCard(entry, server, windowDays, previousStatus);
      seen.add(key);
    });

    for (const [key, entry] of cards) {
      if (!seen.has(key)) {
        entry.card.remove();
        cards.delete(key);
      }
    }

    setEmptyState(servers.length === 0 ? 'No servers are configured on the status API.' : null);
    if (legend) legend.hidden = servers.length === 0;
    renderOverview(payload);
  });
}

function showLoadError(error) {
  const message = error && error.message
    ? `Could not load status (${error.message})`
    : 'Could not load status';

  setBanner('error', message);
  // Keep the updated stamp honest about how old the data is.
  tickBannerMeta();

  if (cards.size === 0) {
    setEmptyState('The status API could not be reached.');
  }
}

async function loadStatus() {
  setRefreshing(true);
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
  } finally {
    setRefreshing(false);
  }
}

/*
 * Header chrome that does not depend on config.json: the manual refresh
 * button (from index.html) and the uptime-bar color legend.
 */
function setupChrome() {
  refreshButton = document.querySelector('.refresh-button');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      if (!refreshing) loadStatus();
    });
  }

  legend = createEl('div', 'uptime-legend');
  legend.hidden = true;
  legend.append(
    legendItem('up', 'Up'),
    legendItem('down', 'Downtime'),
    legendItem('unknown', 'No data'),
  );
  document.getElementById('servers').before(legend);
}

function legendItem(kind, text) {
  const item = createEl('span', 'legend-item');
  const swatch = createEl('span', `legend-swatch ${kind}`);
  swatch.setAttribute('aria-hidden', 'true');
  item.append(swatch, createEl('span', null, text));
  return item;
}

function setMetaContent(selector, content) {
  const meta = document.querySelector(selector);
  if (meta) meta.setAttribute('content', content);
}

async function init() {
  banner = createEl('div', 'overall-status checking');
  banner.setAttribute('role', 'status');
  bannerText = createEl('span', 'overall-status-text', 'Checking statuses…');
  bannerMeta = createEl('span', 'overall-status-meta');
  bannerMeta.hidden = true;
  uptimeTextSpan = createEl('span', 'overall-uptime');
  metaUpdated = createEl('span', 'meta-updated');
  const spinner = createEl('span', 'refresh-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  bannerMeta.append(uptimeTextSpan, metaUpdated, spinner);
  banner.append(bannerText, bannerMeta);
  document.getElementById('servers').before(banner);

  createTooltip();
  setupChrome();

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
    setMetaContent('meta[property="og:title"]', config.pageTitle);
  }
  if (config.description) {
    const description = document.querySelector('meta[name="description"]');
    if (description) description.setAttribute('content', config.description);
    setMetaContent('meta[property="og:description"]', config.description);

    const pageDescription = document.querySelector('.page-description');
    if (pageDescription) {
      pageDescription.textContent = config.description;
      pageDescription.hidden = false;
    }
  }

  const refreshSeconds = Math.max(
    5,
    Number(config.refreshSeconds) || DEFAULT_REFRESH_SECONDS,
  );

  await loadStatus();
  setInterval(loadStatus, refreshSeconds * 1000);
  // Keeps the "Updated …" stamp current between polls.
  setInterval(tickBannerMeta, 1000);
}

init();
