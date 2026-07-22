// Shared-household sync: stores the full dataset as one JSON blob per secret code.
// Backed by Upstash Redis (Vercel marketplace integration). The code is the capability:
// anyone who has it can read/write that household's data — treat it like a password.
// The code travels in the x-sync-code header (GET) or JSON body (POST), never in the
// URL, so it stays out of access logs, browser history, and Referer headers.

const CODE_RE = /^hj-[a-z0-9]{16,64}$/;
const MAX_BYTES = 900 * 1024; // stay under Upstash's 1MB value limit
const TTL_SECONDS = 60 * 60 * 24 * 365; // refreshed on every write

// Compare-and-set write: only store when the caller's baseRev matches the current
// revision, then bump it. Prevents two devices' read-merge-write cycles from
// silently overwriting each other.
const CAS_LUA = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '0')
if cur ~= tonumber(ARGV[2]) then return -1 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[3]))
local rev = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
return rev
`;

// Best-effort per-instance rate limiting: free and enough to stop naive
// brute-force loops; resets on cold start by design.
const hits = new Map();
function rateLimited(ip) {
  const win = Math.floor(Date.now() / 60000);
  const k = `${ip}:${win}`;
  const n = (hits.get(k) || 0) + 1;
  hits.set(k, n);
  if (hits.size > 5000) hits.clear();
  return n > 120;
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

async function redis(cfg, command) {
  const r = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  if (!r.ok) throw new Error(`redis: status ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`redis: ${j.error}`);
  return j.result;
}

export default async function handler(req, res) {
  const cfg = redisConfig();
  if (!cfg) return res.status(503).json({ error: "not_configured" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "rate_limit" });

  const code = req.method === "GET" ? req.headers["x-sync-code"] : req.body && req.body.code;
  if (!code || !CODE_RE.test(code)) return res.status(400).json({ error: "invalid_code" });
  const key = `husjakt:sync:${code}`;
  const revKey = `${key}:rev`;

  try {
    if (req.method === "GET") {
      const [raw, rev] = await Promise.all([redis(cfg, ["GET", key]), redis(cfg, ["GET", revKey])]);
      return res.json({ data: raw ? JSON.parse(raw) : null, rev: Number(rev) || 0 });
    }
    if (req.method === "POST") {
      const { data, baseRev } = req.body;
      if (!data || typeof data !== "object") return res.status(400).json({ error: "missing_data" });
      const blob = JSON.stringify(data);
      if (blob.length > MAX_BYTES) return res.status(413).json({ error: "too_large" });
      const rev = await redis(cfg, ["EVAL", CAS_LUA, "2", key, revKey,
        blob, String(Number(baseRev) || 0), String(TTL_SECONDS)]);
      if (rev === -1) return res.status(409).json({ error: "conflict" });
      return res.json({ ok: true, rev: Number(rev) });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Sync error:", e.message);
    return res.status(500).json({ error: "server_error" });
  }
}
