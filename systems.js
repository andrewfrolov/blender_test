// Systems mode for the house viewer: an x-ray of the house's services (drains, water, heating,
// ventilation, AC, data, power). Two ways in:
//   - locally, review.js starts it with the review server's live data (/review/api/services =
//     tools/services.py json, the models in blender/services/), polled so edits show up by themselves;
//   - on the published site (GitHub Pages), viewer/index.html starts it with { src: "services.json" },
//     a snapshot that tools/publish.py writes next to a copy of this file. View-only, read once.
//
// "⚙ Systems" (or S) hides the furniture, turns the walls, floors and roof into a faint ghost with
// outlines, and draws the systems: each sub-system in its colour, existing paler, assumed half
// transparent, removed red. The panel switches systems, sub-systems and statuses on and off, lists
// what the checks found (click one to fly there), the open questions and the assumptions. Hover
// a pipe for its size, length, falls and where it runs.
//
// Locally the review mode (review.js) passes opts.review: then the checks are listed on the right, in
// the review panel's Checks tab, by priority, and clicking a warning's pin opens it there to discuss
// (a review note about the issue) or acknowledge it. Acknowledged warnings get a green ring.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

let API = "review/api/services", live = true;   // start() switches to a static snapshot
const POLL_MS = 3000;
const B = (x, y, z) => new THREE.Vector3(x, z, -y);              // Blender -> three
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, el = document) => el.querySelector(sel);

// what stays in the systems mode: the shell as a ghost; the rest is hidden, except each system's
// context objects (e.g. the wet fixtures with the drains)
const STRUCTURE = /^((ground|first|attic)_(Walls|Walls_Tops|Floor|Windows_Doors)|Flat_Roof|Roof|Arch_Stair|Arch_Stair_Wall|first_Hall_Stair|attic_Lining)$/;
const STATUS_COLOUR = { existing: "#8f959c", new: "#2e9d4f", removed: "#d64541" };  // Formae's sheets
const SEV = { error: ["#e0392b", "Error"], warning: ["#e58e1a", "Warning"], info: ["#5b8bd0", "Note"] };
const SEV_MEANS = {
  error: "An error: as drawn this can't be built, or it breaks a rule. The model has to change.",
  warning: "A warning: it can be built, but it needs a decision, a detail for the installer or someone's OK. Acknowledge it once that's settled.",
  info: "A note, for information.",
};
const ACK = "#2f9e44";          // the ring of an acknowledged warning
const STOREYS = [["ground", "Ground", 0, 0], ["first", "First", 2.715, 1], ["attic", "Attic", 5.43, 2]];

let V, doc = null, etag = null, loadError = null;
let review = null;              // the review mode's hooks (locally): status(key), open(key), show(), changed()
let on = false, ui, toggle, tip;
let roles = new Map();          // root child -> "structure" | "context:<system>" | "hide"
let originals = new Map();      // mesh -> its material, while ghosted
let edges = [];                 // outline LineSegments added to the structure
const ghostMat = new THREE.MeshBasicMaterial({ color: 0xc3c7cf, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
const edgeMat = new THREE.LineBasicMaterial({ color: 0x59606b, transparent: true, opacity: 0.45, depthWrite: false });
const contextMat = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, roughness: 0.6, transparent: true, opacity: 0.7, depthWrite: false });
let world;                      // the systems' own scene graph
const G = {};                   // its groups: pipes, points, boxes, issues
let selected = null;            // { type: "run" | "point" | "box" | "issue", id } (an issue's id is its key)
let prefs = {
  systems: {}, subs: {}, status: { existing: true, new: true, removed: true, assumed: true },
  colourBy: "system", ghost: 0.16, fixtures: true, boxes: true, issues: true, info: false,
  only: true,     // a storey alone (the viewer's cut-away levels show everything up to it)
};

const CSS = `
#sy { position: absolute; left: 12px; bottom: 12px; width: 318px; max-height: calc(100% - 150px); overflow-y: auto;
      background: rgba(255,255,255,.95); border-radius: 10px; box-shadow: 0 4px 22px rgba(0,0,0,.2); z-index: 29;
      display: none; font-size: 12.5px; }
#sy.on { display: block; }
body.sy-on #hint { display: none; }
#sy section { padding: 8px 12px; border-bottom: 1px solid rgba(0,0,0,.07); }
#sy h3 { margin: 0 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; font-weight: 600; }
#sy .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px 6px; position: sticky; top: 0; background: rgba(255,255,255,.97); z-index: 1; }
#sy .head b { flex: 1; font-size: 14px; }
#sy button { border: 0; border-radius: 6px; padding: 4px 8px; background: rgba(0,0,0,.07); color: inherit; cursor: pointer; font: inherit; }
#sy button:hover { background: rgba(0,0,0,.12); }
#sy button.on { background: var(--accent); color: #fff; }
#sy button:disabled { opacity: .45; cursor: default; }
#sy .row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; }
#sy label { cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
#sy .sys { margin: 4px 0; }
#sy .sys > label { font-weight: 600; }
#sy .sys.planned { opacity: .5; }
#sy .subs { margin: 2px 0 4px 20px; display: grid; grid-template-columns: 1fr auto; gap: 1px 8px; }
#sy .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; }
#sy .len { opacity: .55; text-align: right; }
#sy .iss { padding: 4px 6px; margin: 2px -6px; border-radius: 6px; cursor: pointer; display: flex; gap: 6px; }
#sy .iss:hover, #sy .iss.sel { background: rgba(0,0,0,.05); }
#sy .dot { min-width: 8px; height: 8px; border-radius: 4px; margin-top: 4px; }
#sy details summary { cursor: pointer; }
#sy details ul { margin: 4px 0; padding-left: 16px; }
#sy details li { margin: 2px 0; }
#sy table { border-collapse: collapse; width: 100%; }
#sy td { padding: 1px 4px 1px 0; }
#sy td.n { text-align: right; }
#sy .sel-box { background: #f4f7fb; border-radius: 8px; padding: 7px 9px; }
#sy .muted { opacity: .6; }
#sy .err { color: #b3261e; white-space: pre-wrap; font: 11px ui-monospace, monospace; max-height: 160px; overflow: auto; }
#sy input[type=range] { width: 120px; }
#sy-tip { position: fixed; z-index: 35; pointer-events: none; background: rgba(25,25,28,.92); color: #fff; padding: 7px 9px;
          border-radius: 7px; font-size: 12px; max-width: 320px; display: none; line-height: 1.35; }
#sy-tip b { font-weight: 600; }
#sy-tip .m { opacity: .7; }
.sy-issue { line-height: 1.4; }
.sy-issue .sy-iss-head { font-size: 12px; margin-bottom: 4px; }
.sy-issue .sy-iss-text { font-weight: 600; margin-bottom: 6px; }
.sy-issue .sy-why { margin-bottom: 6px; }
.sy-issue .sy-means { font-size: 12px; opacity: .7; margin-bottom: 6px; }
.sy-issue .sy-what { font-size: 12px; background: #f4f7fb; border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; }
.sy-issue h4 { margin: 0 0 3px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
.sy-issue .m { opacity: .65; }
`;

// --- start -----------------------------------------------------------------------------------
// opts.src: a static services.json to read once instead of the review server's live data
// opts.review: the review mode's hooks, see the top
export function start(viewer, opts = {}) {
  V = viewer;
  if (opts.src) { API = opts.src; live = false; }
  review = opts.review || null;
  document.head.insertAdjacentHTML("beforeend", `<style>${CSS}</style>`);
  try { Object.assign(prefs, JSON.parse(localStorage.getItem("sy-prefs") || "{}")); } catch {}
  toggle = document.createElement("button");
  toggle.textContent = "⚙ Systems";
  toggle.title = "X-ray of the drains, pipes, ducts and cables (S)";
  toggle.onclick = () => setOn(!on);
  $("#ui").append(toggle);

  ui = document.createElement("aside");
  ui.id = "sy";
  document.body.append(ui);
  ui.addEventListener("click", onPanelClick);
  ui.addEventListener("change", onPanelChange);
  ui.addEventListener("input", e => { if (e.target.matches(".sy-ghost")) { prefs.ghost = +e.target.value; ghostMat.opacity = prefs.ghost; save(); } });
  ui.addEventListener("keydown", e => e.stopPropagation());
  tip = document.createElement("div");
  tip.id = "sy-tip";
  document.body.append(tip);

  world = new THREE.Group();
  world.name = "systems";
  world.visible = false;
  for (const k of ["boxes", "pipes", "points", "issues"]) {
    G[k] = new THREE.Group();
    world.add(G[k]);
  }
  V.scene.add(world);
  classify();
  const prev = V.scene.onBeforeRender;
  V.scene.onBeforeRender = (...a) => { if (on) applyVisibility(); prev?.(...a); };

  const el = V.renderer.domElement;
  let down = null, last = 0;
  el.addEventListener("pointerdown", e => (down = [e.clientX, e.clientY]));
  el.addEventListener("pointerup", e => {
    if (!on || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    pickAt(e, true);
  });
  el.addEventListener("pointermove", e => {
    if (!on || performance.now() - last < 40) return;
    last = performance.now();
    pickAt(e, false);
  });
  el.addEventListener("pointerleave", () => (tip.style.display = "none"));
  addEventListener("keydown", onKey);

  poll();
  if (live) setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  let want = new URLSearchParams(location.search).has("systems");
  try { want ||= localStorage.getItem("sy-on") === "1"; } catch {}
  if (want) setOn(true);
  console.log("systems mode ready");
}

function save() {
  try { localStorage.setItem("sy-prefs", JSON.stringify(prefs)); } catch {}
}

// --- on / off: ghost the house -------------------------------------------------------------------
function classify() {
  roles.clear();
  for (const o of V.root.children) {
    if (STRUCTURE.test(o.name)) roles.set(o, "structure");
    else roles.set(o, "hide");
  }
}

function contextRoles() {
  if (!doc) return false;
  const res = doc.systems.filter(s => s.context).map(s => [s.id, new RegExp(s.context)]);
  let changed = false;
  for (const o of V.root.children) {
    if (roles.get(o) === "structure") continue;
    const sys = res.find(([, re]) => re.test(o.name));
    const role = sys ? "context:" + sys[0] : "hide";
    changed ||= roles.get(o) !== role;
    roles.set(o, role);
  }
  return changed;
}

function setOn(v) {
  on = v;
  try { localStorage.setItem("sy-on", on ? "1" : "0"); } catch {}
  toggle.classList.toggle("on", on);
  ui.classList.toggle("on", on);
  document.body.classList.toggle("sy-on", on);
  world.visible = on;
  if (on) {
    V.pauseTour?.();
    ghost(true);
    const s = V.state();
    if (s.view === "album" || s.room || s.tour != null) overview();
  } else {
    ghost(false);
    tip.style.display = "none";
    const level = V.state().level;
    for (const o of V.root.children) o.visible = (o.userData.level ?? 0) <= level;
  }
  render();
  review?.changed();
}

function ghost(onOff) {
  if (onOff) {
    ghostMat.opacity = prefs.ghost;
    for (const [o, role] of roles) {
      if (role !== "structure" && !role.startsWith("context:")) continue;
      o.traverse(m => {
        if (!m.isMesh || originals.has(m)) return;
        originals.set(m, m.material);
        m.material = role === "structure" ? ghostMat : contextMat;
        m.castShadow = false;
        if (role === "structure" && m.geometry.attributes.position?.array) {
          try {
            const l = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30), edgeMat);
            l.raycast = () => {};
            m.add(l);
            edges.push(l);
          } catch {}
        }
      });
    }
  } else {
    originals.forEach((mat, m) => (m.material = mat));
    originals.clear();
    edges.forEach(l => { l.parent?.remove(l); l.geometry.dispose(); });
    edges = [];
  }
}

function level() {
  return V.state().level;
}

// every frame in the systems mode (the viewer's own level switches would show the furniture again)
function applyVisibility() {
  const lv = level();
  const shows = l => (prefs.only && lv < 3 ? l === lv : l <= lv);
  for (const [o, role] of roles) {
    const ok = shows(o.userData.level ?? 0);
    if (role === "structure") o.visible = ok;
    else if (role.startsWith("context:")) o.visible = ok && prefs.fixtures && sysOn(role.slice(8));
    else o.visible = false;
  }
  for (const g of [G.pipes, G.points, G.boxes, G.issues])
    for (const m of g.children) m.visible = m.userData.show && shows(m.userData.level);
  G.boxes.visible = prefs.boxes;
  G.issues.visible = prefs.issues;
}

function overview() {
  V.goTo({ pos: B(15.5, -6.5, 10.5), target: B(5.4, 6.2, 2.0), level: 3 });
}

function storeyView(i, plan) {
  const [, , z, lv] = STOREYS[i];
  const cx = 4.7, cy = 6.4;
  // near-orthographic: a long lens from high up, so the walls stand straight
  if (plan) V.goTo({ pos: B(cx, cy - 0.01, z + 50), target: B(cx, cy, z), level: lv, hfov: 2 * Math.atan(8.5 / 50), shiftY: 0, near: 30 });
  else V.goTo({ pos: B(13.5, -4.5, z + 9.5), target: B(5.2, 6.0, z + 0.6), level: lv });
}

// --- data ------------------------------------------------------------------------------------
async function poll() {
  try {
    const r = await fetch(API, { headers: etag ? { "If-None-Match": etag } : {}, cache: "no-cache" });
    if (r.status === 304) return;
    const body = await r.json();
    if (!r.ok) { loadError = body.error || r.statusText; render(); return; }
    etag = r.headers.get("ETag");
    doc = body;
    loadError = null;
    for (const s of doc.systems) {
      prefs.systems[s.id] ??= !s.planned;
      for (const u of s.subs) prefs.subs[s.id + "/" + u.id] ??= true;
    }
    if (contextRoles() && on) { ghost(false); ghost(true); }
    build();
  } catch (e) {
    if (!doc) { loadError = String(e); render(); }
  }
}

const sysOn = id => !!prefs.systems[id];
const subOf = (system, sub) => doc?.systems.find(s => s.id === system)?.subs.find(u => u.id === sub);
const sysName = id => doc?.systems.find(s => s.id === id)?.name ?? id;
const keyOf = (is, k) => is.key ?? "k" + k;                       // an older services.json has no keys
const issueBy = key => doc?.issues.find((is, k) => keyOf(is, k) === key);
const ackOf = key => review?.status(key) === "acknowledged";
const whereOf = is => !is.at ? "" : is.at[2] < -0.15 ? "crawl space" : ["ground floor", "first floor", "attic"][is.level] ?? "";
function showItem(it) {
  const st = prefs.status;
  return sysOn(it.system) && (it.sub == null || prefs.subs[it.system + "/" + it.sub] !== false)
    && st[it.status] !== false && (!it.assumed || st.assumed);
}

// --- the 3D systems --------------------------------------------------------------------------
const matCache = new Map();
function material(item, hi = false) {
  const style = item.status === "removed" ? "removed" : item.assumed ? "assumed" : item.status;
  const base = prefs.colourBy === "status" ? STATUS_COLOUR[item.status] : (subOf(item.system, item.sub)?.colour ?? "#888");
  const key = `${base}/${style}/${hi}`;
  if (matCache.has(key)) return matCache.get(key);
  const c = new THREE.Color(base);
  if (style === "existing") c.lerp(new THREE.Color(0xffffff), 0.25);
  if (style === "removed" && prefs.colourBy !== "status") c.set(STATUS_COLOUR.removed);
  const m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.05,
    emissive: hi ? new THREE.Color(0xffffff) : c.clone().multiplyScalar(0.25), emissiveIntensity: hi ? 0.35 : 1,
    transparent: style === "assumed" || style === "removed", opacity: style === "assumed" ? 0.5 : style === "removed" ? 0.35 : 1,
    depthWrite: !(style === "assumed" || style === "removed") });
  matCache.set(key, m);
  return m;
}

// remove a group's objects; materials from matCache are shared (userData.shared) and disposed by build()
function clear(g) {
  for (const m of [...g.children]) {
    g.remove(m);
    m.traverse(o => { o.geometry?.dispose(); if (!o.userData.shared) o.material?.dispose?.(); });
  }
}

function tube(a, b, r) {
  const va = B(...a), vb = B(...b), len = va.distanceTo(vb);
  if (len < 1e-4) return null;
  const g = new THREE.CylinderGeometry(r, r, len, 14, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize()));
  g.translate((va.x + vb.x) / 2, (va.y + vb.y) / 2, (va.z + vb.z) / 2);
  return g;
}

// a flat duct bundle (Run.section: width, height, how many side by side, mm) as boxes: lying flat along
// a horizontal segment; a vertical one keeps its width across the run's horizontal direction
const FLAT_GAP = 0.010;
const flatSize = s => [(s[2] * s[0]) / 1000 + (s[2] - 1) * FLAT_GAP, s[1] / 1000];

function acrossOf(path) {
  for (let i = 0; i + 1 < path.length; i++) {
    const h = B(...path[i + 1]).sub(B(...path[i])).setY(0);
    if (h.length() > 0.01) return new THREE.Vector3().crossVectors(h.normalize(), new THREE.Vector3(0, 1, 0)).normalize();
  }
  return new THREE.Vector3(1, 0, 0);
}

function flatBasis(a, b, across) {
  const d = B(...b).sub(B(...a)).normalize();
  const side = Math.abs(d.y) > 0.9 ? across.clone() : new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0)).normalize();
  return new THREE.Matrix4().makeBasis(side, new THREE.Vector3().crossVectors(side, d).normalize(), d);
}

function slab(a, b, w, h, across) {
  const va = B(...a), vb = B(...b), len = va.distanceTo(vb);
  if (len < 1e-4) return null;
  const g = new THREE.BoxGeometry(w, h, len);
  g.applyMatrix4(flatBasis(a, b, across));
  g.translate((va.x + vb.x) / 2, (va.y + vb.y) / 2, (va.z + vb.z) / 2);
  return g;
}

function flatJoint(prev, p, next, w, h, across) {
  const horiz = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.01;
  const [a, b] = horiz(prev, p) ? [prev, p] : [p, next];
  const g = new THREE.BoxGeometry(w, h, w);
  g.applyMatrix4(flatBasis(a, b, across));
  const v = B(...p);
  g.translate(v.x, v.y, v.z);
  return g;
}

const sizeText = r => r.section?.length === 3 ? `${r.section[2] > 1 ? r.section[2] + " × " : ""}${r.section[0]}×${r.section[1]} flat`
  : `Ø${r.size}`;

function joint(p, r) {
  const g = new THREE.SphereGeometry(r, 14, 10);
  const v = B(...p);
  g.translate(v.x, v.y, v.z);
  return g;
}

// a run's segment cut where the viewer's level changes, each piece with its level
function pieces(a, b) {
  const bounds = doc.levels.bounds, lvl = z => bounds.filter(t => z >= t).length;
  const ts = bounds.filter(t => (a[2] - t) * (b[2] - t) < 0).map(t => (t - a[2]) / (b[2] - a[2])).sort((p, q) => p - q);
  const at = t => a.map((c, k) => c + t * (b[k] - c));
  const cuts = [0, ...ts, 1];
  return cuts.slice(1).map((t, i) => {
    const p = at(cuts[i]), q = at(t);
    return [p, q, lvl((p[2] + q[2]) / 2)];
  });
}

function build() {
  for (const g of [G.pipes, G.points, G.boxes, G.issues]) clear(g);
  matCache.forEach(m => m.dispose());
  matCache.clear();
  if (!doc) return render();
  for (const run of doc.runs) {
    const r = Math.max(run.size / 2000, 0.011);
    const flat = run.section?.length === 3, [fw, fh] = flat ? flatSize(run.section) : [0, 0];
    const across = flat ? acrossOf(run.path) : null;
    const byLevel = new Map();
    run.path.forEach((p, i) => {
      if (i === run.path.length - 1) return;
      pieces(p, run.path[i + 1]).forEach(([a, b, lv], k) => {
        const list = byLevel.get(lv) || [];
        const t = flat ? slab(a, b, fw, fh, across) : tube(a, b, r);
        if (t) list.push(t);
        if (i > 0 && k === 0) list.push(flat ? flatJoint(run.path[i - 1], p, run.path[i + 1], fw, fh, across) : joint(p, r));
        byLevel.set(lv, list);
      });
    });
    for (const [lv, geoms] of byLevel) {
      if (!geoms.length) continue;
      const mesh = new THREE.Mesh(mergeGeometries(geoms.map(g => g.toNonIndexed()), false), material(run, isSel("run", run.id)));
      geoms.forEach(g => g.dispose());
      mesh.userData = { type: "run", id: run.id, level: lv, show: showItem(run), shared: true };
      mesh.renderOrder = 2;
      G.pipes.add(mesh);
    }
  }
  for (const p of doc.points) {
    if (p.box && p.box.length === 6) { G.points.add(equipment(p)); continue; }
    const r = p.kind === "outlet" ? 0.085 : p.kind === "vent" ? 0.075 : p.kind === "fitting" ? 0.03 : 0.05;
    const g = p.kind === "vent" ? new THREE.ConeGeometry(r, r * 2, 16) : new THREE.SphereGeometry(r, 16, 12);
    const v = B(...p.at);
    g.translate(v.x, v.y + (p.kind === "vent" ? r : 0), v.z);
    const m = new THREE.Mesh(g, material({ ...p, assumed: false }, isSel("point", p.id)));
    m.userData = { type: "point", id: p.id, level: p.level, show: showItem(p), shared: true };
    G.points.add(m);
  }
  for (const bx of doc.boxes) {
    if (!bx.drawn) continue;
    const [x0, y0, x1, y1] = bx.rect, [z0, z1] = bx.z;
    const g = new THREE.BoxGeometry(x1 - x0, z1 - z0, y1 - y0);
    const c = B((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    g.translate(c.x, c.y, c.z);
    const keep = bx.kind === "keepout", space = bx.kind === "space";
    const colour = keep ? 0x7a1f8a : space ? 0x1f8a85 : bx.status === "new" ? 0xe5533d : 0x8a8f99;
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: colour, transparent: true,
      opacity: keep ? 0.10 : space ? 0.06 : bx.status === "new" ? 0.13 : 0.08, depthWrite: false }));
    const l = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.8 }));
    l.raycast = () => {};
    m.add(l);
    m.userData = { type: "box", id: bx.id, level: bx.level, show: sysOn(bx.system) };
    G.boxes.add(m);
  }
  doc.issues.forEach((is, k) => {
    if (!is.at || (is.sev === "info" && !prefs.info)) return;
    const key = keyOf(is, k);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: issueTexture(is.sev, isSel("issue", key), ackOf(key)),
      sizeAttenuation: false, depthTest: false, depthWrite: false, toneMapped: false }));
    s.position.copy(B(...is.at));
    s.renderOrder = 1002;
    s.userData = { type: "issue", id: key, sev: is.sev, level: is.level, show: sysOn(is.system) };
    G.issues.add(s);
  });
  sizeSprites();
  render();
  review?.changed();
}

// the pins again, as the review notes say (acknowledged or not) and the selection
function paintIssues() {
  for (const s of G.issues?.children ?? []) s.material.map = issueTexture(s.userData.sev, isSel("issue", s.userData.id), ackOf(s.userData.id));
}

// a piece of equipment (a point with a box): a dark block outlined in its sub-system's colour, and
// round it the zone that must stay clear (a heat pump's R290 protection zone), as a faint cage
function equipment(p) {
  const [x0, y0, z0, x1, y1, z1] = p.box;
  const block = (pad) => {
    const g = new THREE.BoxGeometry(x1 - x0 + 2 * pad, z1 - z0 + 2 * pad, y1 - y0 + 2 * pad);
    const c = B((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    g.translate(c.x, c.y, c.z);
    return g;
  };
  const edge = prefs.colourBy === "status" ? STATUS_COLOUR[p.status] : (subOf(p.system, p.sub)?.colour ?? "#888");
  const sel = isSel("point", p.id);
  const g = block(0);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.7,
    emissive: sel ? 0xffffff : 0x000000, emissiveIntensity: sel ? 0.3 : 0, transparent: true, opacity: 0.85 }));
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: edge }));
  l.raycast = () => {};
  m.add(l);
  if (p.clear) {
    const zg = block(p.clear);
    const zone = new THREE.Mesh(zg, new THREE.MeshBasicMaterial({ color: 0x7a1f8a, transparent: true, opacity: 0.05, depthWrite: false }));
    const zl = new THREE.LineSegments(new THREE.EdgesGeometry(zg), new THREE.LineDashedMaterial({ color: 0x7a1f8a, dashSize: 0.08, gapSize: 0.06,
      transparent: true, opacity: 0.7 }));
    zl.computeLineDistances();
    zone.raycast = () => {};
    zl.raycast = () => {};
    zone.add(zl);
    m.add(zone);
  }
  m.userData = { type: "point", id: p.id, level: p.level, show: showItem(p) };
  return m;
}

const texCache = new Map();
// a pin: the severity's colour in a ring, white, or green once acknowledged; black round it when selected
function issueTexture(sev, sel, ack = false) {
  const key = `${sev}/${sel}/${ack}`;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  const disc = (r, colour) => { x.beginPath(); x.arc(32, 32, r, 0, 2 * Math.PI); x.fillStyle = colour; x.fill(); };
  if (sel) disc(31, "#111");
  if (ack) disc(sel ? 27 : 31, ACK);
  else if (!sel) disc(26, "#fff");
  x.beginPath();
  x.arc(32, 32, ack ? 19 : 21, 0, 2 * Math.PI);
  x.fillStyle = SEV[sev][0];
  x.fill();
  x.fillStyle = "#fff";
  x.font = "bold 30px -apple-system, system-ui, sans-serif";
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(sev === "info" ? "i" : "!", 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

function sizeSprites() {
  const s = 22 / innerHeight * 2 * Math.tan(THREE.MathUtils.degToRad(V.camera.fov) / 2);
  for (const sp of G.issues.children) sp.scale.setScalar(s);
}
setInterval(() => { if (on && V) sizeSprites(); }, 250);

// --- picking and the tooltip --------------------------------------------------------------------
const ray = new THREE.Raycaster();
function pickAt(e, click) {
  if (!doc) return;
  ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2), V.camera);
  ray.params.Line = { threshold: 0.05 };
  const cand = [...G.issues.children, ...G.points.children, ...G.pipes.children, ...G.boxes.children]
    .filter(o => o.visible && o.parent.visible);
  const hits = ray.intersectObjects(cand, false);
  const hit = hits.find(h => h.object.userData.type !== "box") || hits[0];  // a pipe inside a boxing wins
  if (!hit) {
    tip.style.display = "none";
    if (click && selected) { selected = null; build(); }
    return;
  }
  const u = hit.object.userData;
  if (click) {
    selected = { type: u.type, id: u.id };
    build();
    if (u.type === "issue" && review) review.open(u.id);
    else $(".sy-selected", ui)?.scrollIntoView({ block: "nearest" });
    return;
  }
  tip.innerHTML = tipHTML(u.type, u.id);
  tip.style.display = "block";
  tip.style.left = Math.min(e.clientX + 14, innerWidth - 330) + "px";
  tip.style.top = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8) + "px";
}

const isSel = (type, id) => selected && selected.type === type && selected.id === id;
const fmtZones = z => Object.entries(z || {}).map(([k, v]) => `${k} ${v.toFixed(1)} m`).join(", ");
const statusText = it => `${it.status}${it.assumed ? ", assumed" : ""}`;

function tipHTML(type, id) {
  if (type === "run") {
    const r = doc.runs.find(x => x.id === id);
    const fall = r.fall ? ` · fall ${r.fall[0] === r.fall[1] ? r.fall[0] : r.fall[0] + "–" + r.fall[1]} cm/m` : "";
    return `<b>${esc(r.label)}</b><br>${esc(subOf(r.system, r.sub)?.name)} · ${sizeText(r)} · ${statusText(r)}<br>
      ${r.length.toFixed(2)} m${fall}${r.bends ? ` · ${r.bends} bends` : ""}<br><span class="m">${esc(fmtZones(r.zones))}</span>
      ${r.note ? `<br><span class="m">${esc(r.note)}</span>` : ""}${r.issues ? `<br>⚠ ${r.issues} issue${r.issues > 1 ? "s" : ""}` : ""}`;
  }
  if (type === "point") {
    const p = doc.points.find(x => x.id === id);
    const dims = p.box?.length === 6 ? [p.box[3] - p.box[0], p.box[4] - p.box[1], p.box[5] - p.box[2]].map(v => Math.round(v * 1000)).join(" × ") + " mm"
      : p.size ? `Ø${p.size}` : "";
    const zone = p.clear ? ` · ${p.clear} m zone kept clear` : "";
    return `<b>${esc(p.label)}</b><br>${p.kind}${dims ? " · " + dims : ""} · ${statusText(p)}${zone}${p.obj ? `<br><span class="m">${esc(p.obj)}</span>` : ""}
      ${p.note ? `<br><span class="m">${esc(p.note)}</span>` : ""}`;
  }
  if (type === "box") {
    const b = doc.boxes.find(x => x.id === id);
    const [x0, y0, x1, y1] = b.rect;
    return `<b>${esc(b.label)}</b><br>${b.kind === "keepout" ? "no pipes here" : b.kind === "space" ? "kept free for installing and servicing" : b.kind + " · " + b.status} · ${Math.round((x1 - x0) * 1000)} × ${Math.round((y1 - y0) * 1000)} mm,
      ${Math.round((b.z[1] - b.z[0]) * 1000)} mm high${b.note ? `<br><span class="m">${esc(b.note)}</span>` : ""}`;
  }
  if (type === "issue") {
    const is = issueBy(id);
    if (!is) return "";
    const st = review?.status(id);
    return `<b style="color:${SEV[is.sev][0]}">${SEV[is.sev][1]}</b> ${esc(is.text)}${st ? `<br><span class="m">${st === "acknowledged"
      ? "✓ acknowledged" : "discussed: " + esc(st)}</span>` : ""}${review ? '<br><span class="m">Click: details and discussion on the right</span>' : ""}`;
  }
  return "";
}

// --- the panel -------------------------------------------------------------------------------
function render() {
  if (!ui) return;
  const open = ui.scrollTop;
  if (!doc) {
    ui.innerHTML = `<div class="head"><b>Systems</b><button data-act="close">✕</button></div>
      <section>${loadError ? `Couldn't load the systems:<div class="err">${esc(loadError)}</div>` : "Loading…"}</section>`;
    return;
  }
  const len = {};
  for (const r of doc.runs) len[r.system + "/" + r.sub] = (len[r.system + "/" + r.sub] || 0) + r.length;
  const systems = doc.systems.map(s => {
    const subs = s.planned ? "" : `<div class="subs">${s.subs.filter(u => len[s.id + "/" + u.id]).map(u => `
        <label><input type="checkbox" data-sub="${s.id}/${u.id}" ${prefs.subs[s.id + "/" + u.id] !== false ? "checked" : ""}>
        <span class="sw" style="background:${u.colour}"></span>${esc(u.name)}</label>
        <span class="len">${(len[s.id + "/" + u.id] || 0).toFixed(1)} m</span>`).join("")}</div>`;
    return `<div class="sys${s.planned ? " planned" : ""}"><label><input type="checkbox" data-sys="${s.id}" ${prefs.systems[s.id] ? "checked" : ""}
      ${s.planned ? "disabled" : ""}> ${esc(s.name)}${s.planned ? ' <span class="muted">· to come</span>' : ""}</label>${subs}</div>`;
  }).join("");
  const st = prefs.status;
  const cb = (key, text, val) => `<label><input type="checkbox" data-pref="${key}" ${val ? "checked" : ""}> ${text}</label>`;
  const issues = doc.issues.map((is, k) => [is, keyOf(is, k)]).filter(([is]) => sysOn(is.system) && (prefs.info || is.sev !== "info"));
  const counts = ["error", "warning", "info"].map(s => [s, doc.issues.filter(i => i.sev === s && sysOn(i.system)).length]);
  const lv = level();
  ui.innerHTML = `
    <div class="head"><b>Systems</b><span class="muted">${live ? doc.generated.slice(11, 16) : doc.generated.slice(0, 10)}</span><button data-act="close" title="Leave the systems mode (S)">✕</button></div>
    <section><div class="row">
      ${STOREYS.map(([, name], i) => `<button data-storey="${i}" class="${lv === i ? "on" : ""}">${name}</button>`).join("")}
      <button data-act="all" class="${lv === 3 ? "on" : ""}">All</button>
      <button data-act="plan" title="Look straight down on the storey shown">Plan</button>
    </div></section>
    <section><h3>Systems</h3>${systems}</section>
    <section><h3>Show</h3><div class="row">
      ${cb("st:existing", "existing", st.existing)} ${cb("st:new", "new", st.new)} ${cb("st:removed", "removed", st.removed)}
      ${cb("st:assumed", "assumed", st.assumed)}</div>
      <div class="row" style="margin-top:5px">Colour by <button data-colour="system" class="${prefs.colourBy === "system" ? "on" : ""}">system</button>
      <button data-colour="status" class="${prefs.colourBy === "status" ? "on" : ""}">status</button></div>
      <div class="row" style="margin-top:5px">${cb("fixtures", "fixtures", prefs.fixtures)} ${cb("boxes", "boxings", prefs.boxes)}
      ${cb("issues", "issue pins", prefs.issues)} ${cb("only", "only the storey shown", prefs.only)}</div>
      <div class="row" style="margin-top:5px">Walls <input type="range" class="sy-ghost" min="0" max="0.6" step="0.02" value="${prefs.ghost}"></div>
    </section>
    ${selected ? `<section class="sy-selected"><h3>Selected</h3><div class="sel-box">${selectedHTML()}</div></section>` : ""}
    <section><h3>Checks</h3><div class="muted" style="margin-bottom:4px">${counts.map(([s, n]) => `${n} ${SEV[s][1].toLowerCase()}${n === 1 ? "" : "s"}`).join(" · ")}
      · <label><input type="checkbox" data-pref="info" ${prefs.info ? "checked" : ""}> notes</label></div>
      ${review ? `<button data-act="checks">List them by priority on the right ›</button>`
        : issues.length ? issues.map(([is, k]) => `<div class="iss${isSel("issue", k) ? " sel" : ""}" data-issue="${k}">
        <span class="dot" style="background:${SEV[is.sev][0]}"></span><span>${esc(is.text)}</span></div>`).join("") : '<span class="muted">Nothing found.</span>'}
    </section>
    ${doc.questions.length ? `<section><details open><summary><b>Open questions</b> (${doc.questions.filter(q => sysOn(q.system)).length})</summary><ul>
      ${doc.questions.filter(q => sysOn(q.system)).map(q => `<li>${esc(q.text)}</li>`).join("")}</ul></details></section>` : ""}
    <section><details><summary><b>Assumptions</b></summary><ul>${doc.assumptions.map(([, t]) => `<li>${esc(t)}</li>`).join("")}</ul></details></section>
    <section><details><summary><b>Quantities</b></summary><table>
      ${doc.quantities.filter(q => sysOn(q.system)).map(q => `<tr><td><span class="sw" style="background:${subOf(q.system, q.sub)?.colour}"></span></td>
        <td>${esc(subOf(q.system, q.sub)?.name)}</td><td>${esc(q.label || "Ø" + q.size)}</td><td>${q.status}</td><td class="n">${q.length.toFixed(1)} m</td></tr>`).join("")}
      </table><div class="muted" style="margin-top:4px">${doc.penetrations.filter(p => sysOn(p.system)).length} holes and sleeves${live ? `:
      <code>tools/services.py penetrations</code>` : ""}</div></details></section>
    ${loadError ? `<section><div class="err">${esc(loadError)}</div></section>` : ""}`;
  ui.scrollTop = open;
}

function selectedHTML() {
  const { type, id } = selected;
  let html = tipHTML(type, id);
  if (type === "run" || type === "point") {
    const ref = type === "run" ? id : "point:" + id;
    const its = doc.issues.filter(i => i.ref === ref);
    if (its.length) html += "<br>" + its.map(i => `<span style="color:${SEV[i.sev][0]}">●</span> ${esc(i.text)}`).join("<br>");
  }
  return html;
}

function onPanelClick(e) {
  const t = e.target;
  const act = t.closest("[data-act]")?.dataset.act;
  if (act === "close") return setOn(false);
  if (act === "checks") return review?.show();
  if (act === "all") { V.goTo({ pos: V.camera.position.clone(), target: V.controls.target.clone(), level: 3 }); return render(); }
  if (act === "plan") { const lv = level(); storeyView(Math.min(lv, 2), true); return render(); }
  const sb = t.closest("[data-storey]");
  if (sb) { storeyView(+sb.dataset.storey, false); return render(); }
  const cb = t.closest("[data-colour]");
  if (cb) { prefs.colourBy = cb.dataset.colour; save(); build(); return; }
  const iss = t.closest("[data-issue]");
  if (iss) focusIssue(iss.dataset.issue);
}

function onPanelChange(e) {
  const t = e.target;
  if (t.dataset.sys) prefs.systems[t.dataset.sys] = t.checked;
  else if (t.dataset.sub) prefs.subs[t.dataset.sub] = t.checked;
  else if (t.dataset.pref?.startsWith("st:")) prefs.status[t.dataset.pref.slice(3)] = t.checked;
  else if (t.dataset.pref) prefs[t.dataset.pref] = t.checked;
  else return;
  save();
  build();
}

function onKey(e) {
  if (e.target.closest?.("input, textarea, select")) return;
  if (e.key.toLowerCase() === "s" && !e.metaKey && !e.ctrlKey && !e.altKey) setOn(!on);
}

// --- for the review mode: the checks listed and discussed in its panel -------------------------
export const SEVERITY = SEV;
export const isOn = () => on;
export { setOn };
export const loaded = () => !!doc;
export const systemOn = id => sysOn(id);
export const systemName = id => sysName(id);
export const hasIssue = key => !!issueBy(key);

// what the checks found in the systems shown (and the notes, if they are on), in the checks' order
export function issues() {
  if (!doc) return [];
  return doc.issues.map((is, k) => ({ ...is, key: keyOf(is, k), systemName: sysName(is.system), where: whereOf(is) }))
    .filter(is => sysOn(is.system) && (prefs.info || is.sev !== "info"));
}

// select an issue's pin and fly to it
export function focusIssue(key, fly = true) {
  const is = issueBy(key);
  if (!is) return;
  selected = { type: "issue", id: key };
  if (fly && is.at) {
    const at = B(...is.at);
    V.goTo({ pos: at.clone().add(new THREE.Vector3(2.2, 1.6, 2.6)), target: at, level: Math.min(3, is.level) });
  }
  build();
}

// the review notes changed: the pins' rings
export function refresh() {
  paintIssues();
}

// an issue explained: what it is, why it matters, what it concerns, what else the checks say about that
export function issueDetail(key) {
  const is = issueBy(key);
  if (!is) return "";
  const where = whereOf(is), ref = is.ref || "";
  const what = ref.startsWith("point:") ? (doc.points.some(p => p.id === ref.slice(6)) ? tipHTML("point", ref.slice(6)) : "")
    : doc.runs.some(r => r.id === ref) ? tipHTML("run", ref) : "";
  const others = doc.issues.filter(i => i !== is && ref && i.ref === ref && i.sev !== "info");
  return `<div class="sy-issue">
    <div class="sy-iss-head"><b style="color:${SEV[is.sev][0]}">${SEV[is.sev][1]}</b> · ${esc(sysName(is.system))}${where ? " · " + where : ""}</div>
    <div class="sy-iss-text">${esc(is.text)}</div>
    ${is.why ? `<div class="sy-why">${esc(is.why)}</div>` : ""}
    <div class="sy-means">${SEV_MEANS[is.sev]}</div>
    ${what ? `<div class="sy-what"><h4>It concerns</h4>${what}</div>` : ""}
    ${others.length ? `<div class="sy-what"><h4>Also found there</h4>${others.map(i =>
      `<span style="color:${SEV[i.sev][0]}">●</span> ${esc(i.text)}`).join("<br>")}</div>` : ""}</div>`;
}

