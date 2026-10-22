import { getConfig, getServers } from './lib/config.js';
import { errorResponse, jsonResponse, corsHeaders, withHeaders } from './lib/http.js';
import { ensureSchema, pruneSamples } from './lib/schema.js';
import { getStatusPayload, recordSamples, resolveServers } from './lib/status.js';

const CACHE_PATH = '/__cache/api-status';
const PRUNE_CRON = '0 3 * * *';

async function readCache(cacheKey) {
  if (typeof caches === 'undefined' || !caches.default) return undefined;

  try {
    return await caches.default.match(cacheKey);
  } catch (error) {
    console.error('Cache read failed:', error);
    return undefined;
  }
}

function cacheKeyFor(request, config) {
  const cacheUrl = new URL(CACHE_PATH, request.url);
  cacheUrl.searchParams.set('days', String(config.windowDays));
  return new Request(cacheUrl.toString(), { method: 'GET' });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const config = getConfig(env);
    const cors = corsHeaders(request, config.allowedOrigins);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === '/api/health' || url.pathname === '/health') {
      return jsonResponse(
        { ok: true, generatedAt: new Date().toISOString() },
        { headers: cors },
      );
    }

    if (url.pathname !== '/api/status') {
      return errorResponse('not_found', 'Not found.', {
        status: 404,
        headers: cors,
      });
    }

    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'Only GET is supported.', {
        status: 405,
        headers: { ...cors, Allow: 'GET, OPTIONS' },
      });
    }

    if (!env.DB) {
      console.error('The DB D1 binding is not configured.');
      return errorResponse(
        'database_not_configured',
        'The status API database is not configured.',
        { status: 503, headers: cors },
      );
    }

    const cacheKey = cacheKeyFor(request, config);
    const useCache = config.cacheTtlSeconds > 0;

    if (useCache) {
      const cached = await readCache(cacheKey);
      if (cached) {
        return withHeaders(cached, { ...cors, 'X-Cache': 'HIT' });
      }
    }

    try {
      const payload = await getStatusPayload({
        db: env.DB,
        servers: await getServers(env),
        config,
        now: new Date(),
      });

      const response = jsonResponse(payload, {
        headers: {
          'Cache-Control': useCache
            ? `public, max-age=${config.cacheTtlSeconds}`
            : 'no-store',
          'X-Cache': 'MISS',
        },
      });

      if (useCache && typeof caches !== 'undefined' && caches.default) {
        ctx.waitUntil(
          caches.default.put(cacheKey, response.clone()).catch((error) => {
            console.error('Cache write failed:', error);
          }),
        );
      }

      return withHeaders(response, cors);
    } catch (error) {
      console.error('Failed to build the status payload:', error);

      return errorResponse(
        'status_unavailable',
        'Could not load the status data.',
        { status: 502, headers: cors },
      );
    }
  },

  async scheduled(controller, env, ctx) {
    const config = getConfig(env);

    if (!env.DB) {
      console.error('Scheduled task skipped: the DB D1 binding is not configured.');
      return;
    }

    const task = (async () => {
      await ensureSchema(env.DB);

      if (controller.cron === PRUNE_CRON) {
        await pruneSamples(env.DB, {
          now: new Date(),
          days: config.windowDays + 2,
        });
        return;
      }

      await recordSamples({
        db: env.DB,
        servers: resolveServers(await getServers(env)),
        now: new Date(),
      });
    })();

    ctx.waitUntil(
      task.catch((error) => {
        console.error('Scheduled task failed:', error);
      }),
    );
  },
};
