// The r2t-serve servers opened before (their base URLs …/TOKEN/), kept in the browser:
// most recent first, at most MAX, one entry per URL. r2t-serve keeps its token until a
// reboot (or --new-token), so a base URL stays valid across server restarts.

export interface SavedServer { url: string; lastUsed: number }

const KEY = 'r2vis.servers.v1'
const MAX = 10

export function loadServers(): SavedServer[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return v.filter((s): s is SavedServer => !!s && typeof s.url === 'string' && typeof s.lastUsed === 'number')
      .sort((a, b) => b.lastUsed - a.lastUsed).slice(0, MAX)
  } catch {
    return []
  }
}

function save(list: SavedServer[]): SavedServer[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // storage unavailable: the list is not kept
  }
  return list
}

/** Adds (or moves to the front) a server that opened. */
export function addServer(url: string): SavedServer[] {
  return save([{ url, lastUsed: Date.now() }, ...loadServers().filter((s) => s.url !== url)].slice(0, MAX))
}

export function removeServer(url: string): SavedServer[] {
  return save(loadServers().filter((s) => s.url !== url))
}

/** host:port and the start of the token: "127.0.0.1:8765 · CCm5…". */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url)
    const token = u.pathname.split('/').filter(Boolean)[0] ?? ''
    return `${u.host} · ${token.slice(0, 4)}…`
  } catch {
    return url
  }
}
