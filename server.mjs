// CANguesser — quiz, leaderboard API (SQLite), and one Zarr store per event built from
// the CAN Zarr stores (HEALPix) listed in the CAN STAC catalogue.
import http from "node:http";
import dns from "node:dns";
import { readFile, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 3099);
const DB_PATH = process.env.DB_PATH || "/data/scores.db";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";      // enables DELETE /api/scores/:id
const MAX_SCORE = 8000;                                  // 8 rounds × 1000
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, "public");
dns.setDefaultResultOrder("ipv4first");                   // containers often lack IPv6 routes
const LIVE = !/^(0|false|off|no)$/i.test(process.env.LIVE_DATA || "1");
const STAC_ROOT = process.env.STAC_ROOT || "https://can.eumetsat.int/stac/";
const TS_NSIDE = Number(process.env.TS_NSIDE || 256);     // resolution used for the regional time series
const MAP_NSIDE = Number(process.env.MAP_NSIDE || 256);   // resolution used for the anomaly maps
const HEALPIX_ORDER = process.env.HEALPIX_ORDER || "";    // "nested" | "ring" to override the store attributes
const REFRESH_HOURS = Number(process.env.REFRESH_HOURS || 24);
const EVENTS_DIR = process.env.EVENTS_DIR || path.join(path.dirname(DB_PATH), "events");  // live event stores
const SNAPSHOT_DIR = path.join(PUBLIC, "events");                                         // bundled fallback stores

// ------------------------------------------------------------------ database
mkdirSync(path.dirname(DB_PATH), { recursive: true });
let db;
try {
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
} catch (e) {
  console.error(`Cannot open the scores database at ${DB_PATH}: ${e.message}`);
  if (/full/i.test(e.message)) console.error("The disk holding /data is full. On Docker Desktop or OrbStack this is usually the VM disk: free space with `docker system df` and `docker builder prune` (don't prune volumes, the scores live there).");
  process.exit(1);
}
db.exec(`
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND ${MAX_SCORE}),
    mode       TEXT    NOT NULL CHECK (mode IN ('noob', 'expert')),
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS scores_mode_score ON scores (mode, score DESC, id);
`);
const qTop = db.prepare("SELECT id, name, score, mode, created_at FROM scores WHERE mode = ? ORDER BY score DESC, id ASC LIMIT ?");
const qInsert = db.prepare("INSERT INTO scores (name, score, mode) VALUES (?, ?, ?)");
const qRank = db.prepare("SELECT COUNT(*) AS above FROM scores WHERE mode = ? AND (score > ? OR (score = ? AND id < ?))");
const qDelete = db.prepare("DELETE FROM scores WHERE id = ?");

// ------------------------------------------------------------------ helpers
const send = (res, code, body, headers = {}) => {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": typeof body === "object" && !Buffer.isBuffer(body) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(data);
};
const cleanName = (s) => String(s ?? "").normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);

function readJson(req, limit = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Body too large"), { code: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(Object.assign(new Error("Invalid JSON"), { code: 400 })); } });
    req.on("error", reject);
  });
}

// simple per-IP limit on new scores (default 60 per 10 minutes; venues often share one address)
const RATE_LIMIT = Math.max(1, Number(process.env.RATE_LIMIT || 60));
const hits = new Map();
function allowPost(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  if (arr.length >= RATE_LIMIT) { hits.set(ip, arr); return false; }
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < win)) hits.delete(k);
  return true;
}
const clientIp = (req) => (process.env.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

async function serveFile(res, root, rel, cacheControl) {
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root + path.sep)) return send(res, 403, "Forbidden");
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, "Not found");
    const body = await readFile(file);
    const ext = path.extname(file);
    send(res, 200, body, {
      "Content-Type": file.endsWith("zarr.json") ? "application/json" : TYPES[ext] || "application/octet-stream",
      "Cache-Control": cacheControl ?? (ext === ".html" ? "no-cache" : "public, max-age=3600"),
    });
  } catch { send(res, 404, "Not found"); }
}
const serveStatic = (req, res, urlPath) => {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith("/")) rel += "index.html";
  return serveFile(res, PUBLIC, rel);
};

// zarrita for the browser, served from node_modules (versions pinned by package-lock.json)
// and mapped by the import map in index.html. The page needs no build step.
const VENDOR = {
  zarrita: path.join(HERE, "node_modules/zarrita/dist/src"),
  "zarrita-storage": path.join(HERE, "node_modules/@zarrita/storage/dist/src"),
};

// ------------------------------------------------------------------ live data
// Each event's data is built by streaming only the needed chunks of the CAN Zarr stores
// (nothing is downloaded whole) and written as its own small Zarr store in EVENTS_DIR.
// The browser reads events/<k>.zarr when a round starts: the live store if there is
// one, otherwise the bundled snapshot in public/events/.
const EVENTS = JSON.parse(readFileSync(path.join(PUBLIC, "events.json"), "utf8"));
const KEYS = new Set(EVENTS.map((e) => e.k));
const live = { status: LIVE ? "starting" : "disabled", built: null, seconds: null, stacRoot: STAC_ROOT, events: [], errors: {}, lastError: null };
const { listEventStores } = await import("./lib/event-store.mjs");
async function scanStores() {
  const stores = await listEventStores(EVENTS_DIR);
  live.events = [...stores.keys()].filter((k) => KEYS.has(k));
  live.built = [...stores.values()].map((a) => a.built).filter(Boolean).sort().at(-1) || null;
}
await scanStores();
if (live.events.length) {
  live.status = "stored";
  console.log(`[can] ${live.events.length} event stores in ${EVENTS_DIR} (latest ${live.built})`);
}

function serveEventStore(res, k, key) {
  const own = path.join(EVENTS_DIR, `${k}.zarr`);
  const root = existsSync(path.join(own, "zarr.json")) ? own : path.join(SNAPSHOT_DIR, `${k}.zarr`);
  return serveFile(res, root, key, "no-cache");     // rebuilt daily: always revalidate
}

let building = false, retries = 0;
async function refresh() {
  if (!LIVE || building) return;
  building = true;
  if (!live.events.length) live.status = "building";
  try {
    const { buildAll } = await import("./lib/can-zarr.mjs");
    const r = await buildAll(EVENTS, { stacRoot: STAC_ROOT, tsNside: TS_NSIDE, mapNside: MAP_NSIDE, orderOverride: HEALPIX_ORDER || undefined, outDir: EVENTS_DIR });
    if (r.events.length) {
      await scanStores();
      Object.assign(live, { status: "live", built: r.built, seconds: r.seconds, errors: r.errors, lastError: null });
    } else {
      Object.assign(live, { status: live.events.length ? live.status : "failed", errors: r.errors, lastError: "no event could be built" });
    }
    console.log(`[can] built ${r.events.length}/${EVENTS.length} events in ${r.seconds} s`);
  } catch (e) {
    const c = e.cause;
    live.lastError = String(e.message || e) + (c ? ` (${c.code || ""} ${c.message || c})`.replace("( ", "(") : "");
    if (!live.events.length) live.status = "failed";
    console.error("[can] refresh failed:", live.lastError);
  } finally {
    building = false;
    // nothing live yet (CAN unreachable at start-up?): try again soon rather than in REFRESH_HOURS
    if (!live.events.length) {
      retries++;
      const wait = Math.min(15 * 60, 30 * 2 ** (retries - 1));   // 30 s, 1, 2, 4, 8, then every 15 min
      console.log(`[can] no live data yet, retrying in ${wait} s`);
      setTimeout(refresh, wait * 1000).unref();
    }
  }
}
if (LIVE) {
  const stale = !live.built || Date.now() - Date.parse(live.built) > REFRESH_HOURS * 3600e3;
  if (stale) setTimeout(refresh, 1000);
  if (REFRESH_HOURS > 0) setInterval(refresh, REFRESH_HOURS * 3600e3).unref();
}

// ------------------------------------------------------------------ routes
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });

    if (url.pathname === "/api/events/status" && req.method === "GET") {
      return send(res, 200, { ...live, count: live.events.length, total: EVENTS.length, building, refreshHours: REFRESH_HOURS, nside: [TS_NSIDE, MAP_NSIDE] }, { "Cache-Control": "no-store" });
    }
    const ez = url.pathname.match(/^\/events\/([A-Za-z0-9]+)\.zarr\/(.+)$/);
    if (ez && (req.method === "GET" || req.method === "HEAD")) {
      if (!KEYS.has(ez[1])) return send(res, 404, "Not found");
      return serveEventStore(res, ez[1], decodeURIComponent(ez[2]));
    }
    const vd = url.pathname.match(/^\/vendor\/([a-z-]+)\/(.+\.js)$/);
    if (vd && VENDOR[vd[1]] && (req.method === "GET" || req.method === "HEAD")) {
      return serveFile(res, VENDOR[vd[1]], decodeURIComponent(vd[2]));
    }
    if (url.pathname === "/api/events/refresh" && req.method === "POST") {
      if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return send(res, 401, { error: "Not allowed." });
      refresh();
      return send(res, 202, { building: true });
    }

    if (url.pathname === "/api/scores" && req.method === "GET") {
      const mode = url.searchParams.get("mode") === "expert" ? "expert" : "noob";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 10));
      return send(res, 200, { mode, scores: qTop.all(mode, limit) }, { "Cache-Control": "no-store" });
    }

    if (url.pathname === "/api/scores" && req.method === "POST") {
      if (!allowPost(clientIp(req))) return send(res, 429, { error: "Too many scores from this address. Try again in a few minutes." });
      const b = await readJson(req);
      const name = cleanName(b.name);
      const score = Number(b.score);
      const mode = b.mode;
      if (!name) return send(res, 400, { error: "Type a name to save your score." });
      if (!Number.isInteger(score) || score < 0 || score > MAX_SCORE || score % 500 !== 0) return send(res, 400, { error: "That score is not possible in this quiz." });
      if (mode !== "noob" && mode !== "expert") return send(res, 400, { error: "Unknown mode." });
      const { lastInsertRowid } = qInsert.run(name, score, mode);
      const id = Number(lastInsertRowid);
      const rank = qRank.get(mode, score, score, id).above + 1;
      return send(res, 201, { id, rank });
    }

    const del = url.pathname.match(/^\/api\/scores\/(\d+)$/);
    if (del && req.method === "DELETE") {
      if (!ADMIN_TOKEN || req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) return send(res, 401, { error: "Not allowed." });
      const { changes } = qDelete.run(Number(del[1]));
      return send(res, changes ? 200 : 404, { deleted: changes });
    }

    if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found." });
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    const code = e.code === 413 || e.code === 400 ? e.code : 500;
    if (code === 500) console.error(e);
    send(res, code, { error: code === 500 ? "Server error." : e.message });
  }
});

server.listen(PORT, () => console.log(`CANguesser on :${PORT}, database ${DB_PATH}`));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
