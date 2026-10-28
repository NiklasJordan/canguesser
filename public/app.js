/* CANguesser — guess the place and year of climate events from EUMETSAT CAN data. */
(() => {
  "use strict";
  const ROUNDS = 8;

  // Event texts and answers (events.json) and country borders (places.json) are JSON.
  // Each event's numbers live in its own Zarr store, events/<k>.zarr, which is read with
  // zarrita when the event is played (public/event-data.js). The server serves the store
  // from its latest CAN build, or the bundled snapshot if it has none.
  const D = { events: [], countries: [], oceans: [], borders: {} };
  const getJson = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status} for ${u}`))));
  const READY = Promise.all([getJson("events.json"), getJson("places.json")]).then(([events, places]) => {
    Object.assign(D, places, { events });
    for (const [id, name, lon, lat] of D.countries) PLACES.set(id, { id, name, lon, lat });
    for (const [id, name, lon, lat] of D.oceans) PLACES.set(id, { id, name, lon, lat, ocean: true });
  });
  const LOADED = new Map();   // event key -> Promise of the event with its data
  function loadEvent(def) {
    if (!LOADED.has(def.k)) {
      const p = Promise.all([import("./event-data.js"), import("zarrita")]).then(async ([{ readEventStore, deriveEvent }, zarr]) => {
        const store = new zarr.FetchStore(new URL(`events/${def.k}.zarr`, location.href).href);
        return deriveEvent(def, await readEventStore(store));
      });
      p.catch(() => LOADED.delete(def.k));
      LOADED.set(def.k, p);
    }
    return LOADED.get(def.k);
  }
  let INTRO_EV = null;        // background map of the start screen
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MON1 = ["J","F","M","A","M","J","J","A","S","O","N","D"];

  const VAR = {
    swi: { label: "Root-zone soil moisture", short: "Soil moisture", provider: "H SAF",
      unit: "pts", chartUnit: "% wetness", lo: "Drier", hi: "Wetter",
      sup: [-1, "driest", "wettest"], fmtYear: (x) => `${sign(x)}${abs1(x)} wetness points`,
      pal: ["#7f4a0c", "#b9823a", "#e2c48f", "#f3efe6", "#a4d4ca", "#4b9d93", "#0e5f58"] },
    sdu: { label: "Sunshine duration", short: "Sunshine", provider: "CM SAF",
      unit: "h", chartUnit: "hours", lo: "Duller", hi: "Sunnier",
      sup: [-1, "dullest", "sunniest"], fmtYear: (x) => `${sign(x)}${Math.abs(x).toFixed(0)} h of sunshine a month`,
      pal: ["#2f4a72", "#7189ad", "#bfcadb", "#f3efe6", "#f6d593", "#eda53a", "#b8650a"] },
    sis: { label: "Surface solar radiation", short: "Solar radiation", provider: "CM SAF",
      unit: "W/m²", chartUnit: "W/m²", lo: "Dimmer", hi: "Brighter",
      sup: [-1, "dimmest", "brightest"], fmtYear: (x) => `${sign(x)}${Math.abs(x).toFixed(0)} W/m²`,
      pal: ["#3f3580", "#8378bb", "#c8c2e2", "#f3efe6", "#f7c99a", "#e8874a", "#b5481c"] },
    ice: { label: "Sea ice concentration", short: "Sea ice", provider: "OSI SAF",
      unit: "pp", chartUnit: "% ice cover", lo: "Less ice", hi: "More ice",
      sup: [-1, "lowest-ice", "highest-ice"], fmtYear: (x) => `${sign(x)}${abs1(x)} percentage points of ice cover`,
      pal: ["#a8202f", "#db6c5a", "#f3c1aa", "#f3efe6", "#bad5e9", "#6aa3cf", "#1f5f9f"] },
  };
  function sign(x) { return x > 0 ? "+" : x < 0 ? "−" : "±"; }
  function abs1(x) { return Math.abs(x).toFixed(1); }

  // ------------------------------------------------------------ places
  const PLACES = new Map();   // filled once places.json is loaded
  const placeName = (id) => PLACES.get(id)?.name || id;

  // ------------------------------------------------------------ state
  const S = { mode: null, rounds: [], i: 0, score: 0, results: [], pick: { loc: null, year: null }, answered: false, game: 0 };
  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
    return n;
  };

  // ------------------------------------------------------------ geometry
  let RINGS = null;
  function rings() {
    if (RINGS) return RINGS;
    RINGS = [];
    for (const [id, polys] of Object.entries(D.borders)) {
      for (const r of polys) {
        const pts = new Float32Array(r.length);
        let x = 0, y = 0;
        for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; pts[i] = x / 20; pts[i + 1] = y / 20; }
        RINGS.push({ id, pts });
      }
    }
    return RINGS;
  }

  // ------------------------------------------------------------ projection
  // Lambert azimuthal equal-area, centred on the event box (or a pole).
  function makeProj(ev, W, H) {
    const [x0, y0, x1, y1] = ev.bbox;
    const polar = x1 - x0 >= 359;
    const lam0 = polar ? 0 : ((x0 + x1) / 2) * Math.PI / 180;
    const phi0 = polar ? (y1 > 0 ? Math.PI / 2 : -Math.PI / 2) : ((y0 + y1) / 2) * Math.PI / 180;
    const sp0 = Math.sin(phi0), cp0 = Math.cos(phi0);
    const fwd = (lon, lat) => {
      const l = lon * Math.PI / 180 - lam0, p = lat * Math.PI / 180;
      const sp = Math.sin(p), cp = Math.cos(p), cl = Math.cos(l);
      const cosc = sp0 * sp + cp0 * cp * cl;
      const k = Math.sqrt(2 / Math.max(1e-9, 1 + cosc));
      return [k * cp * Math.sin(l), k * (cp0 * sp - sp0 * cp * cl), cosc];
    };
    const inv = (x, y) => {
      const rho = Math.hypot(x, y);
      if (rho < 1e-12) return [lam0 * 180 / Math.PI, phi0 * 180 / Math.PI];
      if (rho > 2) return null;
      const c = 2 * Math.asin(rho / 2), sc = Math.sin(c), cc = Math.cos(c);
      const lat = Math.asin(cc * sp0 + (y * sc * cp0) / rho);
      const lon = lam0 + Math.atan2(x * sc, rho * cp0 * cc - y * sp0 * sc);
      let L = lon * 180 / Math.PI;
      L = ((L + 540) % 360) - 180;
      return [L, lat * 180 / Math.PI];
    };
    // fit the box outline
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity;
    const edge = polar ? [[-180, y0 > 0 ? y0 : y1, 180, y0 > 0 ? y0 : y1]] : [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]];
    for (const [a, b, c, d] of edge) for (let t = 0; t <= 1; t += 1 / 64) {
      const [x, y] = fwd(a + (c - a) * t, b + (d - b) * t);
      mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y);
    }
    const pad = polar ? 0.02 : 0.08;
    const bw = (mxx - mnx) * (1 + pad * 2), bh = (mxy - mny) * (1 + pad * 2);
    const s = Math.min(W / bw, H / bh);
    const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2;
    return {
      polar,
      toPx: (lon, lat) => { const [x, y, c] = fwd(lon, lat); return [W / 2 + (x - cx) * s, H / 2 - (y - cy) * s, c]; },
      fromPx: (px, py) => inv((px - W / 2) / s + cx, -(py - H / 2) / s + cy),
    };
  }

  function rampColor(pal, t) {
    t = Math.max(0, Math.min(1, t));
    const n = pal.length - 1, x = t * n, i = Math.min(n - 1, Math.floor(x)), f = x - i;
    const a = hex(pal[i]), b = hex(pal[i + 1]);
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  const HEXC = new Map();
  function hex(h) {
    if (!HEXC.has(h)) HEXC.set(h, [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    return HEXC.get(h);
  }
  function scaleFor(ev) {
    const g = ev.map;
    const a = [];
    for (const v of g) if (!Number.isNaN(v)) a.push(Math.abs(v));
    a.sort((p, q) => p - q);
    const q = a[Math.floor(a.length * 0.95)] || 1;
    const nice = [1, 2, 2.5, 5, 10];
    const mag = Math.pow(10, Math.floor(Math.log10(q)));
    for (const n of nice) if (n * mag >= q) return n * mag;
    return 10 * mag;
  }

  // ------------------------------------------------------------ map
  function drawMap(ev, highlight) {
    const cv = $("map");
    const box = $("stage").getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(320, Math.round(box.width)), H = Math.max(240, Math.round(box.height));
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + "px"; cv.style.height = H + "px";
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // keep clear of the floating panel on wide screens
    const panelW = window.innerWidth > 900 ? 420 : 0;
    const MW = W - panelW, MH = H;
    const P = makeProj(ev, MW, MH);
    const ox = panelW;

    ctx.fillStyle = "#dde5ec"; ctx.fillRect(0, 0, W, H);
    const R = rings();
    const path = (pts) => {
      ctx.beginPath();
      let ok = true;
      for (let i = 0; i < pts.length; i += 2) {
        const [x, y, c] = P.toPx(pts[i], pts[i + 1]);
        if (c < -0.15) { ok = false; break; }
        if (i === 0) ctx.moveTo(ox + x, y); else ctx.lineTo(ox + x, y);
      }
      ctx.closePath();
      return ok;
    };
    ctx.fillStyle = "#f6f5f1";
    for (const r of R) if (path(r.pts)) ctx.fill();

    // anomaly raster (rendered at half resolution, then smoothed up)
    const g = ev.map;
    const L = scaleFor(ev);
    const pal = VAR[ev.v].pal;
    const [bx0, by0, bx1, by1] = ev.bbox;
    const res = (bx1 - bx0) / ev.W;
    const rs = 2;
    const rw = Math.ceil(MW / rs), rh = Math.ceil(MH / rs);
    const off = document.createElement("canvas");
    off.width = rw; off.height = rh;
    const octx = off.getContext("2d");
    const img = octx.createImageData(rw, rh);
    const sample = (lon, lat) => {
      const fx = (lon - bx0) / res - 0.5, fy = (by1 - lat) / res - 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      let sw = 0, sv = 0;
      for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
        let cx = ix + dx; const cy = iy + dy;
        if (cy < 0 || cy >= ev.H) continue;
        if (P.polar) cx = (cx + ev.W) % ev.W; else if (cx < 0 || cx >= ev.W) continue;
        const v = g[cy * ev.W + cx];
        if (!Number.isNaN(v)) { sv += v * w; sw += w; }
      }
      return sw > 0.3 ? sv / sw : NaN;
    };
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const ll = P.fromPx(x * rs + rs / 2, y * rs + rs / 2);
      if (!ll) continue;
      const [lon, lat] = ll;
      if (lat < by0 || lat > by1 || (!P.polar && (lon < bx0 || lon > bx1))) continue;
      const v = sample(lon, lat);
      if (Number.isNaN(v)) continue;
      const c = rampColor(pal, (v / L + 1) / 2);
      const o = (y * rw + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 235;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, ox, 0, rw * rs, rh * rs);

    // sea ice never sits on land: paint land back over the ice raster
    if (ev.v === "ice") { ctx.fillStyle = "#f6f5f1"; for (const r of R) if (path(r.pts)) ctx.fill(); }
    // borders on top
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(40,52,66,.5)"; ctx.lineWidth = 0.9;
    for (const r of R) if (path(r.pts)) ctx.stroke();
    if (highlight) {
      ctx.strokeStyle = "#1d2733"; ctx.lineWidth = 2.2;
      for (const r of R) if (r.id === highlight && path(r.pts)) ctx.stroke();
    }
    // box outline for context
    ctx.setLineDash([3, 4]); ctx.strokeStyle = "rgba(40,52,66,.25)"; ctx.lineWidth = 1;
    ctx.beginPath();
    if (!P.polar) {
      const e = [[bx0, by0, bx1, by0], [bx1, by0, bx1, by1], [bx1, by1, bx0, by1], [bx0, by1, bx0, by0]];
      e.forEach(([a, b, c, d], k) => { for (let t = 0; t <= 1; t += 1 / 40) { const [x, y] = P.toPx(a + (c - a) * t, b + (d - b) * t); if (k === 0 && t === 0) ctx.moveTo(ox + x, y); else ctx.lineTo(ox + x, y); } });
    }
    ctx.stroke(); ctx.setLineDash([]);

    legend(ev, L);
  }

  function legend(ev, L) {
    const V = VAR[ev.v];
    const lg = $("legend");
    lg.hidden = false;
    lg.querySelector(".lg-title").textContent = `${V.label} anomaly`;
    lg.querySelector(".lg-bar").style.background = `linear-gradient(90deg, ${V.pal.join(",")})`;
    const u = ev.v === "swi" ? " pts" : ev.v === "ice" ? " pp" : " " + V.unit;
    lg.querySelector(".lg-lo").textContent = `${V.lo} −${fmtNum(L)}${u}`;
    lg.querySelector(".lg-hi").textContent = `+${fmtNum(L)}${u} ${V.hi.toLowerCase()}`;
  }
  const fmtNum = (x) => (x >= 10 ? x.toFixed(0) : x % 1 ? x.toFixed(1) : x.toFixed(0));

  // ------------------------------------------------------------ chart (expert)
  function drawChart(ev) {
    const V = VAR[ev.v];
    const host = $("chart");
    host.innerHTML = "";
    const [sy, sm] = ev.chartStart;
    const n = 12;
    const vals = [], norm = [], labels = [], inEvent = [];
    const evSet = new Set(ev.months.map(([y, m]) => y * 12 + m));
    let y = sy, m = sm;
    for (let i = 0; i < n; i++) {
      const nm = ev.normal[m - 1];
      const a = ev.anom[i];
      norm.push(nm);
      vals.push(a == null ? null : Math.max(0, nm + a));
      labels.push(MON1[m - 1]);
      inEvent.push(evSet.has(y * 12 + m));
      m++; if (m > 12) { m = 1; y++; }
    }
    const top = Math.max(...norm, ...vals.filter((v) => v != null)) * 1.12;
    const step = niceStep(top / 5);
    const ymax = Math.ceil(top / step) * step;
    const W = 720, H = 400, ml = 54, mr = 18, mt = 26, mb = 44;
    const pw = W - ml - mr, ph = H - mt - mb;
    const sx = (i) => ml + (i + 0.5) * (pw / n);
    const syy = (v) => mt + ph - (v / ymax) * ph;
    const NS = "http://www.w3.org/2000/svg";
    const s = (tag, a, txt) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (txt != null) e.textContent = txt; return e; };
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${V.label}: twelve monthly values against the 1991 to 2020 normal` });
    // event band
    const evIdx = inEvent.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
    if (evIdx.length) {
      const x0 = ml + evIdx[0] * (pw / n), x1 = ml + (evIdx.at(-1) + 1) * (pw / n);
      svg.append(s("rect", { x: x0, y: mt - 8, width: x1 - x0, height: ph + 8, fill: "#fff3e9", rx: 6 }));
      svg.append(s("text", { x: (x0 + x1) / 2, y: mt - 12, "text-anchor": "middle", class: "c-ev" }, "event"));
    }
    for (let v = 0; v <= ymax + 1e-9; v += step) {
      svg.append(s("line", { x1: ml, x2: W - mr, y1: syy(v), y2: syy(v), class: v === 0 ? "c-base" : "c-grid" }));
      svg.append(s("text", { x: ml - 10, y: syy(v) + 4, "text-anchor": "end", class: "c-tick" }, fmtTick(v, step)));
    }
    const bw = (pw / n) * 0.56;
    vals.forEach((v, i) => {
      if (v == null) return;
      const a = v - norm[i];
      const t = (a / (Math.max(...ev.anom.map((q) => Math.abs(q ?? 0))) || 1) + 1) / 2;
      const c = rampColor(V.pal, t);
      svg.append(s("rect", { x: sx(i) - bw / 2, y: syy(v), width: bw, height: Math.max(0, syy(0) - syy(v)), rx: 3, fill: `rgb(${c.map(Math.round).join(",")})`, stroke: "rgba(29,39,51,.18)" }));
    });
    // normal as a stepped line of ticks
    const d = norm.map((v, i) => `${i ? "L" : "M"}${sx(i) - (pw / n) * 0.42},${syy(v)} L${sx(i) + (pw / n) * 0.42},${syy(v)}`).join(" ");
    svg.append(s("path", { d, class: "c-norm" }));
    labels.forEach((l, i) => svg.append(s("text", { x: sx(i), y: H - mb + 22, "text-anchor": "middle", class: "c-mon" }, l)));
    svg.append(s("text", { x: 14, y: mt + ph / 2, transform: `rotate(-90 14 ${mt + ph / 2})`, "text-anchor": "middle", class: "c-unit" }, V.chartUnit));
    host.append(svg);
    $("chart-title").textContent = V.label;
    $("chart-sub").textContent = `12 months, ${V.provider}. Bars: the mystery period. Line: 1991–2020 normal.`;
  }
  function niceStep(x) {
    const mag = Math.pow(10, Math.floor(Math.log10(x)));
    for (const n of [1, 2, 2.5, 5, 10]) if (n * mag >= x) return n * mag;
    return 10 * mag;
  }
  const fmtTick = (v, step) => (step < 1 ? v.toFixed(1) : v.toFixed(0));

  // ------------------------------------------------------------ helpers
  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const MONTH = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  function periodLabel(ev) {
    const ms = ev.months.map(([, m]) => m);
    return ms.length === 1 ? MONTH[ms[0] - 1] : `${MON[ms[0] - 1]}–${MON[ms.at(-1) - 1]}`;
  }
  const THE = new Set(["528", "826", "840", "ARO", "SOO", "GIC", "SAO"]);
  const placeWithThe = (id) => (THE.has(id) ? "the " : "") + placeName(id);
  function scoreRound(ev, loc, year) {
    const lp = loc === ev.loc ? 500 : 0;
    const yp = year === ev.year ? 500 : 0;
    return { lp, yp };
  }
  function rankText(ev) {
    const V = VAR[ev.v];
    const arr = Object.entries(ev.years).map(([y, v]) => [+y, v]);
    const sorted = arr.slice().sort((a, b) => ev.dir * (b[1] - a[1]));
    const rank = sorted.findIndex(([y]) => y === ev.year) + 1;
    const val = ev.years[ev.year];
    const word = ev.dir < 0 ? V.sup[1] : V.sup[2];
    const first = Math.min(...arr.map(([y]) => y)), last = Math.max(...arr.map(([y]) => y));
    const where = placeWithThe(ev.loc);
    const per = periodLabel(ev);
    const sfx = (n) => (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
    const ord = rank === 1 ? "" : `${rank}${sfx(rank)} `;
    const what = ev.v === "ice" ? `${ord}${ev.dir < 0 ? "lowest" : "highest"} ${per} sea ice cover in ${where}` : `${ord}${word} ${per} in ${where}`;
    const yrs = sorted.slice(0, rank - 1).map(([y]) => y);
    const list = yrs.length > 1 ? `${yrs.slice(0, -1).join(", ")} and ${yrs.at(-1)}` : String(yrs[0]);
    const ahead = rank === 1 ? "" : rank <= 4 ? ` Only ${list} ${rank === 2 ? "was" : "were"} more extreme.` : ` ${rank - 1} other years were more extreme.`;
    return `In the CAN record (${first}–${last}), this was the ${what}: ${V.fmtYear(val)} against the 1991–2020 normal.${ahead}`;
  }

  // ------------------------------------------------------------ screens
  function panel(...kids) { const p = $("panel-body"); p.innerHTML = ""; p.append(...kids); p.scrollTop = 0; }
  function setTop() {
    $("top-score").textContent = S.score.toLocaleString("en");
    const dots = $("top-dots"); dots.innerHTML = "";
    for (let k = 0; k < ROUNDS; k++) {
      const r = S.results[k];
      dots.append(el("i", { class: r ? (r.lp + r.yp >= 700 ? "d good" : r.lp + r.yp >= 300 ? "d mid" : "d bad") : k === S.i && S.mode ? "d now" : "d" }));
    }
    $("top-status").hidden = !S.mode;
    $("restart").hidden = !S.mode;
  }

  function intro() {
    S.mode = null; S.results = []; S.score = 0; S.i = 0; S.game++;
    setTop();
    $("stage").dataset.view = "intro";
    $("legend").hidden = true;
    if (INTRO_EV) drawMap(INTRO_EV, null);
    else {
      const bg = D.events.find((e) => e.k === "GB25") || D.events[0];
      if (bg) loadEvent(bg).then((ev) => { INTRO_EV = ev; if ($("stage").dataset.view === "intro") drawMap(ev, null); }).catch(() => {});
    }
    let mode = "noob";
    const rows = el("div", { class: "rows", role: "radiogroup", "aria-label": "Mode" });
    const opt = (id, title, sub) => el("button", { class: "row", type: "button", role: "radio", "aria-checked": String(id === mode), "data-id": id,
      onclick: () => { mode = id; rows.querySelectorAll(".row").forEach((r) => r.setAttribute("aria-checked", String(r.dataset.id === mode))); } },
      el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "row-t" }, el("b", { text: title }), el("small", { text: sub })));
    rows.append(
      opt("noob", "Noob", "Anomaly map with the region outlined"),
      opt("expert", "Expert", "Only a 12-month chart against the normal"));
    panel(
      el("h2", { text: "CANguesser" }),
      el("p", { class: "lede" },
        `${ROUNDS} rounds of real events from the last twenty years: droughts, floods, record sunshine and sea ice extremes. Each one is drawn from `,
        el("a", { href: "https://can.eumetsat.int/", target: "_blank", rel: "noopener" }, "Climate Anomalies and Normals (CAN) service"),
        " (climate data records) as an anomaly against the 1991–2020 normal. Guess the place and the year."),
      el("div", { class: "sect" }, el("p", { class: "label", text: "Mode" }), rows),
      el("p", { class: "fine", text: "Both modes give three options for the place and three for the year. 500 points for the right place, 500 for the right year." }),
      el("div", { class: "cta" },
        el("a", { class: "cta-link", href: "https://github.com/NiklasJordan/canguesser", target: "_blank", rel: "noopener" }, "Open Source"),
        el("button", { class: "primary", type: "button", onclick: () => start(mode) }, "Start game")),
    );
  }

  function start(mode) {
    S.mode = mode;
    S.game++;
    S.rounds = shuffle(D.events).slice(0, ROUNDS);   // definitions, replaced by the full event when it loads
    S.i = 0; S.score = 0; S.results = [];
    for (const d of S.rounds) loadEvent(d).catch(() => {});   // fetch the other rounds' stores in the background
    round();
  }

  async function round() {
    const i = S.i, game = S.game;
    S.pick = { loc: null, year: null };
    S.answered = false;
    setTop();
    const eyebrow = () => el("p", { class: "eyebrow", text: `Round ${i + 1} of ${ROUNDS}` });
    const wait = setTimeout(() => game === S.game && panel(eyebrow(), el("h2", { text: "CANguesser" }), el("p", { class: "fine", text: "Reading this round's Zarr store…" })), 200);
    let ev = null;
    // if a store can't be read, swap in an event that isn't in this game yet
    for (let tries = 0; !ev && tries < 4; tries++) {
      try { ev = await loadEvent(S.rounds[i]); }
      catch {
        const used = new Set(S.rounds.map((r) => r.k));
        const alt = shuffle(D.events).find((e) => !used.has(e.k));
        if (!alt) break;
        S.rounds[i] = alt;
      }
    }
    clearTimeout(wait);
    if (game !== S.game || i !== S.i) return;          // restarted while loading
    if (!ev) {
      panel(eyebrow(), el("h2", { text: "CANguesser" }), el("p", { class: "fine", text: "The data for this round could not be loaded." }),
        el("div", { class: "cta" }, el("button", { class: "primary", type: "button", onclick: round }, "Try again")));
      return;
    }
    S.rounds[i] = ev;
    const V = VAR[ev.v];
    const chip = el("div", { class: "chip" }, el("span", { class: "swatch", style: `background:linear-gradient(90deg,${V.pal.join(",")})` }), `${V.label} · ${periodLabel(ev)}`);
    const head = [eyebrow(), el("h2", { text: "CANguesser" }), chip];

    if (S.mode === "noob") {
      $("stage").dataset.view = "map";
      drawMap(ev, /^\d+$/.test(ev.loc) ? ev.loc : null);
    } else {
      $("stage").dataset.view = "chart";
      $("legend").hidden = true;
      drawChart(ev);
    }
    const locRows = el("div", { class: "rows", role: "radiogroup", "aria-label": "Place" });
    for (const id of shuffle(ev.opts)) locRows.append(choiceRow(id, placeName(id), PLACES.get(id).ocean ? "Ocean region" : "Country", "loc", locRows));
    const yrRows = el("div", { class: "rows yrs", role: "radiogroup", "aria-label": "Year" });
    for (const y of shuffle(ev.yearOpts)) yrRows.append(choiceRow(y, String(y), null, "year", yrRows));
    const body = [el("div", { class: "sect" }, el("p", { class: "label", text: "Where" }), locRows), el("div", { class: "sect" }, el("p", { class: "label", text: "When" }), yrRows)];
    const btn = el("button", { class: "primary", type: "button", id: "submit", disabled: true, onclick: submit }, "Submit guess");
    panel(...head, ...body, el("div", { class: "cta" }, btn));
    updateSubmit();
  }

  function choiceRow(value, title, sub, key, group) {
    return el("button", { class: "row", type: "button", role: "radio", "aria-checked": "false", "data-v": value,
      onclick: (e) => {
        if (S.answered) return;
        S.pick[key] = value;
        group.querySelectorAll(".row").forEach((r) => r.setAttribute("aria-checked", String(r === e.currentTarget)));
        updateSubmit();
      } },
      el("span", { class: "dot", "aria-hidden": "true" }),
      el("span", { class: "row-t" }, el("b", { text: title }), sub ? el("small", { text: sub }) : null));
  }

  function updateSubmit() { const b = $("submit"); if (b) b.disabled = !(S.pick.loc && S.pick.year); }

  function submit() {
    if (S.answered || !(S.pick.loc && S.pick.year)) return;
    S.answered = true;
    const ev = S.rounds[S.i];
    const r = scoreRound(ev, S.pick.loc, S.pick.year);
    S.results[S.i] = { ...r, ev, loc: S.pick.loc, year: S.pick.year };
    S.score += r.lp + r.yp;
    setTop();
    if (S.mode === "noob") drawMap(ev, /^\d+$/.test(ev.loc) ? ev.loc : null);
    else { $("stage").dataset.view = "map"; drawMap(ev, /^\d+$/.test(ev.loc) ? ev.loc : null); }
    resultPanel(ev, r);
  }

  function resultPanel(ev, r) {
    const V = VAR[ev.v];
    const okL = S.pick.loc === ev.loc, okY = S.pick.year === ev.year;
    const line = (ok, label, guess, truth, pts, extra) => el("div", { class: "res-row" },
      el("span", { class: ok ? "dot ok" : "dot no", "aria-hidden": "true" }),
      el("span", { class: "row-t" }, el("b", { text: `${label}: ${truth}` }), el("small", { text: ok ? "You got it" : `You said ${guess}${extra || ""}` })),
      el("span", { class: "pts", text: `+${pts}` }));
    const last = S.i === ROUNDS - 1;
    panel(
      el("p", { class: "eyebrow", text: `Round ${S.i + 1} of ${ROUNDS} · ${r.lp + r.yp} points` }),
      el("h2", { text: ev.name }),
      el("p", { class: "when", text: `${ev.when} · ${placeName(ev.loc)}` }),
      el("div", { class: "res" },
        line(okL, "Place", placeName(S.pick.loc), placeName(ev.loc), r.lp),
        line(okY, "Year", String(S.pick.year), String(ev.year), r.yp)),
      el("div", { class: "info" },
        el("p", { text: ev.text }),
        el("p", { class: "data" }, el("span", { class: "swatch", style: `background:linear-gradient(90deg,${V.pal.join(",")})` }), rankText(ev)),
        el("p", { class: "label", text: "Read more" }),
        el("ul", { class: "links" },
          el("li", {}, el("a", { href: ev.wiki.u, target: "_blank", rel: "noopener" }, el("span", { class: "src", text: "Wikipedia" }), ev.wiki.t)),
          el("li", {}, el("a", { href: ev.alt.u, target: "_blank", rel: "noopener" }, el("span", { class: "src", text: "Source" }), ev.alt.t)),
          el("li", {}, el("a", { href: "https://can.eumetsat.int", target: "_blank", rel: "noopener" }, el("span", { class: "src", text: "Data" }), ev.attrs?.built ? `EUMETSAT CAN, ${V.provider} · Zarr built ${ev.attrs.built.slice(0, 10)}, HEALPix nside ${ev.attrs.healpix_nside?.map}` : `EUMETSAT CAN service, ${V.provider}`)))),
      el("div", { class: "cta" }, el("button", { class: "primary", type: "button", id: "next", onclick: () => { if (last) final(); else { S.i++; round(); } } }, last ? "See your score" : "Next round")),
    );
    $("next").focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ leaderboard
  // Shared top ten through the artifact's database when the viewer provides
  // one; otherwise (GitHub Pages, signed out) scores stay in this browser.
  const BOARD = { db: null, api: undefined };
  BOARD.ready = (async () => {
    try { if (window.claude && typeof window.claude.use === "function") BOARD.db = await window.claude.use("db"); } catch { BOARD.db = null; }
    return BOARD.db;
  })();
  const LKEY = "ww-scores";
  const localAll = () => { try { const a = JSON.parse(localStorage.getItem(LKEY) || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
  const cleanRow = (r, id) => ({
    id, name: String(r?.name ?? "").trim().slice(0, 24) || "Anonymous",
    score: Math.max(0, Math.min(ROUNDS * 1000, Math.round(+r?.score || 0))),
    mode: r?.mode === "expert" ? "expert" : "noob", at: String(r?.at ?? ""),
  });
  // Server API (Docker build): POST/GET api/scores, relative so it works under a sub-path.
  const API = "api/scores";
  async function apiOk() {
    if (BOARD.api !== undefined) return BOARD.api;
    try { const r = await fetch(API + "?mode=noob&limit=1", { headers: { Accept: "application/json" } }); BOARD.api = r.ok && (r.headers.get("content-type") || "").includes("json"); }
    catch { BOARD.api = false; }
    return BOARD.api;
  }
  async function saveScore(entry) {
    await BOARD.ready;
    if (BOARD.db) {
      try { const ref = await BOARD.db.collection("scores").add(entry); return { shared: true, id: ref.id }; }
      catch { /* fall through */ }
    }
    if (await apiOk()) {
      try {
        const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: entry.name, score: entry.score, mode: entry.mode }) });
        const j = await r.json();
        if (r.ok) return { shared: true, id: String(j.id), rank: j.rank };
        return { shared: true, error: j.error || "Could not save the score." };
      } catch { /* fall through */ }
    }
    const id = "local-" + Date.now();
    const all = localAll(); all.push({ ...entry, id });
    all.sort((a, b) => b.score - a.score);
    try { localStorage.setItem(LKEY, JSON.stringify(all.slice(0, 200))); } catch {}
    return { shared: false, id };
  }
  async function topTen(mode) {
    await BOARD.ready;
    if (BOARD.db) {
      try {
        const s = await BOARD.db.collection("scores").where("mode", "==", mode).orderBy("score", "desc").limit(10).get();
        return { shared: true, rows: s.docs.map((d) => cleanRow(d.data(), d.id)) };
      } catch { /* fall through */ }
    }
    if (await apiOk()) {
      try {
        const r = await fetch(`${API}?mode=${mode}&limit=10`, { headers: { Accept: "application/json" } });
        if (r.ok) { const j = await r.json(); return { shared: true, rows: (j.scores || []).map((x) => cleanRow(x, String(x.id))) }; }
      } catch { /* fall through */ }
    }
    return { shared: false, rows: localAll().filter((r) => r.mode === mode).map((r) => cleanRow(r, r.id)).sort((a, b) => b.score - a.score).slice(0, 10) };
  }
  const lastName = () => { try { return localStorage.getItem("ww-name") || ""; } catch { return ""; } };

  function boardView(mode, mine) {
    const box = el("div", { class: "board" });
    const tabs = el("div", { class: "tabs", role: "tablist", "aria-label": "Leaderboard mode" });
    const list = el("ol", { class: "lb", "aria-live": "polite" });
    const note = el("p", { class: "fine" });
    const load = async (m) => {
      tabs.querySelectorAll("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.m === m)));
      list.innerHTML = ""; list.append(el("li", { class: "lb-empty", text: "Loading…" }));
      const { shared, rows } = await topTen(m);
      list.innerHTML = "";
      if (!rows.length) list.append(el("li", { class: "lb-empty", text: "No scores yet. Be the first." }));
      rows.forEach((r, k) => list.append(el("li", { class: r.id === mine ? "me" : "" },
        el("span", { class: "lb-rank", text: String(k + 1) }),
        el("span", { class: "lb-name", text: r.name }),
        el("span", { class: "pts", text: r.score.toLocaleString("en") }))));
      note.textContent = shared ? "Shared with everyone who plays this quiz." : "Saved in this browser only.";
    };
    for (const [m, label] of [["noob", "Noob"], ["expert", "Expert"]]) {
      tabs.append(el("button", { type: "button", role: "tab", "data-m": m, onclick: () => load(m) }, label));
    }
    box.append(el("div", { class: "board-head" }, el("p", { class: "label", text: "Top ten" }), tabs), list, note);
    load(mode);
    return box;
  }

  function final() {
    S.i = ROUNDS;
    setTop();
    const best = (() => { try { return +localStorage.getItem("ww-best-" + S.mode) || 0; } catch { return 0; } })();
    const isBest = S.score > best;
    if (isBest) try { localStorage.setItem("ww-best-" + S.mode, String(S.score)); } catch {}
    const verdict = S.score >= 6500 ? "Climate detective" : S.score >= 4500 ? "Sharp eye" : S.score >= 2500 ? "Getting warmer" : "Back to the archive";
    const list = el("ul", { class: "recap" });
    S.results.forEach((r) => list.append(el("li", {},
      el("span", { class: r.lp + r.yp >= 700 ? "dot ok" : r.lp + r.yp >= 300 ? "dot mid" : "dot no", "aria-hidden": "true" }),
      el("span", { class: "row-t" }, el("b", { text: r.ev.name }), el("small", { text: `${placeName(r.ev.loc)}, ${r.ev.year}` })),
      el("span", { class: "pts", text: String(r.lp + r.yp) }))));
    $("legend").hidden = true;

    // name entry, then the board
    const slot = el("div", { class: "save" });
    const input = el("input", { id: "player-name", type: "text", maxlength: 24, placeholder: "Your name", autocomplete: "nickname", value: lastName() });
    const btn = el("button", { class: "primary", type: "submit" }, "Save score");
    const msg = el("p", { class: "fine", role: "status" });
    const form = el("form", { class: "name-form", onsubmit: async (e) => {
      e.preventDefault();
      const name = input.value.trim().slice(0, 24);
      if (!name) { msg.textContent = "Type a name to save your score."; input.focus(); return; }
      btn.disabled = true; btn.textContent = "Saving…";
      try { localStorage.setItem("ww-name", name); } catch {}
      const res = await saveScore({ name, score: S.score, mode: S.mode, at: new Date().toISOString(), v: 1 });
      if (res.error) { msg.textContent = res.error; btn.disabled = false; btn.textContent = "Save score"; return; }
      slot.innerHTML = "";
      slot.append(el("p", { class: "fine", text: res.rank ? `Saved as ${name}: number ${res.rank} in ${S.mode === "expert" ? "Expert" : "Noob"}.` : `Saved as ${name}.` }), boardView(S.mode, res.id));
    } },
      el("label", { class: "label", for: "player-name", text: "Add your score to the top ten" }),
      el("div", { class: "name-row" }, input, btn), msg);
    slot.append(form);

    panel(
      el("p", { class: "eyebrow", text: `${S.mode === "expert" ? "Expert" : "Noob"} · final score` }),
      el("h2", { class: "big" }, S.score.toLocaleString("en"), el("small", { text: ` / ${(ROUNDS * 1000).toLocaleString("en")}` })),
      el("p", { class: "when", text: isBest && best ? `${verdict}. New personal best (was ${best.toLocaleString("en")}).` : verdict }),
      slot,
      el("details", { class: "recap-wrap" }, el("summary", { text: "Your rounds" }), list),
      el("div", { class: "cta two" },
        el("button", { class: "ghost", type: "button", onclick: intro }, "Change mode"),
        el("button", { class: "primary", type: "button", onclick: () => start(S.mode) }, "Play again")),
    );
  }

  // Leaderboard overlay: opens over whatever screen is showing and leaves the game untouched.
  let lbReturnFocus = null;
  function openBoard() {
    const p = $("lb-panel");
    lbReturnFocus = document.activeElement;
    $("lb-slot").innerHTML = "";
    $("lb-slot").append(boardView(S.mode || "noob", null));
    p.hidden = false;
    $("lb-open").setAttribute("aria-expanded", "true");
    $("lb-back").textContent = S.mode && S.i < ROUNDS ? "Back to the game" : "Close";
    $("lb-close").focus({ preventScroll: true });
  }
  function closeBoard() {
    $("lb-panel").hidden = true;
    $("lb-open").setAttribute("aria-expanded", "false");
    if (lbReturnFocus && document.contains(lbReturnFocus)) lbReturnFocus.focus({ preventScroll: true });
  }
  $("lb-open").addEventListener("click", () => ($("lb-panel").hidden ? openBoard() : closeBoard()));

  // Restart: always visible. Mid-game it asks for a second tap so a stray click doesn't wipe a run.
  let restartArmed = null;
  $("restart").addEventListener("click", () => {
    const b = $("restart");
    const inGame = S.mode && S.i < ROUNDS && (S.answered || S.i > 0 || S.pick.loc || S.pick.year);
    if (inGame && !restartArmed) {
      b.textContent = "Tap again to restart"; b.classList.add("armed");
      restartArmed = setTimeout(() => { restartArmed = null; b.textContent = "Restart"; b.classList.remove("armed"); }, 3000);
      return;
    }
    clearTimeout(restartArmed); restartArmed = null; b.textContent = "Restart"; b.classList.remove("armed");
    if (!$("lb-panel").hidden) closeBoard();
    intro();
  });
  $("lb-close").addEventListener("click", closeBoard);
  $("lb-back").addEventListener("click", closeBoard);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("lb-panel").hidden) closeBoard(); });

  // ------------------------------------------------------------ init
  let rt;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const view = $("stage").dataset.view;
      const ev = S.mode && S.i < ROUNDS ? S.rounds[S.i] : INTRO_EV;
      if (ev?.map && (view === "map" || view === "intro")) drawMap(ev, S.answered && /^\d+$/.test(ev.loc) ? ev.loc : null);
    }, 120);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && S.answered && $("lb-panel").hidden && document.activeElement?.id !== "next" && $("next")) $("next").click();
  });
  READY.then(intro, (e) => panel(el("h2", { text: "CANguesser" }), el("p", { class: "fine", text: `The quiz could not load (${e.message}). Reload the page to try again.` })));
})();
