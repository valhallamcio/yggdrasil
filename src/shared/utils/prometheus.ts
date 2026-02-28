export interface PlayerLatency {
  latencyP95: number;
  latencyAvg: number;
  latencyMin: number;
  latencyMax: number;
}

export interface ParsedMetrics {
  /** Server display name → list of player usernames */
  players: Map<string, string[]>;
  /** Player username → latency data */
  latency: Map<string, PlayerLatency>;
}

/**
 * Parses Prometheus text exposition format and extracts player-related metrics.
 *
 * Extracts from:
 *  - `bungeecord_online_player{server="...",player="..."}` — online player per server
 *  - `bungeecord_online_player_latency{name="...",quantile="..."}` — per-player latency quantiles
 *  - `bungeecord_online_player_latency_count{name="..."}` / `_sum` — for average
 */
export function parsePlayerMetrics(text: string): ParsedMetrics {
  const players = new Map<string, string[]>();
  const latency = new Map<string, PlayerLatency>();

  // Intermediate storage for latency computation
  const quantiles = new Map<string, { p50: number; p95: number; p99: number }>();
  const counts = new Map<string, number>();
  const sums = new Map<string, number>();

  const lines = text.split('\n');

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;

    // bungeecord_online_player{server="...",player="..."} 1.0
    if (line.startsWith('bungeecord_online_player{')) {
      const serverMatch = line.match(/server="([^"]*)"/);
      const playerMatch = line.match(/player="([^"]*)"/);
      const valueMatch = line.match(/\}\s+([\d.]+)/);

      if (!serverMatch || !playerMatch || !valueMatch) continue;

      const server = serverMatch[1]!;
      const player = playerMatch[1]!;
      const value = parseFloat(valueMatch[1]!);

      if (!player || value === 0) continue;

      let list = players.get(server);
      if (!list) {
        list = [];
        players.set(server, list);
      }
      list.push(player);
      continue;
    }

    // bungeecord_online_player_latency{name="...",quantile="..."} 12.0
    if (line.startsWith('bungeecord_online_player_latency{')) {
      const nameMatch = line.match(/name="([^"]*)"/);
      const quantileMatch = line.match(/quantile="([^"]*)"/);
      const valueMatch = line.match(/\}\s+([\d.eE+-]+)/);

      if (!nameMatch || !quantileMatch || !valueMatch) continue;

      const name = nameMatch[1]!;
      const quantile = quantileMatch[1]!;
      const value = parseFloat(valueMatch[1]!);

      let q = quantiles.get(name);
      if (!q) {
        q = { p50: 0, p95: 0, p99: 0 };
        quantiles.set(name, q);
      }

      if (quantile === '0.5') q.p50 = value;
      else if (quantile === '0.95') q.p95 = value;
      else if (quantile === '0.99') q.p99 = value;
      continue;
    }

    // bungeecord_online_player_latency_count{name="..."} 130442.0
    if (line.startsWith('bungeecord_online_player_latency_count{')) {
      const nameMatch = line.match(/name="([^"]*)"/);
      const valueMatch = line.match(/\}\s+([\d.eE+-]+)/);
      if (nameMatch && valueMatch) {
        counts.set(nameMatch[1]!, parseFloat(valueMatch[1]!));
      }
      continue;
    }

    // bungeecord_online_player_latency_sum{name="..."} 3789445.0
    if (line.startsWith('bungeecord_online_player_latency_sum{')) {
      const nameMatch = line.match(/name="([^"]*)"/);
      const valueMatch = line.match(/\}\s+([\d.eE+-]+)/);
      if (nameMatch && valueMatch) {
        sums.set(nameMatch[1]!, parseFloat(valueMatch[1]!));
      }
      continue;
    }
  }

  // Combine quantiles + count/sum into PlayerLatency
  for (const [name, q] of quantiles) {
    const count = counts.get(name) ?? 0;
    const sum = sums.get(name) ?? 0;
    const avg = count > 0 ? Math.round((sum / count) * 100) / 100 : 0;

    latency.set(name, {
      latencyP95: q.p95,
      latencyAvg: avg,
      latencyMin: q.p50,
      latencyMax: q.p99,
    });
  }

  return { players, latency };
}
