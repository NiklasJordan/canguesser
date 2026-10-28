// Writes one Zarr v3 store per quiz event (layout documented in public/event-data.js).
// The server writes live builds into the data volume; scripts/snapshot.mjs writes the
// bundled fallback into public/events/.
import * as zarr from "zarrita";
import FileSystemStore from "@zarrita/storage/fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// zarrita decodes gzip itself but can't encode it; register a Node codec for writing.
class Gzip {
  kind = "bytes_to_bytes";
  constructor(level) { this.level = level; }
  static fromConfig(c) { return new Gzip(c?.level ?? 6); }
  encode(b) { return new Uint8Array(gzipSync(b, { level: this.level })); }
  decode(b) { return new Uint8Array(gunzipSync(b)); }
}
zarr.registry.set("gzip", () => Gzip);

const enc = (o) => new TextEncoder().encode(JSON.stringify(o, null, 2));

async function putArray(store, name, { data, shape, dims, attrs }) {
  const float = data instanceof Float32Array || data instanceof Float64Array;
  const meta = {
    zarr_format: 3, node_type: "array", shape,
    data_type: data instanceof Float32Array ? "float32" : data instanceof Float64Array ? "float64" : "int32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },        // one chunk per array
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: float ? "NaN" : 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }, { name: "gzip", configuration: { level: 6 } }],
    attributes: attrs, dimension_names: dims,
  };
  await store.set(`/${name}/zarr.json`, enc(meta));
  const arr = await zarr.open.v3(zarr.root(store).resolve(name), { kind: "array" });
  const stride = shape.map((_, i) => shape.slice(i + 1).reduce((a, b) => a * b, 1));
  await zarr.set(arr, null, { data, shape, stride });
}

/**
 * Write the root group's zarr.json with the metadata of every array inlined (zarr-python's
 * v3 consolidated metadata). Readers over plain HTTP can't list folders, so xarray and
 * zarr-python need it to find the arrays; zarrita ignores it and opens arrays by name.
 */
export async function writeRootMeta(dir, attrs) {
  const metadata = {};
  for (const e of (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    metadata[e.name] = JSON.parse(await readFile(path.join(dir, e.name, "zarr.json"), "utf8"));
  }
  await writeFile(path.join(dir, "zarr.json"), enc({ zarr_format: 3, node_type: "group", attributes: attrs,
    consolidated_metadata: { kind: "inline", must_understand: false, metadata } }));
}

/**
 * Write <dir>/<k>.zarr. The store is written next to the old one and swapped in, so a
 * reader sees the old or the new store (or, for a moment, none, and the server falls back
 * to the snapshot), never a half-written one.
 * rec: { k, attrs, W, H, bbox, res, map, months: ["YYYY-MM"], series, normal, units }
 */
export async function writeEventStore(dir, rec) {
  await mkdir(dir, { recursive: true });
  const final = path.join(dir, `${rec.k}.zarr`), tmp = path.join(dir, `.${rec.k}.zarr.tmp`);
  await rm(tmp, { recursive: true, force: true });
  const store = new FileSystemStore(tmp);

  const [x0, , , y1] = rec.bbox;
  const lon = Float64Array.from({ length: rec.W }, (_, c) => x0 + (c + 0.5) * rec.res);
  const lat = Float64Array.from({ length: rec.H }, (_, r) => y1 - (r + 0.5) * rec.res);
  // CF time: days from the first month to each month start ("months since" isn't a CF calendar unit)
  const utc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, 1);
  const time = Int32Array.from(rec.months, (s) => (utc(s) - utc(rec.months[0])) / 86400e3);

  await putArray(store, "anomaly_map", { data: rec.map, shape: [rec.H, rec.W], dims: ["lat", "lon"],
    attrs: { long_name: `${rec.attrs.long_name}, mean over the event months`, units: rec.units, months: rec.attrs.event_months } });
  await putArray(store, "lat", { data: lat, shape: [rec.H], dims: ["lat"], attrs: { standard_name: "latitude", units: "degrees_north" } });
  await putArray(store, "lon", { data: lon, shape: [rec.W], dims: ["lon"], attrs: { standard_name: "longitude", units: "degrees_east" } });
  await putArray(store, "region_anomaly", { data: rec.series, shape: [rec.series.length], dims: ["time"],
    attrs: { long_name: `${rec.attrs.long_name}, mean over the region`, units: rec.units } });
  await putArray(store, "time", { data: time, shape: [time.length], dims: ["time"],
    attrs: { standard_name: "time", units: `days since ${rec.months[0]}-01`, calendar: "standard" } });
  await putArray(store, "region_normal", { data: rec.normal, shape: [12], dims: ["month"],
    attrs: { long_name: `${rec.attrs.normal_long_name}, mean over the region`, units: rec.normal_units } });
  await putArray(store, "month", { data: Int32Array.from({ length: 12 }, (_, i) => i + 1), shape: [12], dims: ["month"], attrs: { long_name: "calendar month" } });
  await writeRootMeta(tmp, rec.attrs);

  await rm(final, { recursive: true, force: true });
  await rename(tmp, final);
}

/** Root attributes of every complete store in dir, by event key. */
export async function listEventStores(dir) {
  const out = new Map();
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  for (const n of names) {
    const m = /^([A-Za-z0-9]+)\.zarr$/.exec(n);
    if (!m) continue;
    try { out.set(m[1], JSON.parse(await readFile(path.join(dir, n, "zarr.json"), "utf8")).attributes || {}); } catch {}
  }
  return out;
}
