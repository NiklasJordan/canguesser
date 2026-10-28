// Region masks: which HEALPix cell centres fall inside a country (Natural Earth 50m,
// from world-atlas) or inside a latitude band (for the ocean regions).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);
let COUNTRIES = null;
function countries() {
  if (!COUNTRIES) {
    const topo = JSON.parse(readFileSync(require.resolve("world-atlas/countries-50m.json"), "utf8"));
    COUNTRIES = new Map();
    for (const f of feature(topo, topo.objects.countries).features) {
      const polys = f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.coordinates || [];
      const rings = polys.map((p) => {
        const r = p[0];
        let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
        for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
        return { r, holes: p.slice(1), box: [a, b, c, d] };
      });
      // several features can share one code (e.g. 036 also covers Ashmore and Cartier Is.): merge them
      const id = String(f.id);
      COUNTRIES.set(id, [...(COUNTRIES.get(id) || []), ...rings]);
    }
  }
  return COUNTRIES;
}

function inRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
export function inCountry(id, lon, lat) {
  const rings = countries().get(String(id));
  if (!rings) throw new Error(`unknown country id ${id}`);
  for (const p of rings) {
    const [a, b, c, d] = p.box;
    if (lon < a || lon > c || lat < b || lat > d) continue;
    if (inRing(lon, lat, p.r) && !p.holes.some((h) => inRing(lon, lat, h))) return true;
  }
  return false;
}

/** Cell ids of a HEALPix grid (given its centres) that belong to the region. */
export function regionMask(region, centers, bbox) {
  const { lon, lat } = centers, out = [];
  if (region.type === "lat") {
    for (let i = 0; i < lat.length; i++) {
      if ((region.min == null || lat[i] >= region.min) && (region.max == null || lat[i] <= region.max)) out.push(i);
    }
    return out;
  }
  const rings = countries().get(String(region.id));
  if (!rings) throw new Error(`unknown country id ${region.id}`);
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of rings) { a = Math.min(a, p.box[0]); b = Math.min(b, p.box[1]); c = Math.max(c, p.box[2]); d = Math.max(d, p.box[3]); }
  for (let i = 0; i < lat.length; i++) {
    const x = lon[i], y = lat[i];
    if (x < a || x > c || y < b || y > d) continue;
    if (inCountry(region.id, x, y)) out.push(i);
  }
  return out;
}
