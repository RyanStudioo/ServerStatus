// Server Status - pings healthchecks.io and displays each server's state.

const SERVERS = [
  {
    id: 'server-0',
    name: 'Server 0',
    url: 'https://healthchecks.io/b/2/b31e002e-161a-4cfb-9e24-44fa12a8b52d.json',
  },
];

const STATUS_LABELS = {
  up: 'Up',
  grace: 'Late (grace period)',
  down: 'Down',
  new: 'New',
  paused: 'Paused',
};

async function checkServer(server) {
  const textEl = document.getElementById(`${server.id}-status-text`);
  const dotEl = document.getElementById(`${server.id}-dot`);
  const detailsEl = document.getElementById(`${server.id}-details`);

  let status;
  try {
    const response = await fetch(server.url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    status = (await response.json()).status;
  } catch (err) {
    dotEl.className = 'status-dot error';
    textEl.textContent = 'Status unavailable';
    detailsEl.textContent = `Could not reach healthchecks.io (${err.message})`;
    return;
  }

  dotEl.className = `status-dot ${status}`;
  textEl.textContent = STATUS_LABELS[status] || status;

  const checkedAt = new Date().toLocaleTimeString();
  detailsEl.textContent = `Last checked at ${checkedAt}`;
}

function checkAll() {
  SERVERS.forEach(checkServer);
}

checkAll();
// Re-check every 60 seconds.
setInterval(checkAll, 60000);
