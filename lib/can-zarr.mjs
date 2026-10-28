// Streams EUMETSAT CAN climate anomalies and normals from the Zarr stores listed
// in the CAN STAC catalogue, and writes the data each quiz event needs into its own
// small Zarr store (lib/event-store.mjs), which the browser reads when the round starts.
//
// Store layout (as published): dims (time, cells) on a HEALPix grid, one data
// variable such as swi3_anomaly(time, cells), a <name>_std(cells) variable and a
// scalar `healpix` grid-mapping variable. Several resolutions exist (hp128 ... hp1024),
// each as a map-optimised ("geo-optimized") and a time-series-optimised copy.
// Nothing is downloaded whole: only the chunks covering an event are fetched.

import * as zarr from "zarrita";
import * as HP from "@hscmap/healpix";
import { regionMask } from "./regions.mjs";
import { writeEventStore } from "./event-store.mjs";
import { deriveEvent } from "../public/event-data.js";

const VAR_COLLECTION = {
  swi: "rzsm",
  sdu: "duration_of_sunshine",
  sis: "surface_downwelling_shortwave_flux_in_air",
  ice: "sea_ice_area_fraction",
};
// What the event stores hold, in display units (soil moisture and sea ice in percentage points).
const DESCR = {
  swi: { long_name: "Root-zone soil moisture anomaly (H SAF, layer 28-100 cm)", units: "percentage points (soil wetness index x 100)",
    normal_long_name: "Root-zone soil wetness climate normal 1991-2020", normal_units: "% (soil wetness index x 100)" },
  sdu: { long_name: "Sunshine duration anomaly (CM SAF SARAH-3)", units: "h",
    normal_long_name: "Monthly sunshine duration climate normal 1991-2020", normal_units: "h" },
  sis: { long_name: "Surface downwelling shortwave radiation anomaly (CM SAF SARAH-3)", units: "W m-2",
    normal_long_name: "Surface downwelling shortwave radiation climate normal 1991-2020", normal_units: "W m-2" },
  ice: { long_name: "Sea ice concentration anomaly (OSI SAF)", units: "percentage points",
    normal_long_name: "Sea ice concentration climate normal 1991-2020", normal_units: "%" },
};
const DEG = Math.PI / 180;

const log = (...a) => console.log("[can]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (url) => String(url).split("?")[0].split("/").slice(-2).join("/");

// ------------------------------------------------------------------ HTTP
// Every Zarr key under /data/ costs one request to can.eumetsat.int, which answers with a
// redirect to a presigned S3 URL. CAN allows about 200 of those per rolling minute per
// client (measured 28 Oct 2026: a burst of ~210, then ~3.3/s) and answers the rest with
// 429 and no Retry-After. A full build needs far more than 200, so all requests share
// one pacer, and 429s, 5xx and network errors are retried with backoff.
// CAN_RATE = requests per second (0 = unpaced, e.g. for the local replica).
const RATE = Number(process.env.CAN_RATE ?? 3);
const RETRY_WAITS = [2, 5, 10, 20, 40, 60, 60];            // seconds, ~3 min in total
let nextSlot = 0;
async function paced() {
  if (!(RATE > 0)) return;
  const now = Date.now(), at = Math.max(now, nextSlot);
  nextSlot = at + 1000 / RATE;
  if (at > now) await sleep(at - now);
}

/** GET with pacing and retries; the body is read inside the retry so dropped downloads are retried too. */
async function request(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    await paced();
    let why, wait = RETRY_WAITS[attempt], err;
    try {
      const r = await fetch(url, { headers });
      if (r.status !== 429 && r.status < 500) {
        return { status: r.status, ok: r.ok, body: new Uint8Array(await r.arrayBuffer()) };
      }
      await r.arrayBuffer().catch(() => {});
      why = `${r.status}`;
      const ra = Number(r.headers.get("retry-after"));
      if (ra > 0) wait = ra;
    } catch (e) {
      err = e; why = e.cause?.code || e.cause?.message || e.message;
    }
    if (attempt >= RETRY_WAITS.length) throw err || new Error(`${why} for ${url} after ${attempt + 1} tries`);
    log(`${why} for ${short(url)}, retry ${attempt + 1} in ${wait} s`);
    await sleep(wait * 1000);
  }
}

/** Read-only zarrita store over `request` (zarrita's FetchStore calls fetch directly). */
class CanStore {
  constructor(url) { this.url = url.endsWith("/") ? url : url + "/"; }
  async get(key) {
    const url = new URL(key.replace(/^\//, ""), this.url).href;
    const r = await request(url);
    if (r.status === 404) return undefined;                 // missing chunk = fill value
    if (!r.ok) throw new Error(`${r.status} for ${url}`);
    return r.body;
  }
}

// ------------------------------------------------------------------ STAC
async function getJson(url) {
  const r = await request(url, { Accept: "application/json" });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return JSON.parse(new TextDecoder().decode(r.body));
}

/** Walk catalog -> variable collection -> NORMALS/ANOMALIES -> Zarr assets. */
export async function discover(stacRoot) {
  const catUrl = new URL("catalog.json", stacRoot.endsWith("/") ? stacRoot : stacRoot + "/").href;
  const cat = await getJson(catUrl);
  const out = {};
  for (const [key, coll] of Object.entries(VAR_COLLECTION)) {
    const link = cat.links.find((l) => l.rel === "child" && (l.href.includes(`/${coll}.json`) || l.href.endsWith(`${coll}.json`)));
    if (!link) { log(`no STAC collection for ${key} (${coll})`); continue; }
    const collUrl = new URL(link.href, catUrl).href;
    const c = await getJson(collUrl);
    out[key] = {};
    for (const kind of ["anomalies", "normals"]) {
      const child = c.links.find((l) => l.rel === "child" && (String(l.title).toLowerCase() === kind || l.href.toLowerCase().includes(`/${kind}.json`)));
      if (!child) continue;
      const kidUrl = new URL(child.href, collUrl).href;
      const k = await getJson(kidUrl);
      const start = String(k.extent?.temporal?.interval?.[0]?.[0] || c.extent?.temporal?.interval?.[0]?.[0] || "").slice(0, 7) || null;
      out[key][kind] = Object.values(k.assets || {})
        .filter((a) => /zarr/i.test(a.type || "") || /\.zarr$/.test(a.href))
        .map((a) => {
          const m = /_hp(\d+)_/.exec(a.href) || /_hp(\d+)/.exec(a.title || "");
          const roles = a.roles || [];
          return {
            url: new URL(a.href, kidUrl).href,
            nside: m ? Number(m[1]) : null,
            flavour: roles.includes("time-optimized") || /_ts\.zarr$/.test(a.href) ? "ts" : "maps",
            start,
          };
        });
    }
  }
  return out;
}

function pickAsset(assets, flavour, nside) {
  const pool = (assets || []).filter((a) => a.flavour === flavour);
  const any = pool.length ? pool : assets || [];
  if (!any.length) return null;
  return any.slice().sort((a, b) => Math.abs((a.nside || 0) - nside) - Math.abs((b.nside || 0) - nside))[0];
}

// ------------------------------------------------------------------ stores
const STORES = new Map();

/** Open a store and describe it: data variable, HEALPix nside/ordering, months, value transform. */
export async function openStore(url, { orderOverride } = {}) {
  if (STORES.has(url)) return STORES.get(url);
  const p = (async () => {
    const store = await zarr.withConsolidated(new CanStore(url));
    const root = await zarr.open.v2(store, { kind: "group" });
    const items = store.contents().filter((c) => c.kind === "array").map((c) => c.path.replace(/^\//, ""));
    const arrays = {};
    for (const name of items) arrays[name] = await zarr.open.v2(root.resolve(name), { kind: "array" });
    const dims = (a) => a.attrs?._ARRAY_DIMENSIONS || [];
    const dataName = items.find((n) => {
      const d = dims(arrays[n]);
      return d.length === 2 && d[1] === "cells" && d[0] === "time" && !/_std$/.test(n);
    }) || items.find((n) => arrays[n].shape.length === 2 && !/_std$/.test(n));
    if (!dataName) throw new Error(`no (time, cells) variable in ${url}`);
    const arr = arrays[dataName];
    const [nt, ncell] = arr.shape;

    // HEALPix description: from the grid-mapping variable, then the data variable
    const gmName = arr.attrs.grid_mapping || (arrays.healpix ? "healpix" : items.find((n) => /healpix|crs/i.test(n)));
    const attrs = { ...(arrays[gmName]?.attrs || {}), ...arr.attrs };
    let nside = Number(attrs.healpix_nside ?? attrs.nside ?? (attrs.refinement_level != null ? 2 ** attrs.refinement_level : NaN));
    if (!Number.isFinite(nside)) nside = Math.round(Math.sqrt(ncell / 12));
    if (12 * nside * nside !== ncell) throw new Error(`cells ${ncell} is not a full HEALPix sphere (nside ${nside}) in ${url}`);
    let order = null;
    for (const [k, v] of Object.entries(attrs)) {
      if (/order|index|scheme|ordering/i.test(k) && typeof v === "string") {
        if (/nest/i.test(v)) order = "nested"; else if (/ring/i.test(v)) order = "ring";
      }
    }
    const orderSource = orderOverride ? "override" : order ? "attributes" : "default";
    order = orderOverride || order || "nested";

    // time axis -> "YYYY-MM"
    let months = [];
    const tName = items.find((n) => n === "time");
    if (tName) {
      const t = arrays[tName];
      const tv = await zarr.get(t);
      months = decodeTimes(Array.from(tv.data, Number), t.attrs.units || "days since 1970-01-01");
    }
    if (months.length !== nt) months = Array.from({ length: nt }, () => null);
    if (months.some((x) => x == null)) log(`time axis not decoded in ${url.split("/").pop()} (units ${JSON.stringify(tName ? arrays[tName].attrs.units : null)})`);

    // value transform
    const fill = [arr.attrs._FillValue, arr.attrs.missing_value, arr.fillValue].filter((x) => x != null && !Number.isNaN(Number(x))).map(Number);
    const scale = Number(arr.attrs.scale_factor ?? 1), offset = Number(arr.attrs.add_offset ?? 0);
    const units = String(arr.attrs.units || "");
    const info = { url, store, arr, dataName, nside, order, orderSource, months, fill, scale, offset, units,
      chunkT: arr.chunks[0], chunkC: arr.chunks[1], nt, ncell, gmAttrs: arrays[gmName]?.attrs || {} };
    log(`opened ${url.split("/").slice(-1)[0]}: ${dataName} ${nt}x${ncell} chunks ${arr.chunks} nside ${nside} ${order} (${orderSource})`);
    return info;
  })();
  STORES.set(url, p);
  p.catch(() => STORES.delete(url));
  return p;
}

// CF reference dates need not be zero-padded: the CM SAF stores use "hours since 1983-1-1 00:00:00".
// Any zone suffix is ignored (all CAN stores are UTC).
function parseRefDate(s) {
  const m = /^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.\d+)?)?)?/.exec(s.trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) : NaN;
}

function decodeTimes(vals, units) {
  const m = /^\s*(\w+)\s+since\s+(.+)$/i.exec(units || "");
  if (!m) return vals.map(() => null);
  const u = m[1].toLowerCase().replace(/s$/, "");
  const base = parseRefDate(m[2]);
  if (!Number.isFinite(base)) return vals.map(() => null);
  const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  if (u === "month" || u === "year") {
    const b = new Date(base);
    return vals.map((v) => ym(new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + Math.round(u === "year" ? v * 12 : v), 15))));
  }
  const mult = { day: 864e5, hour: 36e5, minute: 6e4, second: 1e3, millisecond: 1, microsecond: 1e-3, nanosecond: 1e-6 }[u];
  if (!mult) return vals.map(() => null);
  return vals.map((v) => ym(new Date(base + v * mult)));
}

// ------------------------------------------------------------------ HEALPix helpers
const ang2pix = (S, lon, lat) => (S.order === "ring" ? HP.ang2pix_ring : HP.ang2pix_nest)(S.nside, (90 - lat) * DEG, ((lon % 360) + 360) % 360 * DEG);
const CENTERS = new Map();
/** lon/lat of every cell centre for a grid (cached; nside 256 -> 786,432 cells). */
export function centers(nside, order) {
  const key = `${nside}/${order}`;
  if (!CENTERS.has(key)) {
    const n = 12 * nside * nside, lon = new Float32Array(n), lat = new Float32Array(n);
    const f = order === "ring" ? HP.pix2ang_ring : HP.pix2ang_nest;
    for (let i = 0; i < n; i++) {
      const { theta, phi } = f(nside, i);
      lat[i] = 90 - theta / DEG;
      // the library may return phi outside [0, 2π): wrap to [-180, 180)
      lon[i] = ((((phi / DEG) % 360) + 540) % 360) - 180;
    }
    CENTERS.set(key, { lon, lat });
  }
  return CENTERS.get(key);
}

// ------------------------------------------------------------------ chunk reading
const CHUNKS = new Map(); const CHUNK_MAX = 48;
async function chunk(S, ti, ci) {
  const key = `${S.url}|${ti}|${ci}`;
  if (CHUNKS.has(key)) { const v = CHUNKS.get(key); CHUNKS.delete(key); CHUNKS.set(key, v); return v; }
  const p = S.arr.getChunk([ti, ci]).then((c) => {
    const d = c.data, out = new Float32Array(d.length);
    for (let i = 0; i < d.length; i++) {
      let x = d[i];
      if (S.fill.includes(x)) x = NaN; else x = x * S.scale + S.offset;
      // undeclared sentinels in the CAN stores (-999, 9999); no variable here reaches |999|
      if (Math.abs(x) >= 999) x = NaN;
      out[i] = x;
    }
    return { data: out, shape: c.shape, stride: c.stride };
  });
  CHUNKS.set(key, p);
  if (CHUNKS.size > CHUNK_MAX) CHUNKS.delete(CHUNKS.keys().next().value);
  p.catch(() => CHUNKS.delete(key));
  return p;
}

async function pool(items, n, fn) {
  let i = 0; const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/** Mean over `cells` for every time step (NaN-aware). Reads only chunks that hold those cells. */
async function regionSeries(S, cells) {
  const byChunk = new Map();
  for (const c of cells) {
    const k = Math.floor(c / S.chunkC);
    if (!byChunk.has(k)) byChunk.set(k, []);
    byChunk.get(k).push(c - k * S.chunkC);
  }
  const sum = new Float64Array(S.nt), cnt = new Uint32Array(S.nt);
  const jobs = [];
  for (const [ci, local] of byChunk) for (let ti = 0; ti * S.chunkT < S.nt; ti++) jobs.push([ti, ci, local]);
  await pool(jobs, 6, async ([ti, ci, local]) => {
    const c = await chunk(S, ti, ci);
    const [st, sc] = c.stride;
    for (let t = 0; t < c.shape[0]; t++) {
      const T = ti * S.chunkT + t; if (T >= S.nt) break;
      for (const j of local) { const x = c.data[t * st + j * sc]; if (!Number.isNaN(x)) { sum[T] += x; cnt[T]++; } }
    }
  });
  return Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : null));
}

/** Values of the given cells averaged over the given time indices. */
export async function cellMean(S, cells, tIdx) {
  const uniq = [...new Set(cells)];
  const pos = new Map(uniq.map((c, i) => [c, i]));
  const sum = new Float64Array(uniq.length), cnt = new Uint16Array(uniq.length);
  const byChunk = new Map();
  for (const c of uniq) { const k = Math.floor(c / S.chunkC); if (!byChunk.has(k)) byChunk.set(k, []); byChunk.get(k).push(c); }
  const jobs = [];
  for (const T of tIdx) for (const ci of byChunk.keys()) jobs.push([T, ci]);
  await pool(jobs, 6, async ([T, ci]) => {
    const ti = Math.floor(T / S.chunkT), t = T - ti * S.chunkT;
    const c = await chunk(S, ti, ci);
    const [st, sc] = c.stride;
    for (const cell of byChunk.get(ci)) {
      const x = c.data[t * st + (cell - ci * S.chunkC) * sc];
      if (!Number.isNaN(x)) { const p = pos.get(cell); sum[p] += x; cnt[p]++; }
    }
  });
  return cells.map((c) => { const p = pos.get(c); return cnt[p] ? sum[p] / cnt[p] : NaN; });
}

// ------------------------------------------------------------------ per event
// Soil moisture and sea ice are shown in percentage points. Stores may hold them as
// fractions instead: the soil-moisture anomaly is published as "Index (-1 to 1)" while
// its collection unit is "Saturation (0-100%)". Decide per store, from the units first
// and the values second, and log the decision.
const PERCENT_VARS = new Set(["swi", "ice"]);
const FRACTION_UNITS = /(-\s*1\s*to\s*1)|(\b0\s*(-|to)\s*1\b)|fraction|index|^1$|^-$/i;
const PERCENT_UNITS = /%|percent|0\s*-\s*100/i;
const SCALE_LOGGED = new Set();
function displayScale(v, S, values) {
  if (!PERCENT_VARS.has(v)) return 1;
  const u = S.units.trim();
  let k, why;
  if (PERCENT_UNITS.test(u) && !FRACTION_UNITS.test(u)) { k = 1; why = `units "${u}"`; }
  else if (FRACTION_UNITS.test(u)) { k = 100; why = `units "${u}"`; }
  else if (v === "ice") { k = 1; why = "no units; OSI SAF concentration is in %"; }
  else {
    const m = Math.max(0, ...(values || []).filter((x) => x != null && !Number.isNaN(x)).map(Math.abs));
    k = m > 0 && m <= 1.01 ? 100 : 1; why = `no units, values up to ${m.toPrecision(3)}`;
  }
  const key = S.url;
  if (!SCALE_LOGGED.has(key)) { SCALE_LOGGED.add(key); log(`scale x${k} for ${S.url.split("/").pop()} (${why})`); }
  return k;
}

// If a store's time axis can't be decoded, number the months from the STAC temporal extent.
function monthsFromStac(S, a) {
  if (!S.months.some((x) => x == null)) return;
  if (!a.start) throw new Error(`no usable time axis in ${S.url.split("/").pop()}`);
  let [y, m] = a.start.split("-").map(Number);
  S.months = Array.from({ length: S.nt }, () => { const r = `${y}-${String(m).padStart(2, "0")}`; if (++m > 12) { m = 1; y++; } return r; });
  log(`time axis of ${S.url.split("/").pop()} taken from STAC: ${S.months[0]} to ${S.months.at(-1)}`);
}

/**
 * Read everything one event needs from CAN, in display units:
 * the region-mean anomaly for every month of the record, the region-mean normals,
 * and the event-period anomaly map on a lon/lat grid over the event box.
 */
export async function buildEvent(ev, assets, opts) {
  const A = assets[ev.v];
  if (!A?.anomalies?.length) throw new Error(`no anomaly assets for ${ev.v}`);
  const tsA = pickAsset(A.anomalies, "ts", opts.tsNside);
  const mapA = pickAsset(A.anomalies, "maps", opts.mapNside);
  const nmA = pickAsset(A.normals, "ts", opts.tsNside) || pickAsset(A.normals, "maps", opts.tsNside);
  const [TS, MP, NM] = await Promise.all([openStore(tsA.url, opts), openStore(mapA.url, opts), nmA ? openStore(nmA.url, opts) : null]);
  for (const [S, a] of [[TS, tsA], [MP, mapA]]) monthsFromStac(S, a);

  // region mean, full record
  const cells = regionMask(ev.region, centers(TS.nside, TS.order), ev.bbox);
  if (!cells.length) throw new Error(`no cells in region for ${ev.k}`);
  const raw = await regionSeries(TS, cells);
  const k = displayScale(ev.v, TS, raw);
  const series = Float32Array.from(raw, (x) => (x == null ? NaN : x * k));

  // normals (12 calendar months)
  const normal = new Float32Array(12).fill(NaN);
  if (NM) {
    const cN = NM.nside === TS.nside && NM.order === TS.order ? cells : regionMask(ev.region, centers(NM.nside, NM.order), ev.bbox);
    const nsRaw = await regionSeries(NM, cN);
    const kn = displayScale(ev.v, NM, nsRaw);
    for (let m = 0; m < 12; m++) {
      const i = NM.months.findIndex((s) => s && Number(s.slice(5, 7)) === m + 1);
      const x = nsRaw[i >= 0 ? i : m];
      if (x != null) normal[m] = x * kn;
    }
  }

  // anomaly map on a lon/lat grid over the event box (nearest HEALPix cell), mean over the event months
  const [x0, y0, x1, y1] = ev.bbox;
  const res = ev.v === "ice" ? 1 : Math.max(0.25, Math.round(Math.max(x1 - x0, y1 - y0) / 60 * 20) / 20);
  const W = Math.round((x1 - x0) / res), H = Math.round((y1 - y0) / res);
  const gcells = new Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) gcells[r * W + c] = ang2pix(MP, x0 + (c + 0.5) * res, y1 - (r + 0.5) * res);
  const mIdx = new Map(MP.months.map((m, i) => [m, i]));
  const tIdx = ev.months.map(([y, m]) => mIdx.get(`${y}-${String(m).padStart(2, "0")}`)).filter((x) => x != null);
  const vals = await cellMean(MP, gcells, tIdx);
  const km = MP.units === TS.units ? k : displayScale(ev.v, MP, vals);
  const map = Float32Array.from(vals, (v) => v * km);

  const D = DESCR[ev.v];
  return {
    k: ev.k, W, H, res, bbox: ev.bbox, map, months: TS.months, series, normal, units: D.units, normal_units: D.normal_units,
    attrs: {
      title: `CANguesser event ${ev.k}`, event: ev.k, variable: ev.v, long_name: D.long_name, normal_long_name: D.normal_long_name, units: D.units,
      event_months: ev.months.map(([y, m]) => `${y}-${String(m).padStart(2, "0")}`), bbox: ev.bbox, grid_resolution_deg: res,
      region: ev.region, region_cells: cells.length, healpix_nside: { series: TS.nside, map: MP.nside }, healpix_order: TS.order,
      source_stores: { series: TS.url, map: MP.url, normals: NM?.url ?? null }, source_units: TS.units, display_scale: k,
      reference_period: "1991-2020", source: "EUMETSAT Climate Anomalies and Normals (CAN) service, https://can.eumetsat.int",
      built: new Date().toISOString(),
    },
  };
}

/**
 * Build every event and write each to <opts.outDir>/<k>.zarr. Failures are reported and
 * skipped; an event that fails keeps its previous store (or the snapshot).
 */
export async function buildAll(events, opts) {
  const t0 = Date.now();
  const assets = await discover(opts.stacRoot);
  const out = [], errors = {};
  for (const ev of events) {
    try {
      const rec = await buildEvent(ev, assets, opts);
      // derive what the game shows, exactly as the browser will, before publishing the store
      const d = deriveEvent(ev, rec);
      if (d.years[ev.year] == null) throw new Error(`event period missing in record for ${ev.k}`);
      await writeEventStore(opts.outDir, rec);
      out.push(ev.k); log(`built ${ev.k}`);
    } catch (e) { errors[ev.k] = String(e.message || e); log(`failed ${ev.k}: ${errors[ev.k]}`); }
  }
  CHUNKS.clear();
  return { built: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), stacRoot: opts.stacRoot, events: out, errors };
}
