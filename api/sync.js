// Shared-household sync: stores the full dataset as one JSON blob per secret code.
// Backed by Upstash Redis (Vercel marketplace integration). The code is the capability:
// anyone who has it can read/write that household's data — treat it like a password.

const CODE_RE = /^hj-[a-z0-9]{12,64}$/;
const MAX_BYTES = 900 * 1024; // stay under Upstash's 1MB value limit
const TTL_SECONDS = 60 * 60 * 24 * 365; // refreshed on every write

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

  const code = req.method === "GET" ? req.query.code : req.body && req.body.code;
  if (!code || !CODE_RE.test(code)) return res.status(400).json({ error: "invalid_code" });
  const key = `husjakt:sync:${code}`;

  try {
    if (req.method === "GET") {
      const raw = await redis(cfg, ["GET", key]);
      return res.json({ data: raw ? JSON.parse(raw) : null });
    }
    if (req.method === "POST") {
      const { data } = req.body;
      if (!data || typeof data !== "object") return res.status(400).json({ error: "missing_data" });
      const blob = JSON.stringify(data);
      if (blob.length > MAX_BYTES) return res.status(413).json({ error: "too_large" });
      await redis(cfg, ["SET", key, blob, "EX", String(TTL_SECONDS)]);
      return res.json({ ok: true });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("Sync error:", e.message);
    return res.status(500).json({ error: e.message || "Internal server error" });
  }
}
