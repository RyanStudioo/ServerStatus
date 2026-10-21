const DEFAULT_TIMEOUT_MS = 8000;
const BADGE_PATH = /^\/b\/(\d+)\/([0-9a-f-]+)\.(json|svg)$/i;

export class BadgeError extends Error {
  constructor(message, { code = 'badge_error', status = 0 } = {}) {
    super(message);
    this.name = 'BadgeError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Parse a Healthchecks badge URL into a stable check key and a JSON URL.
 * Supports both 2-state (/b/2/) and 3-state (/b/3/) check badges.
 */
export function parseBadgeUrl(value) {
  if (typeof value !== 'string') return null;

  try {
    const url = new URL(value);
    const match = url.pathname.match(BADGE_PATH);
    if (!match) return null;

    const [, states, badgeKey] = match;
    const jsonUrl = new URL(url.toString());
    jsonUrl.pathname = url.pathname.replace(/\.(json|svg)$/i, '.json');
    jsonUrl.search = '';
    jsonUrl.hash = '';

    return {
      badgeKey: badgeKey.toLowerCase(),
      states: Number(states),
      url: jsonUrl.toString(),
    };
  } catch {
    return null;
  }
}

export function normalizeBadgeStatus(status) {
  if (status === 'late') return 'grace';
  if (status === 'up' || status === 'grace' || status === 'down') return status;
  return 'unknown';
}

export function statusIsUp(status) {
  return status === 'up' || status === 'grace';
}

export async function fetchBadgeStatus(
  url,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'ServerStatus/0.1',
      },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new BadgeError('Healthchecks badge request timed out.', { code: 'timeout' });
    }
    throw new BadgeError(`Could not reach the Healthchecks badge URL: ${error.message}`, {
      code: 'network_error',
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new BadgeError(`Healthchecks badge responded with HTTP ${response.status}.`, {
      code: 'upstream_error',
      status: response.status,
    });
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new BadgeError('Healthchecks badge returned invalid JSON.', {
      code: 'invalid_response',
    });
  }

  if (!data || typeof data.status !== 'string') {
    throw new BadgeError('Healthchecks badge returned an unexpected response.', {
      code: 'invalid_response',
    });
  }

  return data.status;
}
