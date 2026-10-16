import * as THREE from 'three';
import { Simplex, mulberry32, hash2, smoothstep, lerp } from './noise';

// ---------- Recorrido de sur a norte ----------
// campo del nivel 94 (con la carretera) → colina que lo tapa todo → lago → campo de ajedrez sin fin
export const PLAY_LIMIT = 450;        // nivel 94, colina y lago: |x| ≤ 450, z ≥ −450
const RIM_START = 360;                // desde aquí el suelo sube en colinas al este, oeste y sur
export const RIDGE_Z = 305;           // eje de la colina que separa el nivel 94 del lago
/** Campo de ajedrez: empieza en z0 (con un marco de `frame` m hacia el lago) y sigue hacia el norte hasta la niebla. */
export const FIELD = { z0: 656, sq: 16, frame: 3 };
export const FIELD_LIMIT = { x: 900, z: FIELD.z0 + 1100 };   // hasta dónde se puede caminar por él
/** Lago alargado (solo visual) entre la colina y el campo. `rx`, `rz`: semiejes de la cubeta; la orilla queda a ~0,8. */
export const LAKE = { x: 0, z: 515, rx: 270, rz: 70 };

// ---------- Mapa de alturas: rectángulo con celdas de 3 m que cubre el nivel 94, la colina y el lago ----------
export const CELL = 3;
export const X0 = -549, Z0 = -549;                 // esquina suroeste
export const NX = 367, NZ = 408;                   // muestras: x de −549 a 549, z de −549 a 672
export const X1 = X0 + (NX - 1) * CELL, Z1 = Z0 + (NZ - 1) * CELL;
export const OUTER = 2600;            // la malla sigue, más gruesa, hasta aquí (oculta por la niebla)

/** Distancia relativa al centro del lago: 1 = borde de la cubeta (forma irregular). */
export function lakeQ(x: number, z: number): number {
  const dx = (x - LAKE.x) / LAKE.rx, dz = (z - LAKE.z) / LAKE.rz;
  return Math.hypot(dx, dz) / lakeShape(Math.atan2(dz, dx));
}
const lakeShape = (a: number) => 1 + 0.16 * Math.sin(3 * a + 0.7) + 0.08 * Math.sin(5 * a + 2.1);
/** true si una casa (o torre) de radio r cabe en el nivel 94 o en la colina, lejos del lago. */
export const zonesClear = (x: number, z: number, r: number) => z + r < RIDGE_Z + 95 && lakeQ(x, z) > 1.35;

/** Mantiene al jugador dentro del mundo: |x| ≤ 450 hasta el campo de ajedrez, que es más ancho. */
export function clampToWorld(p: THREE.Vector3) {
  p.z = THREE.MathUtils.clamp(p.z, -PLAY_LIMIT, FIELD_LIMIT.z);
  if (p.z >= FIELD.z0) { p.x = THREE.MathUtils.clamp(p.x, -FIELD_LIMIT.x, FIELD_LIMIT.x); return; }
  const out = Math.abs(p.x) - PLAY_LIMIT;
  if (out <= 0) return;
  // fuera por un lado: si viene del campo (más ancho), se queda en su borde; si no, en el lateral
  if (FIELD.z0 - p.z < out) p.z = FIELD.z0;
  else p.x = Math.sign(p.x) * PLAY_LIMIT;
}

// ---------- Carretera ----------
export const ROAD_HALF = 4.2;
const RA1 = 46, RF1 = 0.0085, RP1 = 0.4, RA2 = 18, RF2 = 0.021, RP2 = 1.3;
export const roadZ = (x: number) => RA1 * Math.sin(x * RF1 + RP1) + RA2 * Math.sin(x * RF2 + RP2);
export const roadSlope = (x: number) => RA1 * RF1 * Math.cos(x * RF1 + RP1) + RA2 * RF2 * Math.cos(x * RF2 + RP2);
/** Distancia con signo al eje de la carretera (aprox. perpendicular). */
export const roadDist = (x: number, z: number) => (z - roadZ(x)) / Math.sqrt(1 + roadSlope(x) ** 2);
/** Normal horizontal (unitaria) de la carretera en x. */
export function roadNormal(x: number): [number, number] {
  const s = roadSlope(x), l = Math.sqrt(1 + s * s);
  return [-s / l, 1 / l];
}

/** Mismas funciones en GLSL, para el terreno y el césped. */
export const ROAD_GLSL = /* glsl */ `
#define ROAD_HALF ${ROAD_HALF.toFixed(3)}
float roadZ(float x) { return ${RA1.toFixed(3)} * sin(x * ${RF1} + ${RP1}) + ${RA2.toFixed(3)} * sin(x * ${RF2} + ${RP2}); }
float roadSlope(float x) { return ${(RA1 * RF1).toFixed(5)} * cos(x * ${RF1} + ${RP1}) + ${(RA2 * RF2).toFixed(5)} * cos(x * ${RF2} + ${RP2}); }
float roadDist(vec2 p) { float s = roadSlope(p.x); return (p.y - roadZ(p.x)) * inversesqrt(1.0 + s * s); }
`;

// ---------- Colinas: cúpulas redondas como las del nivel 94 ----------
const simplex = new Simplex(mulberry32(94));
export interface Dome { x: number; z: number; r: number; h: number }
const DOME_CELL = 170, DC_OFF = 20, DC_N = 40;
const domeGrid: (Dome | null)[] = new Array(DC_N * DC_N).fill(null);
export const domes: Dome[] = [];

for (let cz = -DC_OFF; cz < DC_N - DC_OFF; cz++) {
  for (let cx = -DC_OFF; cx < DC_N - DC_OFF; cx++) {
    if (hash2(cx, cz, 1) > 0.72) continue;
    const x = (cx + 0.15 + 0.7 * hash2(cx, cz, 2)) * DOME_CELL;
    const z = (cz + 0.15 + 0.7 * hash2(cx, cz, 3)) * DOME_CELL;
    if (z > RIDGE_Z - 80) continue;       // al norte mandan la colina grande, el lago y el campo
    let r = 42 + 72 * hash2(cx, cz, 4);
    const rd = Math.abs(roadDist(x, z));
    if (rd < r + 8) r = rd - 8;           // no invadir la carretera
    if (r < 32) continue;
    const d: Dome = { x, z, r, h: r * (0.26 + 0.24 * hash2(cx, cz, 5)) };
    domeGrid[(cz + DC_OFF) * DC_N + (cx + DC_OFF)] = d;
    domes.push(d);
  }
}

// La colina que separa el nivel 94 del lago: una cadena de cúpulas grandes (40–60 m). Entre las dos
// centrales queda un collado de ~20 m por el que pasa el sendero.
const RIDGE: Dome[] = ([
  [-760, 10, 150, 0.36], [-600, -15, 140, 0.4], [-440, 12, 145, 0.38], [-275, -8, 140, 0.42], [-110, 15, 135, 0.4],
  [95, -10, 135, 0.38], [265, 8, 145, 0.42], [430, -12, 140, 0.4], [595, 14, 150, 0.37], [760, -6, 145, 0.4],
] as const).map(([x, dz, r, k]) => ({ x, z: RIDGE_Z + dz, r, h: r * k }));
domes.push(...RIDGE);

function rawHeight(x: number, z: number): number {
  let h = 8 * simplex.fbm(x * 0.0018 + 11.3, z * 0.0018 - 7.1, 3) + 2.2 * simplex.noise(x * 0.008 - 4.2, z * 0.008 + 9.9);
  const cx = Math.floor(x / DOME_CELL), cz = Math.floor(z / DOME_CELL);
  for (let dz = -1; dz <= 1; dz++) {
    const gz = cz + dz + DC_OFF;
    if (gz < 0 || gz >= DC_N) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const gx = cx + dx + DC_OFF;
      if (gx < 0 || gx >= DC_N) continue;
      const d = domeGrid[gz * DC_N + gx];
      if (!d) continue;
      const q = ((x - d.x) ** 2 + (z - d.z) ** 2) / (d.r * d.r);
      if (q < 1) { const k = 1 - q; h += d.h * k * k; }
    }
  }
  if (Math.abs(z - RIDGE_Z) < 170) {
    for (const d of RIDGE) {
      const q = ((x - d.x) ** 2 + (z - d.z) ** 2) / (d.r * d.r);
      if (q < 1) { const k = 1 - q; h += d.h * k * k; }
    }
  }
  // micro relieve
  h += 0.35 * simplex.noise(x * 0.04 + 1.7, z * 0.04 + 3.3) + 0.12 * simplex.noise(x * 0.11 - 2.1, z * 0.11 + 5.2);
  // borde del mundo: colinas de 30–80 m al este, oeste y sur (esquinas redondeadas); se apagan antes del campo
  const e = Math.pow(x ** 6 + Math.min(z, 0) ** 6, 1 / 6);
  if (e > RIM_START && z < FIELD.z0) {
    h += smoothstep(RIM_START, RIM_START + 280, e) * (55 + 25 * simplex.noise(x * 0.004 + 3.1, z * 0.004 - 8.2))
      * (1 - smoothstep(FIELD.z0 - 170, FIELD.z0 - 30, z));
  }
  return h;
}

// Perfil suavizado de la carretera (no copia cada bache del terreno)
const RS = 2, R0 = -OUTER;
const roadProfile = new Float32Array(Math.ceil((2 * OUTER) / RS) + 1);
for (let i = 0; i < roadProfile.length; i++) { const x = R0 + i * RS; roadProfile[i] = rawHeight(x, roadZ(x)); }
for (let pass = 0; pass < 4; pass++) {
  const src = roadProfile.slice();
  for (let i = 0; i < src.length; i++) {
    let s = 0, n = 0;
    for (let k = -10; k <= 10; k++) { const j = i + k; if (j >= 0 && j < src.length) { s += src[j]; n++; } }
    roadProfile[i] = s / n;
  }
}
export function roadHeightAt(x: number): number {
  const f = Math.min(roadProfile.length - 1.001, Math.max(0, (x - R0) / RS));
  const i = Math.floor(f);
  return lerp(roadProfile[i], roadProfile[i + 1], f - i);
}

function withRoad(x: number, z: number): number {
  const h = rawHeight(x, z);
  const d = Math.abs(roadDist(x, z));
  return d < ROAD_HALF + 18 ? lerp(h, roadHeightAt(x), 1 - smoothstep(ROAD_HALF + 1.2, ROAD_HALF + 18, d)) : h;
}

/** Altura del campo de ajedrez: la media del terreno natural justo antes de él. */
export const CHESS_Y = (() => {
  let s = 0;
  for (let i = 0; i <= 40; i++) s += rawHeight(-400 + i * 20, FIELD.z0 - 16);
  return s / 41;
})();
/** El campo es completamente plano desde z0 − 2 hacia el norte (el tablero va 4 cm por encima). */
const fieldFlat = (h: number, z: number) => (z > FIELD.z0 - 40 ? lerp(h, CHESS_Y, smoothstep(FIELD.z0 - 40, FIELD.z0 - 2, z)) : h);

/** Nivel del agua: por debajo de toda la orilla y del campo, así nunca se sale. */
export const WATER_Y = (() => {
  let m = CHESS_Y;
  for (let k = 0; k < 720; k++) {
    const a = (k / 720) * Math.PI * 2, f = lakeShape(a);
    for (const q of [1.0, 1.15, 1.3, 1.45, 1.6]) {
      const x = LAKE.x + Math.cos(a) * LAKE.rx * f * q, z = LAKE.z + Math.sin(a) * LAKE.rz * f * q;
      m = Math.min(m, fieldFlat(withRoad(x, z), z));
    }
  }
  return m - 0.4;
})();

function terrainHeight(x: number, z: number): number {
  let h = withRoad(x, z);
  // cubeta del lago: 1,3 m de fondo en el centro, orilla suave a ~0,8
  const q = lakeQ(x, z);
  if (q < 1.6) h = lerp(h, WATER_Y + 1.3 * ((q / 0.8) ** 2 - 1), 1 - smoothstep(1.0, 1.6, q));
  return fieldFlat(h, z);
}

/** Zonas en GLSL (césped, terreno, agua y tablero). */
export const ZONES_GLSL = /* glsl */ `
#define FIELD_Z0 ${FIELD.z0.toFixed(2)}
#define FIELD_SQ ${FIELD.sq.toFixed(2)}
#define FIELD_FRAME ${FIELD.frame.toFixed(2)}
#define LAKE_C vec2(${LAKE.x.toFixed(2)}, ${LAKE.z.toFixed(2)})
#define LAKE_R vec2(${LAKE.rx.toFixed(2)}, ${LAKE.rz.toFixed(2)})
#define LAKE_BOX vec2(${(LAKE.rx * 1.24 * 1.6).toFixed(1)}, ${(LAKE.rz * 1.24 * 1.6).toFixed(1)})
#define WATER_Y ${WATER_Y.toFixed(3)}
bool nearLake(vec2 p) { vec2 d = abs(p - LAKE_C); return d.x < LAKE_BOX.x && d.y < LAKE_BOX.y; }
float lakeQ(vec2 p) {
  vec2 d = (p - LAKE_C) / LAKE_R; float a = atan(d.y, d.x);
  return length(d) / (1.0 + 0.16 * sin(3.0 * a + 0.7) + 0.08 * sin(5.0 * a + 2.1));
}
`;

// ---------- Mapa de alturas (física, césped y malla fina comparten los mismos datos) ----------
export const heights = new Float32Array(NX * NZ);
export function generateHeights() {
  for (let j = 0; j < NZ; j++) {
    const z = Z0 + j * CELL;
    for (let i = 0; i < NX; i++) heights[j * NX + i] = terrainHeight(X0 + i * CELL, z);
  }
}

/**
 * Altura exacta del suelo, interpolada igual que los triángulos de la malla.
 * Fuera del mapa de alturas (el campo de ajedrez, que es plano) se calcula directamente.
 */
export function heightAt(x: number, z: number): number {
  if (x < X0 || x > X1 || z < Z0 || z > Z1) return terrainHeight(x, z);
  const gx = Math.min(NX - 1.0001, (x - X0) / CELL);
  const gz = Math.min(NZ - 1.0001, (z - Z0) / CELL);
  const i = Math.floor(gx), j = Math.floor(gz);
  const fx = gx - i, fz = gz - j;
  const k = j * NX + i;
  const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + NX], h11 = heights[k + NX + 1];
  return fx + fz <= 1
    ? h00 + (h10 - h00) * fx + (h01 - h00) * fz
    : h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

export function heightTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(heights, NX, NZ, THREE.RedFormat, THREE.FloatType);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}

/** Misma interpolación en GLSL (texelFetch sobre la textura de alturas). */
export const HEIGHT_GLSL = /* glsl */ `
uniform sampler2D uHeight;
float terrainH(vec2 p) {
  vec2 g = clamp((p - vec2(${X0.toFixed(1)}, ${Z0.toFixed(1)})) / ${CELL.toFixed(1)}, vec2(0.0), vec2(${(NX - 1.0001).toFixed(4)}, ${(NZ - 1.0001).toFixed(4)}));
  vec2 i = floor(g); vec2 f = g - i;
  ivec2 c = ivec2(i);
  float h00 = texelFetch(uHeight, c, 0).r;
  float h10 = texelFetch(uHeight, c + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, c + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, c + ivec2(1, 1), 0).r;
  return f.x + f.y <= 1.0
    ? h00 + (h10 - h00) * f.x + (h01 - h00) * f.y
    : h11 + (h01 - h11) * (1.0 - f.x) + (h10 - h11) * (1.0 - f.y);
}
`;

// ---------- Máscara: R = senderos de tierra, G = sombra de contacto bajo las casas ----------
// Cubre el mismo rectángulo que el mapa de alturas, a ~0,54 m por píxel.
const SIZE_X = X1 - X0, SIZE_Z = Z1 - Z0;
export const MASK_W = 2048, MASK_H = Math.round((MASK_W * SIZE_Z) / SIZE_X);
const mask = new Uint8Array(MASK_W * MASK_H * 2);
const M_SX = MASK_W / SIZE_X, M_SZ = MASK_H / SIZE_Z;

function maskRaster(x0: number, z0: number, x1: number, z1: number, fn: (i: number, j: number) => void) {
  const i0 = Math.max(0, Math.floor((x0 - X0) * M_SX)), i1 = Math.min(MASK_W - 1, Math.ceil((x1 - X0) * M_SX));
  const j0 = Math.max(0, Math.floor((z0 - Z0) * M_SZ)), j1 = Math.min(MASK_H - 1, Math.ceil((z1 - Z0) * M_SZ));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(i, j);
}
const maskX = (i: number) => (i + 0.5) / M_SX + X0;
const maskZ = (j: number) => (j + 0.5) / M_SZ + Z0;

/** Sendero de tierra a lo largo de una polilínea. */
export function addPath(pts: [number, number][], halfW: number) {
  for (let s = 0; s < pts.length - 1; s++) {
    const [ax, az] = pts[s], [bx, bz] = pts[s + 1];
    const pad = halfW + 2;
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1;
    maskRaster(Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad, (i, j) => {
      const x = maskX(i), z = maskZ(j);
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
      const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
      const v = Math.round(255 * (1 - smoothstep(halfW - 0.8, halfW + 0.8, d)));
      const k = (j * MASK_W + i) * 2;
      if (v > mask[k]) mask[k] = v;
    });
  }
}

/** Oscurece el suelo alrededor de la base de una casa (sombra de contacto). */
export function addFootprint(cx: number, cz: number, w: number, d: number, rotY: number) {
  const c = Math.cos(rotY), s = Math.sin(rotY), R = Math.hypot(w, d) / 2 + 4;
  maskRaster(cx - R, cz - R, cx + R, cz + R, (i, j) => {
    const x = maskX(i) - cx, z = maskZ(j) - cz;
    // al espacio local de la casa
    const lx = c * x - s * z, lz = s * x + c * z;
    const qx = Math.abs(lx) - w / 2, qz = Math.abs(lz) - d / 2;
    const sd = Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0);
    const v = Math.round(255 * (1 - smoothstep(-0.3, 3.2, sd)));
    const k = (j * MASK_W + i) * 2 + 1;
    if (v > mask[k]) mask[k] = v;
  });
}

/** Valor del sendero (0..1) en un punto. */
export function pathAt(x: number, z: number): number {
  const i = Math.floor((x - X0) * M_SX), j = Math.floor((z - Z0) * M_SZ);
  if (i < 0 || j < 0 || i >= MASK_W || j >= MASK_H) return 0;
  return mask[(j * MASK_W + i) * 2] / 255;
}

export function maskTexture(): THREE.DataTexture {
  const t = new THREE.DataTexture(mask, MASK_W, MASK_H, THREE.RGFormat, THREE.UnsignedByteType);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

export const MASK_GLSL = /* glsl */ `
uniform sampler2D uMask;
vec2 maskUV(vec2 p) { return (p - vec2(${X0.toFixed(1)}, ${Z0.toFixed(1)})) / vec2(${SIZE_X.toFixed(1)}, ${SIZE_Z.toFixed(1)}); }
`;

// ---------- Malla del terreno ----------
/** Coordenadas de un eje: las del mapa de alturas y, fuera, celdas cada vez más grandes hasta ±OUTER. */
function axisCoords(a0: number, a1: number): { coords: number[]; start: number } {
  const below: number[] = [], above: number[] = [];
  for (let v = a0, step = CELL; v > -OUTER;) { step *= 1.15; v = Math.max(-OUTER, v - step); below.push(v); }
  for (let v = a1, step = CELL; v < OUTER;) { step *= 1.15; v = Math.min(OUTER, v + step); above.push(v); }
  const inner: number[] = [];
  for (let v = a0; v <= a1 + 1e-6; v += CELL) inner.push(v);
  return { coords: [...below.reverse(), ...inner, ...above], start: below.length };
}

export function buildTerrainGeometry(): THREE.BufferGeometry {
  const { coords: xs, start: si } = axisCoords(X0, X1);
  const { coords: zs, start: sj } = axisCoords(Z0, Z1);
  const MX = xs.length, MZ = zs.length;
  const pos = new Float32Array(MX * MZ * 3);
  const uv = new Float32Array(MX * MZ * 2);
  for (let j = 0; j < MZ; j++) {
    for (let i = 0; i < MX; i++) {
      const x = xs[i], z = zs[j], k = j * MX + i;
      const ii = i - si, jj = j - sj;
      const inside = ii >= 0 && ii < NX && jj >= 0 && jj < NZ;
      pos[k * 3] = x;
      pos[k * 3 + 1] = inside ? heights[jj * NX + ii] : terrainHeight(x, z);
      pos[k * 3 + 2] = z;
      uv[k * 2] = x; uv[k * 2 + 1] = z;
    }
  }
  // bajo el tablero de ajedrez no hace falta terreno: no se ve y su shader es el más caro
  const idx: number[] = [];
  for (let j = 0; j < MZ - 1; j++) {
    if (zs[j] >= FIELD.z0) break;
    for (let i = 0; i < MX - 1; i++) {
      const a = j * MX + i, b = a + 1, c = a + MX, d = c + 1;
      idx.push(a, c, b, b, c, d);   // mismo corte que heightAt()
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
