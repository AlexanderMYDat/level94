import * as THREE from 'three';
import { GeoBuilder, ColliderBuilder } from './builder';
import type { MatKey } from './materials';
import type { FloaterDef } from './floaters';
import { mulberry32, lerp } from './noise';
import {
  heightAt, roadZ, roadDist, domes, addPath, addFootprint, pathAt, zonesClear,
  ROAD_HALF, PLAY_LIMIT, X0, X1, Z0, RIDGE_Z,
} from './terrain';

const GROUND_HOUSES = 40;   // casas en el suelo
const FLOATING_HOUSES = 48; // casas flotando en el cielo

const srgb = (hex: string) => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);
const SIDING = [
  ['#efe0a6', 3], ['#ebdcb8', 3], ['#f3f0e6', 2], ['#dcc78a', 1], ['#c8d5dc', 1], ['#d0dcc2', 1], ['#e6d2b5', 1],
] as const;
const ROOF = ['#6b5444', '#4a4644', '#7a4b3a', '#5a5550', '#3d3a38'].map(srgb);
const ACCENT = ['#2f4a35', '#1e1f22', '#28344f', '#5a2a27', '#f3f1ea'].map(srgb);
const TRIM = srgb('#ffffff');
const CAP = srgb('#3a3a3a');

function pickWeighted(rand: () => number) {
  const total = SIDING.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [c, w] of SIDING) { if ((r -= w) <= 0) return srgb(c); }
  return srgb(SIDING[0][0]);
}

export interface HouseSpec {
  w: number; d: number; wallH: number; stories: number; pitch: number;
  siding: THREE.Color; roof: THREE.Color; accent: THREE.Color;
  crossGable: boolean; crossX: number; chimney: boolean; chimneySide: number; shutters: boolean; uvOff: number;
}

export function randomSpec(rand: () => number): HouseSpec {
  const stories = rand() < 0.65 ? 2 : 1;
  const w = 7 + rand() * 4.5, d = 6 + rand() * 3;
  const wg = Math.min(w * 0.45, 4.2);
  return {
    w, d, stories, wallH: stories === 2 ? 5.6 : 3.0,
    pitch: THREE.MathUtils.degToRad(32 + rand() * 14),
    siding: pickWeighted(rand),
    roof: ROOF[Math.floor(rand() * ROOF.length)],
    accent: ACCENT[Math.floor(rand() * ACCENT.length)],
    crossGable: rand() < 0.4 && w > 8.5,
    crossX: (rand() - 0.5) * 2 * Math.max(0, w / 2 - wg / 2 - 0.8),
    chimney: rand() < 0.55, chimneySide: rand() < 0.5 ? -1 : 1,
    shutters: rand() < 0.35,
    uvOff: rand(),
  };
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

/**
 * Construye una casa en `b`. Sistema local: suelo interior en y = 0, fachada principal hacia +z.
 * `M` lleva la casa al mundo; `fd` es cuánto baja el cimiento de ladrillo (para apoyarse en pendientes).
 */
export function buildHouse(b: GeoBuilder, s: HouseSpec, M: THREE.Matrix4, fd: number) {
  const { w, d, wallH, pitch } = s;
  const rh = (d / 2) * Math.tan(pitch);
  const EAVE = 0.45, RAKE = 0.35;
  const W = (L: THREE.Matrix4) => new THREE.Matrix4().multiplyMatrices(M, L);
  const at = (x: number, y: number, z: number) => W(new THREE.Matrix4().makeTranslation(x, y, z));
  const box = (k: MatKey, bw: number, bh: number, bd: number, x: number, y: number, z: number, c?: THREE.Color, uvo = 0) =>
    b.box(k, bw, bh, bd, at(x, y, z), c, uvo);

  /** Caja orientada por una base (x, y, z) con centro `c`, en coordenadas locales de la casa. */
  const oriented = (k: MatKey, dims: [number, number, number], c: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3, col?: THREE.Color) =>
    b.box(k, dims[0], dims[1], dims[2], W(new THREE.Matrix4().makeBasis(x, y, z).setPosition(c)), col, s.uvOff);

  /** Faldón de tejado: `ridgeC` centro de la cumbrera, `along` dirección de la cumbrera, `down` pendiente abajo. */
  const roofSide = (ridgeC: THREE.Vector3, along: THREE.Vector3, down: THREE.Vector3, ridgeLen: number, slopeLen: number) => {
    let x = along.clone();
    let y = new THREE.Vector3().crossVectors(down, x);
    if (y.y < 0) { x = x.negate(); y = y.negate(); }
    const mid = ridgeC.clone().addScaledVector(down, slopeLen / 2);
    // sofito blanco debajo, tejas encima
    oriented('trim', [ridgeLen, 0.1, slopeLen], mid.clone().addScaledVector(y, 0.05), x, y, down, TRIM);
    oriented('roof', [ridgeLen, 0.07, slopeLen], mid.clone().addScaledVector(y, 0.135), x, y, down, s.roof);
    // tabla frontal (fascia) en el alero
    const eaveC = ridgeC.clone().addScaledVector(down, slopeLen - 0.03).addScaledVector(y, -0.04);
    oriented('trim', [ridgeLen, 0.26, 0.06], eaveC, x, y, down, TRIM);
    return { x, y };
  };

  // --- cimiento, muros, hastiales
  box('brick', w + 0.12, fd + 0.06, d + 0.12, 0, (-fd + 0.06) / 2, 0);
  box('siding', w, wallH, d, 0, wallH / 2, 0, s.siding, s.uvOff);
  for (const sx of [-1, 1]) {
    b.triangle('siding', V(sx * w / 2, wallH, -d / 2), V(sx * w / 2, wallH, d / 2), V(sx * w / 2, wallH + rh, 0),
      V(sx, 0, 0), V(0, 0, 1), M, s.siding);
  }

  // --- tejado principal (cumbrera a lo largo de x)
  const slopeLen = (d / 2 + EAVE) / Math.cos(pitch) + 0.08;
  const ridge = V(0, wallH + rh, 0);
  for (const sz of [-1, 1]) {
    const down = V(0, -Math.sin(pitch), sz * Math.cos(pitch));
    const start = ridge.clone().addScaledVector(down, -0.08);
    const { x, y } = roofSide(start, V(1, 0, 0), down, w + 2 * RAKE, slopeLen);
    // tablas de borde inclinadas en los hastiales
    for (const sx of [-1, 1]) {
      const c = start.clone().addScaledVector(down, slopeLen / 2).addScaledVector(y, 0.04);
      c.x = sx * (w / 2 + RAKE - 0.03);
      oriented('trim', [0.06, 0.28, slopeLen], c, x, y, down, TRIM);
    }
  }
  box('roof', w + 2 * RAKE + 0.02, 0.1, 0.34, 0, wallH + rh + 0.2, 0, s.roof.clone().multiplyScalar(0.8));

  // --- molduras: esquineras, friso, zócalo, cinta entre pisos
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box('trim', 0.15, wallH, 0.15, sx * w / 2, wallH / 2, sz * d / 2, TRIM);
  for (const sz of [-1, 1]) {
    box('trim', w, 0.22, 0.05, 0, wallH - 0.11, sz * (d / 2 + 0.025), TRIM);
    box('trim', w + 0.06, 0.2, 0.05, 0, 0.1, sz * (d / 2 + 0.025), TRIM);
    if (s.stories === 2) box('trim', w, 0.14, 0.04, 0, 2.86, sz * (d / 2 + 0.02), TRIM);
  }
  for (const sx of [-1, 1]) {
    box('trim', 0.05, 0.2, d + 0.06, sx * (w / 2 + 0.025), 0.1, 0, TRIM);
    if (s.stories === 2) box('trim', 0.04, 0.14, d, sx * (w / 2 + 0.02), 2.86, 0, TRIM);
  }

  // --- muros con ventanas: base (derecha, arriba, fuera) en la superficie de cada muro
  const walls = [
    { o: V(0, 0, d / 2), r: V(1, 0, 0), n: V(0, 0, 1), L: w, front: true },
    { o: V(0, 0, -d / 2), r: V(-1, 0, 0), n: V(0, 0, -1), L: w, front: false },
    { o: V(w / 2, 0, 0), r: V(0, 0, -1), n: V(1, 0, 0), L: d, front: false },
    { o: V(-w / 2, 0, 0), r: V(0, 0, 1), n: V(-1, 0, 0), L: d, front: false },
  ];
  for (const wall of walls) {
    const WM = W(new THREE.Matrix4().makeBasis(wall.r, UP, wall.n).setPosition(wall.o));
    const P = (x: number, y: number, z: number) => new THREE.Matrix4().multiplyMatrices(WM, new THREE.Matrix4().makeTranslation(x, y, z));
    const count = Math.max(1, Math.floor((wall.L - 1.0) / 2.3));
    const doorSlot = wall.front ? Math.floor(count / 2) : -1;
    for (let k = 0; k < count; k++) {
      const u = -wall.L / 2 + (k + 0.5) * (wall.L / count);
      // en hastial cruzado no hay ventana alta justo debajo (lo cubre la ventana del hastial)
      for (let f = 0; f < s.stories; f++) {
        if (f === 0 && k === doorSlot) { door(b, P, u, s.accent, fd); continue; }
        windowAt(b, P, u, 0.85 + f * 2.8, 0.9, 1.45, s.shutters ? s.accent : null);
      }
    }
    // ventanita del ático en los hastiales
    if (!wall.front && wall.L === d && rh > 1.6) windowAt(b, P, 0, wallH + 0.3, 0.6, Math.min(0.9, rh - 0.9), null);
  }

  // --- chimenea
  if (s.chimney) {
    const ch = rh + 1.1;
    const cx = s.chimneySide * (w / 2 - 0.9);
    box('brick', 0.72, ch, 0.72, cx, wallH + ch / 2, -d / 4);
    box('trim', 0.86, 0.09, 0.86, cx, wallH + ch + 0.045, -d / 4, CAP);
  }

  // --- hastial cruzado en la fachada
  if (s.crossGable) {
    const wg = Math.min(w * 0.45, 4.2);
    let pg = pitch + 0.08;
    let rhg = (wg / 2) * Math.tan(pg);
    if (rhg > rh * 0.8) { rhg = rh * 0.8; pg = Math.atan(rhg / (wg / 2)); }
    const cx = s.crossX;
    b.triangle('siding', V(cx - wg / 2, wallH, d / 2 + 0.01), V(cx + wg / 2, wallH, d / 2 + 0.01), V(cx, wallH + rhg, d / 2 + 0.01),
      V(0, 0, 1), V(1, 0, 0), M, s.siding);
    const z0 = (rh - rhg) / Math.tan(pitch) - 0.3, z1 = d / 2 + EAVE;
    const ridgeLen = z1 - z0;
    const ridgeC = V(cx, wallH + rhg, (z0 + z1) / 2);
    const sl = (wg / 2 + EAVE) / Math.cos(pg) + 0.06;
    for (const q of [-1, 1]) {
      const down = V(q * Math.cos(pg), -Math.sin(pg), 0);
      const start = ridgeC.clone().addScaledVector(down, -0.06);
      const { x, y } = roofSide(start, V(0, 0, 1), down, ridgeLen, sl);
      const c = start.clone().addScaledVector(down, sl / 2).addScaledVector(y, 0.04);
      c.z = z1 - 0.03;
      oriented('trim', [0.06, 0.28, sl], c, x, y, down, TRIM);
    }
    box('roof', 0.34, 0.1, ridgeLen, cx, wallH + rhg + 0.2, (z0 + z1) / 2, s.roof.clone().multiplyScalar(0.8));
    if (rhg > 1.5) {
      const WM = W(new THREE.Matrix4().makeTranslation(0, 0, d / 2 + 0.01));
      const P = (x: number, y: number, z: number) => new THREE.Matrix4().multiplyMatrices(WM, new THREE.Matrix4().makeTranslation(x, y, z));
      windowAt(b, P, cx, wallH + 0.25, 0.7, Math.min(1.1, rhg - 0.8), null);
    }
  }
}

type Place = (x: number, y: number, z: number) => THREE.Matrix4;

/** Ventana de guillotina con marco, alféizar, parteluces y contraventanas opcionales. */
function windowAt(b: GeoBuilder, P: Place, u: number, v0: number, ww: number, wh: number, shutter: THREE.Color | null) {
  const cy = v0 + wh / 2;
  b.box('glass', ww, wh, 0.03, P(u, cy, 0));
  b.box('trim', 0.11, wh + 0.1, 0.06, P(u - ww / 2 - 0.055, cy, 0.03), TRIM);
  b.box('trim', 0.11, wh + 0.1, 0.06, P(u + ww / 2 + 0.055, cy, 0.03), TRIM);
  b.box('trim', ww + 0.34, 0.15, 0.08, P(u, v0 + wh + 0.125, 0.04), TRIM);
  b.box('trim', ww + 0.26, 0.06, 0.13, P(u, v0 - 0.03, 0.065), TRIM);
  b.box('trim', ww, 0.1, 0.04, P(u, v0 - 0.11, 0.02), TRIM);
  b.box('trim', ww, 0.05, 0.04, P(u, v0 + 0.025, 0.02), TRIM);
  b.box('trim', ww, 0.05, 0.04, P(u, v0 + wh - 0.025, 0.02), TRIM);
  b.box('trim', ww, 0.055, 0.045, P(u, cy, 0.022), TRIM);
  b.box('trim', 0.03, wh, 0.035, P(u, cy, 0.02), TRIM);
  b.box('trim', ww, 0.03, 0.035, P(u, v0 + wh * 0.25, 0.02), TRIM);
  b.box('trim', ww, 0.03, 0.035, P(u, v0 + wh * 0.75, 0.02), TRIM);
  if (shutter) {
    for (const sx of [-1, 1]) b.box('trim', ww * 0.48, wh + 0.06, 0.04, P(u + sx * (ww / 2 + 0.12 + ww * 0.24), cy, 0.02), shutter);
  }
}

/** Puerta con cuarterones, marco, pomo y escalones de ladrillo. */
function door(b: GeoBuilder, P: Place, u: number, color: THREE.Color, fd: number) {
  b.box('trim', 1.0, 2.1, 0.05, P(u, 1.05, 0.025), color);
  for (const px of [-0.22, 0.22]) for (const py of [0.55, 1.5]) b.box('trim', 0.34, 0.72, 0.02, P(u + px, py, 0.06), color);
  b.box('trim', 0.12, 2.2, 0.06, P(u - 0.56, 1.1, 0.03), TRIM);
  b.box('trim', 0.12, 2.2, 0.06, P(u + 0.56, 1.1, 0.03), TRIM);
  b.box('trim', 1.4, 0.16, 0.08, P(u, 2.2, 0.04), TRIM);
  b.box('metal', 0.06, 0.06, 0.08, P(u + 0.38, 1.0, 0.09));
  const h = fd + 0.2;
  b.box('brick', 1.7, h, 1.0, P(u, -0.2 - h / 2, 0.5));
  b.box('brick', 1.7, h, 0.55, P(u, -0.42 - h / 2, 1.27));
}

export function houseColliders(c: ColliderBuilder, s: HouseSpec, M: THREE.Matrix4, fd: number) {
  const rh = (s.d / 2) * Math.tan(s.pitch);
  const T = (x: number, y: number, z: number) => new THREE.Matrix4().multiplyMatrices(M, new THREE.Matrix4().makeTranslation(x, y, z));
  c.box(s.w + 0.16, s.wallH + fd, s.d + 0.16, T(0, (s.wallH - fd) / 2, 0));
  c.prism(s.w + 0.7, s.d + 0.9, rh + 0.25, T(0, s.wallH - 0.25, 0));
  // escalones de la puerta (mismo hueco que en buildHouse)
  const count = Math.max(1, Math.floor((s.w - 1.0) / 2.3));
  const doorU = -s.w / 2 + (Math.floor(count / 2) + 0.5) * (s.w / count);
  c.box(1.7, fd, 1.55, T(doorU, -0.2 - fd / 2, s.d / 2 + 0.77));
}

// ---------- Distribución por el mundo ----------
export interface Fence { pts: [number, number][] }

interface Placed { x: number; z: number; rot: number; spec: HouseSpec; r: number }

export function placeHouses(materials: Record<MatKey, THREE.Material>, colliders: ColliderBuilder) {
  const rand = mulberry32(9401);
  const placed: Placed[] = [];
  const fences: Fence[] = [];
  const spawnZ = roadZ(0);

  // sin pisar senderos ya trazados (el del tablero y los de otras casas)
  const offPaths = (x: number, z: number, r: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      if (pathAt(x + Math.cos(a) * (r + 5), z + Math.sin(a) * (r + 5)) > 0.05) return false;
    }
    return pathAt(x, z) < 0.05;
  };
  const free = (x: number, z: number, r: number) =>
    Math.abs(x) < PLAY_LIMIT - 20 && Math.abs(z) < PLAY_LIMIT - 20 &&
    Math.abs(roadDist(x, z)) > r + ROAD_HALF + 6 &&
    Math.hypot(x, z - spawnZ) > r + 25 &&
    zonesClear(x, z, r) && offPaths(x, z, r) &&
    placed.every((p) => Math.hypot(p.x - x, p.z - z) > p.r + r + 14);

  const facing = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
  const nearestRoad = (x: number, z: number): [number, number] => {
    const xr = x + (rand() - 0.5) * 30, side = Math.sign(roadDist(x, z)) || 1;
    return [xr, roadZ(xr) + side * (ROAD_HALF + 0.4)];
  };

  const tryPlace = (x: number, z: number, rot: number | null, withPath: boolean) => {
    const spec = randomSpec(rand);
    const r = Math.hypot(spec.w, spec.d) / 2;
    if (!free(x, z, r)) return false;
    let target: [number, number] | null = null;
    if (rot === null) {
      if (withPath) { target = nearestRoad(x, z); rot = facing(x, z, target[0], target[1]); }
      else rot = rand() * Math.PI * 2;
    }
    placed.push({ x, z, rot, spec, r });
    if (target) {
      // sendero curvo desde la puerta hasta la carretera
      const fx = Math.sin(rot), fz = Math.cos(rot);
      const sx = x + fx * (spec.d / 2 + 1.6), sz = z + fz * (spec.d / 2 + 1.6);
      const [tx, tz] = target;
      const mx = (sx + tx) / 2, mz = (sz + tz) / 2, len = Math.hypot(tx - sx, tz - sz);
      const off = (rand() - 0.5) * 0.5 * len;
      const cx = mx + (-(tz - sz) / len) * off, cz = mz + ((tx - sx) / len) * off;
      const pts: [number, number][] = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24, a = (1 - t) * (1 - t), bb = 2 * (1 - t) * t, c = t * t;
        pts.push([a * sx + bb * cx + c * tx, a * sz + bb * cz + c * tz]);
      }
      addPath(pts, 1.05);
    }
    return true;
  };

  // 1) casas en lo alto de las cúpulas
  for (const d of domes) {
    if (Math.abs(d.x) > PLAY_LIMIT - 40 || Math.abs(d.z) > PLAY_LIMIT - 40 || rand() > 0.6) continue;
    tryPlace(d.x + (rand() - 0.5) * d.r * 0.15, d.z + (rand() - 0.5) * d.r * 0.15, null, Math.abs(roadDist(d.x, d.z)) < 320);
  }
  // 2) junto a la carretera, mirando hacia ella
  for (let x = -PLAY_LIMIT + 60; x < PLAY_LIMIT - 60; x += 60 + rand() * 70) {
    const side = rand() < 0.5 ? -1 : 1, dist = 24 + rand() * 14;
    tryPlace(x, roadZ(x) + side * dist, null, true);
  }
  // 3) repartidas por las colinas
  for (let tries = 0; placed.length < GROUND_HOUSES && tries < 4000; tries++) {
    tryPlace((rand() * 2 - 1) * (PLAY_LIMIT - 30), (rand() * 2 - 1) * (PLAY_LIMIT - 30), null, false);
  }

  // Construcción, agrupada en bloques de 250 m (menos draw calls, sigue habiendo culling)
  const chunks = new Map<string, GeoBuilder>();
  const group = new THREE.Group();
  for (const p of placed) {
    const { spec: s } = p;
    const c = Math.cos(p.rot), sn = Math.sin(p.rot);
    let maxH = -1e9, minH = 1e9;
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0], [0, 1], [0, -1], [1, 0], [-1, 0], [0, 1.6]]) {
      const ax = lx * (s.w / 2 + 0.3), az = lz * (s.d / 2 + 0.3);
      const h = heightAt(p.x + c * ax + sn * az, p.z - sn * ax + c * az);
      maxH = Math.max(maxH, h); minH = Math.min(minH, h);
    }
    const tilt = rand() < 0.22 ? THREE.MathUtils.degToRad(1.5 + rand() * 4) : 0;
    const tiltAxis = rand() * Math.PI * 2;
    const floorY = maxH + 0.45;
    const fd = floorY - minH + 0.7 + Math.sin(tilt) * Math.max(s.w, s.d);
    const M = new THREE.Matrix4().makeTranslation(p.x, floorY, p.z)
      .multiply(new THREE.Matrix4().makeRotationY(p.rot))
      .multiply(new THREE.Matrix4().makeRotationAxis(V(Math.cos(tiltAxis), 0, Math.sin(tiltAxis)), tilt));
    const key = `${Math.floor(p.x / 250)},${Math.floor(p.z / 250)}`;
    let b = chunks.get(key);
    if (!b) chunks.set(key, (b = new GeoBuilder()));
    buildHouse(b, s, M, fd);
    houseColliders(colliders, s, M, fd);
    addFootprint(p.x, p.z, s.w + 0.2, s.d + 0.2, p.rot);

    // valla blanca delante de algunas casas (con hueco para el sendero)
    if (rand() < 0.38) {
      const dist = s.d / 2 + 5 + rand() * 3, half = s.w / 2 + 3 + rand() * 3;
      const P = (lx: number, lz: number): [number, number] => [p.x + c * lx + sn * lz, p.z - sn * lx + c * lz];
      fences.push({ pts: [P(-half, dist), P(-1.2, dist)] }, { pts: [P(1.2, dist), P(half, dist)] });
      if (rand() < 0.5) fences.push({ pts: [P(-half, dist), P(-half, -s.d / 2 - 1)] }, { pts: [P(half, dist), P(half, -s.d / 2 - 1)] });
    }
  }
  for (const b of chunks.values()) addMeshes(group, b, materials, true);

  // Casas flotantes (decoración, fuera de alcance): sobre el nivel 94, las colinas del borde y la colina grande.
  // Sobre el lago y el campo de ajedrez flotan piezas (chess.ts).
  const floaters: FloaterDef[] = [];
  for (let i = 0; i < FLOATING_HOUSES; i++) {
    const x = lerp(X0 + 10, X1 - 10, rand()), z = lerp(Z0 + 10, RIDGE_Z + 120, rand());
    const s = randomSpec(rand);
    const b = new GeoBuilder();
    buildHouse(b, s, new THREE.Matrix4(), 1.1);
    const y = heightAt(x, z) + lerp(28, 150, rand() ** 1.4);
    floaters.push({
      geos: b.build(), pos: new THREE.Vector3(x, y, z),
      rot: new THREE.Euler((rand() - 0.5) * 0.7, rand() * Math.PI * 2, (rand() - 0.5) * 0.7),
      scale: 0.9 + rand() * 0.5, phase: rand() * Math.PI * 2, spin: (rand() - 0.5) * 0.02, bob: 1.6,
    });
  }

  return { group, floaters, fences, placed };
}

function addMeshes(parent: THREE.Object3D, b: GeoBuilder, materials: Record<MatKey, THREE.Material>, shadows: boolean) {
  for (const [k, g] of b.build()) {
    const m = new THREE.Mesh(g, materials[k]);
    m.castShadow = shadows && k !== 'glass';
    m.receiveShadow = true;
    parent.add(m);
  }
}
