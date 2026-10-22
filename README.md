# Server Status

A status page for Ryan Studio's servers. It is an npm-workspaces monorepo made
of two deployables: a static client and a Cloudflare Worker that tracks uptime
itself.

There is **no Healthchecks API key**. The Worker samples Healthchecks' public
per-check badge endpoints, stores the history in Cloudflare D1, and serves it
over a small JSON API that only the client consumes.

| Deployable | What it is | Path |
| --- | --- | --- |
| Client | Static site built with webpack, hosted on Cloudflare Pages | `src/client` |
| API | Cloudflare Worker + D1, hosted on Cloudflare Workers | `src/server` |

```text
Cloudflare Cron (every minute)
        │
        ▼
  Worker (serverstatus-api) ── fetch ──▶ Healthchecks.io public badge JSON
        │                                 (per-check, no API key)
        ▼
  Cloudflare D1 — `samples` table (28-day history)
        │
        ▼
  GET /api/status ──▶ Static client (Cloudflare Pages)
```

## How it works

1. The Worker runs on a **one-minute Cloudflare Cron Trigger**.
2. Each run fetches the public badge JSON for every server in the
   [server config gist](https://gist.github.com/RyanStudioo/82070a6601776f83bce51768593affe0).
3. One status sample per check is inserted into a **Cloudflare D1** database.
4. The API serves current status, uptime percentage, downtime, incidents, and
   28 daily bars from that sample history.
5. A daily cron deletes samples older than the configured window plus two
   days.

If the API is called while the latest sample is more than a minute old, the
Worker samples on demand first. That makes the page work immediately on first
deploy and in local development, even without a running cron.

The client only talks to the Worker; it never calls Healthchecks directly.

## Check configuration

The server list lives in a gist that the Worker fetches at runtime:
<https://gist.github.com/RyanStudioo/82070a6601776f83bce51768593affe0>

```json
{
  "servers": [
    {
      "name": "Web 01",
      "url": "https://healthchecks.io/b/2/<badge-key>.json",
      "processes": ["API", "Postgres", "Redis"]
    }
  ]
}
```

- `url` must be a per-check Healthchecks badge URL. Both `/b/2/` and `/b/3/`
  URLs work, and `.svg` URLs are converted to `.json` automatically.
- The badge key is the stable database key, so changing only the display name
  keeps the history.
- `processes` is optional and display-only: a human-readable list of what runs
  on that server, shown as tags on its status card. It does not affect status
  or uptime math.

### Editing the config

The built-in default is a **revision-pinned** raw URL, so on its own it will
not pick up gist edits. To make gist edits go live without a deploy, add a
`CONFIG_URL` variable pointing at the version-less raw URL:

```jsonc
// src/server/wrangler.jsonc
"vars": {
  "CONFIG_URL": "https://gist.githubusercontent.com/RyanStudioo/82070a6601776f83bce51768593affe0/raw/server_config.json"
}
```

- A raw URL containing a commit hash is frozen to that revision; the
  version-less `/raw/server_config.json` form always serves the latest one.
- The Worker re-fetches the URL at most every 30 seconds per running instance,
  so changes appear within a minute or two.
- The `/api/status` response itself is cached for 60 seconds by default.
- If the URL is briefly unreachable, the Worker keeps serving the last config
  it fetched.

## Local development

Requirements: Node.js 22+ and npm (Wrangler 4 requires Node 22+).

```bash
npm install
npm run dev
```

- Client: <http://localhost:8080>
- Worker API: <http://localhost:8787>
- The client's webpack dev server proxies `/api` to the Worker.
- Wrangler creates a local D1 database automatically, and the Worker creates
  the `samples` table if it does not exist.

To run the processes separately, use `npm run dev:client` and
`npm run dev:server`.

### Local database commands

```bash
npm run db:migrate:local

cd src/server
npx wrangler d1 execute serverstatus --local --command "SELECT COUNT(*) FROM samples"
```

## API

### `GET /api/status`

```json
{
  "generatedAt": "2026-10-21T16:40:00.000Z",
  "window": {
    "days": 28,
    "start": "2026-09-24T00:00:00.000Z",
    "end": "2026-10-21T16:40:00.000Z"
  },
  "sampleIntervalSeconds": 60,
  "overall": {
    "status": "down",
    "uptimePercent": 99.94,
    "upSeconds": 2419100,
    "downSeconds": 1500,
    "incidents": 1,
    "samples": 40320,
    "dataSince": "2026-09-24T00:00:00.000Z",
    "counts": {
      "total": 2,
      "up": 1,
      "grace": 0,
      "down": 1,
      "new": 0,
      "paused": 0,
      "error": 0
    }
  },
  "servers": [
    {
      "id": "server-0",
      "slug": "server-0",
      "name": "Server 0",
      "status": "up",
      "processes": ["API", "Postgres"],
      "lastSample": "2026-10-21T16:39:00.000Z",
      "stale": false,
      "uptime": {
        "percent": 100,
        "samples": 40320,
        "upSamples": 40320,
        "downSamples": 0,
        "upSeconds": 2419200,
        "downSeconds": 0,
        "coverageSeconds": 2419200,
        "incidents": 0,
        "dataSince": "2026-09-24T00:00:00.000Z",
        "daily": [
          {
            "date": "2026-09-24",
            "samples": 1440,
            "upSamples": 1440,
            "uptimePercent": 100,
            "downSeconds": 0,
            "incidents": 0
          }
        ]
      }
    }
  ]
}
```

- `uptime` is `null` until the first sample is collected.
- `lastSample` is the last time the Worker successfully checked the badge.
- `stale` becomes `true` when the latest sample is more than three minutes old.
- `processes` appears only when the server's config entry defines one; it is
  display-only.
- `daily` always contains exactly one entry per UTC calendar day in the window.
- `dataSince` is the first sample in the window. On a fresh deployment the
  percentage reflects only the data collected so far.
- `status` is `up`, `grace`, `down`, or `error`.

### `GET /api/health`

Returns `{ "ok": true, "generatedAt": "…" }` without touching D1 or
Healthchecks.

### CORS

`ALLOWED_ORIGINS` defaults to `*`. Set it to a comma-separated allowlist when
the client and Worker are on different origins:

```text
ALLOWED_ORIGINS=https://status.example.com,http://localhost:8080
```

## Configuration

Worker settings live in `src/server/wrangler.jsonc`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPTIME_WINDOW_DAYS` | `28` | Uptime window, capped at 90 days |
| `CACHE_TTL_SECONDS` | `60` | API cache duration; `0` disables caching |
| `ALLOWED_ORIGINS` | `*` | CORS allowlist |
| `CONFIG_URL` | the pinned gist raw URL | Where the Worker fetches the JSON server list |

Sampling runs once per minute, so `sampleIntervalSeconds` is fixed at `60`.

## D1 setup

Create the database once:

```bash
npx wrangler d1 create serverstatus
```

Copy the returned `database_id` into the `d1_databases` section of
`src/server/wrangler.jsonc`.

The Worker creates the table automatically on first use. You can also apply
the included migration explicitly:

```bash
npm run db:migrate:remote
```

Cron triggers are declared in `wrangler.jsonc` and deploy automatically:

- `* * * * *` — sample every check
- `0 3 * * *` — prune old samples

## Tests

```bash
npm test
```

Tests cover badge URL parsing, badge response handling, sample recording,
uptime aggregation, daily bucket shaping, config parsing, and status payload
assembly.

## Deployment

The client and Worker deploy separately. Set up D1 first (see
[D1 setup](#d1-setup)).

### Worker (Cloudflare Workers)

```bash
npm run deploy:server
```

The Worker is named `serverstatus-api` in `wrangler.jsonc`. Add a custom domain
or route there if you do not want to use the `*.workers.dev` URL.

### Client (Cloudflare Pages)

1. Set `apiBaseUrl` in `src/client/config.json` to the Worker's API base, for
   example `https://serverstatus-api.<account>.workers.dev/api`.
2. Set the Worker's `ALLOWED_ORIGINS` to the Pages origin.
3. Build and deploy:

```bash
npm run build
```

Upload `src/client/dist` to Cloudflare Pages, or connect the repository and
use:

- Build command: `npm run build`
- Output directory: `src/client/dist`
- Root directory: repository root

If the Worker is routed under the same domain (for example
`status.example.com/api/*`), leave `apiBaseUrl` as `/api`.

## Known limitations

- **History starts when the Worker is deployed.** The 28-day percentage fills
  in over time; before that it reflects the samples collected so far.
- Sampling is once per minute, so outages shorter than a minute can be missed.
- The public badge JSON only exposes `up`, `late`, and `down`. Paused or new
  checks are reported as `up` by Healthchecks' badge endpoint.
- Each check writes one D1 row per minute: 1,440 rows/day per check. This is
  well within the D1 free-plan write limit for a small number of checks.
- The Workers Cache API is per data center. With a globally distributed
  audience, each location may refresh independently.
- Uptime reflects the Worker's sampling of Healthchecks' public status, not
  independent network probes.
