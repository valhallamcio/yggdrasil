# Yggdrasil

Central REST API hub for the ValhallaMC Minecraft network. Aggregates data from MongoDB, Pterodactyl game panel, and Velocity proxy metrics into a unified API with real-time WebSocket streaming and Discord integration.

## Tech Stack

- **Runtime:** Node.js + TypeScript (ESM, `NodeNext` module resolution)
- **Framework:** Express 4
- **Database:** MongoDB (native driver)
- **Validation:** Zod (config + request schemas)
- **Logging:** Pino (structured JSON logs)
- **Scheduling:** node-cron
- **Plugins:** Discord.js, ws (WebSocket)

## Getting Started

### Prerequisites

- Node.js 20+
- MongoDB instance
- Pterodactyl panel (for server management features)
- Velocity proxy with Prometheus metrics (for player tracking)

### Installation

```bash
npm install
```

### Environment Variables

Create a `.env` file in the project root. Required variables are marked with **bold**.

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `PORT` | `3000` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| **`MONGODB_URI`** | — | MongoDB connection URL |
| **`MONGODB_DB_NAME`** | — | MongoDB database name |
| **`JWT_SECRET`** | — | Min 32-char secret for JWT signing |
| `API_KEY_HEADER` | `X-API-Key` | Header name for API key auth |
| `API_KEYS` | `""` | Comma-separated valid API keys |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `LOG_PRETTY` | `false` | Human-readable log output |
| `RATE_LIMIT_WINDOW_MS` | `900000` | Rate limit window (ms) |
| `RATE_LIMIT_MAX` | `100` | Max requests per window |
| `PTERODACTYL_URL` | — | Pterodactyl panel base URL |
| `PTERODACTYL_API_KEY` | — | Pterodactyl client API key |
| `VELOCITY_METRICS_URL` | — | Velocity Prometheus metrics endpoint |
| `PLUGIN_DISCORD` | `false` | Enable Discord plugin |
| `PLUGIN_WEBSOCKET` | `false` | Enable WebSocket plugin |
| `DISCORD_TOKEN` | — | Discord bot token |
| `DISCORD_CLIENT_ID` | — | Discord application client ID |
| `DISCORD_GUILD_ID` | — | Discord server/guild ID |
| `DISCORD_DONATIONS_CHANNEL_ID` | — | Channel for donation announcements |
| `DISCORD_DONATIONS_LOG_CHANNEL_ID` | — | Channel for detailed donation logs |
| `DISCORD_SCREENSHOT_CHANNEL_ID` | — | Channel to scrape showcase screenshots from |
| `DISCORD_SERVER_STATUS_CHANNEL_ID` | — | Channel for crash/recovery notifications |
| `KOFI_VERIFICATION_TOKEN` | — | Ko-fi webhook verification token |
| `PATREON_WEBHOOK_SECRET` | — | Patreon webhook HMAC secret |

### Running

```bash
# Development (with hot reload via tsx + nodemon)
npm run dev

# Production
npm run build
npm start
```

### Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled output |
| `npm run lint` | Run ESLint |
| `npm run format` | Run Prettier |
| `npm run typecheck` | Type-check without emitting |

## Project Structure

```
src/
├── main.ts                    # Bootstrap entry point
├── app.ts                     # Express app factory (pure, no I/O)
├── config/                    # Zod-validated env config
│   └── schema.ts
├── core/
│   ├── database/              # MongoDB client singleton
│   ├── event-bus/             # Typed EventEmitter for internal events
│   ├── logger/                # Pino logger
│   ├── scheduler/             # Cron job registry
│   │   └── jobs/              # Individual scheduled jobs
│   └── graceful-shutdown.ts
├── domains/
│   ├── servers/               # Server metadata, Pterodactyl integration, stats
│   ├── players/               # Player profiles, metrics, sessions, analytics
│   ├── showcase/              # Screenshot gallery from Discord
│   └── donations/             # Ko-fi & Patreon webhook processing
├── middleware/
│   ├── auth/                  # JWT & API key authentication
│   ├── validate.ts            # Zod request validation
│   ├── error-handler.ts       # Global error handler
│   ├── request-id.ts          # X-Request-Id propagation
│   └── not-found.ts           # 404 handler
├── plugins/
│   ├── discord/               # Discord bot integration
│   └── websocket/             # WebSocket server
├── repositories/
│   └── base.repository.ts     # Generic CRUD base class
├── router/
│   └── api/v1/                # v1 API route mounting
└── shared/
    ├── errors/                # AppError hierarchy
    └── utils/                 # Helpers (async handler, pagination, etc.)
```

Each domain follows the pattern: `types` → `schema` → `repository` → `service` → `controller` → `router`.

## API Reference

Base path: `/v1`

Health check: `GET /health` (returns 200 or 503)

### Servers `/v1/servers`

| Method | Path | Auth | Query Params | Description |
|---|---|---|---|---|
| GET | `/` | Optional | — | List servers (public or full stats view) |
| GET | `/:server` | Optional | — | Get single server |
| GET | `/:server/history` | API Key | `from` (required), `to` (optional, default: now) | Stats time-series history |
| POST | `/:server/command` | API Key | — | Send console command via Pterodactyl |
| POST | `/:server/power` | API Key | — | Power action (start/stop/restart/kill) |
| GET | `/:server/files` | API Key | `directory` (optional, default: `/`) | List files on server |
| GET | `/:server/files/contents` | API Key | `file` (required) | Read file contents |
| POST | `/:server/files/contents` | API Key | `file` (required) | Write file contents |
| GET | `/:server/logs` | API Key | `lines` (optional, default: `100`, max: 5000) | Tail console log |
| GET | `/registry` | API Key | — | List server registry entries |
| GET | `/registry/:server` | API Key | — | Get registry entry |

### Players `/v1/players`

| Method | Path | Auth | Query Params | Description |
|---|---|---|---|---|
| GET | `/` | Optional | — | List online players |
| GET | `/history` | API Key | `from` (required), `to` (optional, default: now), `server` (optional) | Player count time-series |
| GET | `/analytics` | API Key | `server` (optional) | Full analytics (peaks, retention, cohorts, etc.) |
| GET | `/search` | API Key | `q` (required, min: 2), `limit` (optional, default: `20`, max: 100) | Search players by username |
| GET | `/leaderboard` | Optional | `sort` (required: `playtime` \| `first_seen`), `tag` (optional), `limit` (optional, default: `20`, max: 100) | Player leaderboard |
| GET | `/:nick` | Optional | — | Player profile |
| GET | `/:nick/skin` | None | `size` (optional, default: `128`, range: 8–512) | Skin image proxy |
| GET | `/:nick/:tag/stats` | API Key | — | Per-server player stats |
| PUT | `/:nick/:tag/stats` | API Key | — | Update player stats |
| GET | `/:nick/:tag/inventory` | API Key | — | Player inventory |
| PUT | `/:nick/:tag/inventory` | API Key | — | Update inventory |
| GET | `/:nick/:tag/position` | API Key | — | Player position |
| PUT | `/:nick/:tag/position` | API Key | — | Update position |
| GET | `/:nick/:tag/advancements` | API Key | — | Player advancements |

### Showcase `/v1/showcase`

| Method | Path | Auth | Query Params | Description |
|---|---|---|---|---|
| GET | `/` | None | `count` (optional, default: `6`, max: 50) | List showcase posts |
| POST | `/refresh` | API Key | — | Trigger manual cache refresh |

### Donations `/v1/donations`

| Method | Path | Auth | Query Params | Description |
|---|---|---|---|---|
| POST | `/kofi` | None | — | Ko-fi webhook (token-verified) |
| POST | `/patreon` | None | — | Patreon webhook (HMAC-verified) |

## Plugins

Plugins are loaded conditionally when their `PLUGIN_*` env var is set to `true`.

### Discord (`PLUGIN_DISCORD`)

Runs a Discord.js bot that subscribes to internal events:

- **Donation relay** — forwards donation events to configured channels with formatted embeds
- **Server status** — sends crash/recovery/crash-loop notifications to a status channel
- **Showcase scraping** — provides the Discord API access for the showcase domain to fetch screenshots

Requires: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_GUILD_ID`, and relevant channel ID variables.

### WebSocket (`PLUGIN_WEBSOCKET`)

Attaches a WebSocket server to the HTTP server. Clients authenticate via `?token=` query parameter (API key).

**Broadcasted events:** `server.stats`, `server.state.changed`, `server.crashed`, `server.recovered`, `player.joined`, `player.left`, `player.server.changed`, `player.list.updated`

**Client commands:** `console.subscribe` / `console.unsubscribe` for per-server console streaming.

## Scheduler Jobs

| Job | Schedule | Description |
|---|---|---|
| `showcase-refresh` | Every 60 min | Refreshes showcase screenshot cache from Discord |
| `server-sync` | Every 10 min | Syncs server registry, deactivates missing servers, refreshes Pterodactyl WS connections |

Both jobs also run once at startup (`onInit`).

## Development Guide

### Adding a New Domain

1. Create `src/domains/<name>/` with the following files:
   - `<name>.types.ts` — TypeScript interfaces and types
   - `<name>.schema.ts` — Zod validation schemas
   - `<name>.repository.ts` — Data access layer (extend `BaseRepository` from `src/repositories/base.repository.ts`)
   - `<name>.service.ts` — Business logic
   - `<name>.controller.ts` — Request handlers (use `asyncHandler` from `src/shared/utils/`)
   - `<name>.router.ts` — Express router
2. Mount the router in `src/router/api/v1/index.ts`

See `src/domains/example/` for a reference implementation.

### Adding a New Plugin

1. Create `src/plugins/<name>/index.ts` implementing the `Plugin` interface (`init(app, server)` + `shutdown()`)
2. Add `PLUGIN_<NAME>=false` to `src/config/schema.ts`
3. Add conditional dynamic import in `src/plugins/index.ts`

### Adding a Scheduler Job

1. Create `src/core/scheduler/jobs/<name>.job.ts` implementing the `ScheduledJob` interface
2. Self-register via `schedulerRegistry.register(new MyJob())` at module load
3. Add a side-effect import in `src/main.ts`
