// Reads one quiz event from its Zarr store and derives what the game shows from it.
// Shared by the browser (public/app.js, via an import map for "zarrita") and Node
// (lib/can-zarr.mjs checks every store it writes; the dev scripts render from stores).
//
// Store layout (Zarr v3, written by lib/event-store.mjs), values in display units:
//   anomaly_map    (lat, lon)  mean anomaly over the event months on a lon/lat grid over bbox
//   region_anomaly (time)      region-mean anomaly for every month of the CAN record
//   time           (time)      "days since YYYY-MM-01", one value per month start
//   region_normal  (month)     region-mean 1991-2020 normal for each calendar month
//   lat, lon, month            coordinates (not needed by the game)
import * as zarr from "zarrita";

const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const round1 = (x) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);

/** Read the arrays the game needs from an event store (any zarrita store: FetchStore, FileSystemStore). */
export async function readEventStore(store) {
  const root = await zarr.open.v3(store, { kind: "group" });
  const open = (name) => zarr.open.v3(root.resolve(name), { kind: "array" });
  const [map, series, time, normal] = await Promise.all(["anomaly_map", "region_anomaly", "time", "region_normal"].map(open));
  const [mapV, seriesV, timeV, normalV] = await Promise.all([map, series, time, normal].map((a) => zarr.get(a)));
  const u = /^days since (\d{4})-(\d{2})-(\d{2})/.exec(time.attrs.units || "");
  if (!u) throw new Error(`unexpected time units ${JSON.stringify(time.attrs.units)}`);
  const months = Array.from(timeV.data, (t) => { const d = new Date(Date.UTC(+u[1], +u[2] - 1, +u[3] + Number(t))); return ym(d.getUTCFullYear(), d.getUTCMonth() + 1); });
  return { attrs: root.attrs, H: map.shape[0], W: map.shape[1], map: mapV.data, months, series: seriesV.data, normal: normalV.data };
}

/**
 * Merge an event definition (public/events.json) with its store data into what the game
 * renders: the map, one value per year for the event's calendar months, a 12-month
 * chart window centred on the event, and the 12 normals.
 */
export function deriveEvent(def, d) {
  const idx = new Map(d.months.map((m, i) => [m, i]));
  const at = (y, m) => { const i = idx.get(ym(y, m)); const x = i == null ? NaN : d.series[i]; return Number.isNaN(x) ? null : x; };

  // yearly means over the event's calendar months (a Dec-Feb event counts for the year it ends in)
  const last = def.months.at(-1)[0];
  const offs = def.months.map(([y, m]) => [y - last, m]);
  const ys = d.months.map((s) => +s.slice(0, 4));
  const years = {};
  for (let Y = Math.min(...ys); Y <= Math.max(...ys); Y++) {
    const xs = offs.map(([dy, m]) => at(Y + dy, m));
    if (xs.every((x) => x != null)) years[Y] = round1(xs.reduce((a, b) => a + b, 0) / xs.length);
  }

  // 12-month chart window centred on the event
  const [fy, fm] = def.months[0];
  const span = (def.months.at(-1)[0] - fy) * 12 + (def.months.at(-1)[1] - fm) + 1;
  let cy = fy, cm = fm - Math.floor((12 - span) / 2);
  while (cm < 1) { cm += 12; cy--; }
  const anom = [];
  for (let i = 0, y = cy, m = cm; i < 12; i++) { anom.push(round1(at(y, m))); if (++m > 12) { m = 1; y++; } }

  return { ...def, W: d.W, H: d.H, map: d.map, years, anom, chartStart: [cy, cm], normal: Array.from(d.normal, (x) => round1(x) ?? 0), attrs: d.attrs };
}
