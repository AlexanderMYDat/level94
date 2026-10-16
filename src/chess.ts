import * as THREE from 'three';
import { GeoBuilder, ColliderBuilder } from './builder';
import { patch, NOISE_GLSL, type MatKey, type Textures } from './materials';
import type { FloaterDef } from './floaters';
import { mulberry32, lerp } from './noise';
import { FIELD, CHESS_Y, WATER_Y, LAKE, RIDGE_Z, ZONES_GLSL, ROAD_HALF, addPath, roadZ, lakeQ } from './terrain';

// ---------- Piezas Staunton por torno: perfiles (radio, altura) en unidades del radio de la base ----------
type Kind = 'P' | 'R' | 'N' | 'B' | 'Q' | 'K';
type P = [number, number];
const RB = FIELD.sq * 0.36;   // radio de la base de las piezas (m)
const BOARD_Y = CHESS_Y + 0.04;

/** Arco de elipse (centro en el eje), de a0 a a1 grados. */
const arc = (cy: number, rx: number, ry: number, a0: number, a1: number, n: number): P[] =>
  Array.from({ length: n + 1 }, (_, i) => {
    const a = THREE.MathUtils.degToRad(a0 + ((a1 - a0) * i) / n);
    return [Math.max(0, rx * Math.cos(a)), cy + ry * Math.sin(a)];
  });

// un punto repetido marca una arista viva (LatheGeometry no suaviza la normal ahí)
const BASE: P[] = [[0, 0], [1, 0], [1, 0], [1, 0.1], [0.96, 0.17], [0.98, 0.22], [0.92, 0.3], [0.8, 0.34], [0.72, 0.4], [0.7, 0.46]];
const COLLAR = (y: number, r: number): P[] => [
  [r, y], [r, y], [r + 0.26, y + 0.06], [r + 0.28, y + 0.12], [r + 0.2, y + 0.16], [r + 0.06, y + 0.2],
  [r + 0.22, y + 0.24], [r + 0.24, y + 0.29], [r + 0.02, y + 0.34], [r + 0.02, y + 0.34],
];
const PROFILES: Record<Kind, P[]> = {
  P: [...BASE, [0.56, 0.6], [0.44, 0.85], [0.38, 1.1], [0.38, 1.18], [0.38, 1.18], [0.62, 1.22], [0.64, 1.28], [0.6, 1.33],
    [0.36, 1.38], [0.36, 1.38], ...arc(1.78, 0.44, 0.44, -50, 90, 14)],
  R: [...BASE, [0.62, 0.55], [0.58, 0.9], [0.55, 1.5], [0.58, 1.75], [0.72, 1.82], [0.74, 1.88], [0.66, 1.94],
    [0.72, 1.98], [0.72, 1.98], [0.72, 2.3], [0.72, 2.3], [0.5, 2.3], [0.5, 2.3], [0.5, 2.18], [0.5, 2.18], [0, 2.18]],
  N: [...BASE, [0.64, 0.52], [0.6, 0.6], [0.6, 0.6], [0, 0.6]],
  B: [...BASE, [0.55, 0.55], [0.42, 0.9], [0.33, 1.4], ...COLLAR(1.62, 0.3), ...arc(2.38, 0.42, 0.56, -45, 80, 12),
    [0.06, 2.95], ...arc(3.03, 0.09, 0.09, -60, 90, 6)],
  Q: [...BASE, [0.56, 0.56], [0.44, 0.9], [0.34, 1.5], ...COLLAR(1.92, 0.3), [0.36, 2.36], [0.5, 2.72], [0.5, 2.72],
    [0.57, 2.8], [0.57, 2.8], [0.46, 2.83], [0.3, 2.9], [0.2, 2.96], ...arc(3.1, 0.17, 0.17, -50, 90, 8)],
  K: [...BASE, [0.58, 0.56], [0.45, 0.9], [0.35, 1.55], ...COLLAR(2.0, 0.31), [0.37, 2.44], [0.5, 2.78], [0.5, 2.78],
    [0.56, 2.84], [0.44, 2.92], [0.26, 3.0], [0.18, 3.04], [0.18, 3.04], [0, 3.04]],
};
const SCALE: Record<Kind, number> = { P: 0.82, R: 0.9, N: 0.92, B: 0.95, Q: 1, K: 1 };
/** El mármol blanco a pleno sol se quema: un poco más gris deja ver las vetas. */
const TINT: Partial<Record<MatKey, THREE.Color>> = { marbleW: new THREE.Color(0.84, 0.84, 0.82) };

/** Silueta de la cabeza del caballo (mira hacia +x). */
const KNIGHT_HEAD: P[] = [
  [-0.55, 0.55], [0.5, 0.55], [0.46, 0.9], [0.36, 1.2], [0.42, 1.42], [0.7, 1.58], [0.92, 1.66], [1.02, 1.78],
  [1.02, 1.92], [0.9, 2.04], [0.62, 2.18], [0.42, 2.34], [0.36, 2.58], [0.26, 2.78], [0.12, 2.56], [-0.1, 2.5],
  [-0.34, 2.36], [-0.52, 2.05], [-0.66, 1.65], [-0.7, 1.2], [-0.64, 0.8],
];

/** UV de una geometría escalada (GeoBuilder espera UV en metros). */
function scaleUV(g: THREE.BufferGeometry, ku: number, kv: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * ku, uv.getY(i) * kv);
}

/** Geometrías de una pieza en metros, con la base en y = 0. `coarse`: versión para colisiones. */
function pieceGeos(kind: Kind, coarse: boolean): THREE.BufferGeometry[] {
  const R = RB * SCALE[kind];
  let prof = PROFILES[kind];
  if (coarse) prof = prof.filter(([r]) => r > 0.05);   // sin tapas en el eje (triángulos degenerados)
  const pts = prof.map(([r, y]) => new THREE.Vector2(r * R, y * R));
  const lathe = new THREE.LatheGeometry(pts, coarse ? 12 : 40);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  scaleUV(lathe, 2 * Math.PI * R * 0.7, len);
  const out: THREE.BufferGeometry[] = [lathe];

  if (kind === 'N') {
    const shape = new THREE.Shape(KNIGHT_HEAD.map(([x, y]) => new THREE.Vector2(x, y)));
    const head = new THREE.ExtrudeGeometry(shape, coarse
      ? { depth: 0.8, bevelEnabled: false }
      : { depth: 0.8, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.06, bevelSegments: 2 });
    head.translate(0, 0, -0.4);
    head.scale(R, R, R);
    scaleUV(head, R, R);
    out.push(head);
  }
  if (coarse) return out;
  if (kind === 'R') {
    // almenas
    for (let k = 0; k < 6; k++) {
      const b = new THREE.BoxGeometry(0.36 * R, 0.22 * R, 0.22 * R);
      scaleUV(b, 0.36 * R, 0.22 * R);
      b.translate(0, 2.41 * R, 0.61 * R);
      b.rotateY((k / 6) * Math.PI * 2);
      out.push(b);
    }
  }
  if (kind === 'Q') {
    // perlas de la corona
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const s = new THREE.SphereGeometry(0.075 * R, 10, 6);
      scaleUV(s, 0.5 * R, 0.25 * R);
      s.translate(Math.cos(a) * 0.52 * R, 2.86 * R, Math.sin(a) * 0.52 * R);
      out.push(s);
    }
  }
  if (kind === 'K') {
    // cruz
    for (const [w, h, y] of [[0.16, 0.66, 3.37], [0.5, 0.15, 3.44]]) {
      const b = new THREE.BoxGeometry(w * R, h * R, 0.16 * R);
      scaleUV(b, w * R, h * R);
      b.translate(0, y * R, 0);
      out.push(b);
    }
  }
  return out;
}

// ---------- La partida, en el centro del campo (medio juego). Blancas al sur, mirando al norte ----------
const WHITE = 'Kg1 Qe2 Ra1 Rf1 Bb3 Nc3 Nf3 Pa2 Pb2 Pc2 Pd3 Pe4 Pf2 Pg2 Ph3';
const BLACK = 'Kg8 Qd7 Ra8 Rf8 Be6 Be7 Nc6 Pa6 Pb5 Pc7 Pd6 Pe5 Pf7 Pg7 Ph6';
const GAME_Z = FIELD.z0 + 3 * FIELD.sq;   // la partida empieza 3 casillas después del borde
/** Centro de una casilla ("e4"). Mirando al norte (+z), la columna a queda al este (+x). */
function square(s: string): [number, number] {
  const f = s.charCodeAt(0) - 97, r = Number(s[1]) - 1;
  return [-(f - 3.5) * FIELD.sq, GAME_Z + (r + 0.5) * FIELD.sq];
}

/** Sendero desde la carretera, por el collado de la colina, hasta la orilla del lago (antes de colocar las casas). */
export function fieldPath() {
  let shoreZ = RIDGE_Z;
  while (lakeQ(-12, shoreZ) > 0.97) shoreZ += 1;
  const ctrl = [[-8, roadZ(-8) + ROAD_HALF + 0.4], [12, 130], [-6, RIDGE_Z + 5], [-12, shoreZ]]
    .map(([x, z]) => new THREE.Vector3(x, 0, z));
  const pts = new THREE.CatmullRomCurve3(ctrl).getPoints(80).map((p): [number, number] => [p.x, p.z]);
  addPath(pts, 1.5);
}

export function buildChess(T: Textures, materials: Record<MatKey, THREE.Material>, colliders: ColliderBuilder) {
  const rand = mulberry32(6464);
  const group = new THREE.Group();
  const b = new GeoBuilder();
  const cache = new Map<string, THREE.BufferGeometry[]>();
  const geos = (kind: Kind, coarse: boolean, s = 1) => {
    const k = kind + coarse;
    if (!cache.has(k)) cache.set(k, pieceGeos(kind, coarse));
    return cache.get(k)!.map((g) => { const c = g.clone(); if (!coarse) scaleUV(c, s, s); return c; });
  };
  const put = (kind: Kind, key: MatKey, M: THREE.Matrix4, s: number) => {
    for (const g of geos(kind, false, s)) b.add(key, g, M, TINT[key]);
    for (const g of geos(kind, true)) colliders.mesh(g, M);
  };
  const standing = (kind: Kind, key: MatKey, x: number, z: number, yaw: number, s = 1) =>
    put(kind, key, new THREE.Matrix4().makeTranslation(x, BOARD_Y, z)
      .multiply(new THREE.Matrix4().makeRotationY(yaw)).multiply(new THREE.Matrix4().makeScale(s, s, s)), s);
  /** Pieza derribada: tumbada hacia `dir`, apoyada en la base y en la cabeza. */
  const toppled = (kind: Kind, key: MatKey, x: number, z: number, dir: number) => {
    const d = new THREE.Vector3(Math.cos(dir), 0, Math.sin(dir));
    const R = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(d.z, 0, -d.x), Math.PI / 2 + 0.2);
    const box = new THREE.Box3();
    for (const g of geos(kind, false)) { g.applyMatrix4(R); g.computeBoundingBox(); box.union(g.boundingBox!); g.dispose(); }
    put(kind, key, new THREE.Matrix4().makeTranslation(x, BOARD_Y - box.min.y - 0.15, z).multiply(R), 1);
  };
  const KINDS: Kind[] = ['P', 'P', 'P', 'P', 'R', 'N', 'B', 'Q', 'K', 'K'];
  const pickKind = () => KINDS[Math.floor(rand() * KINDS.length)];
  const pickKey = (): MatKey => (rand() < 0.5 ? 'marbleW' : 'marbleB');
  const taken: { x: number; z: number; r: number }[] = [];

  // la partida (cada pieza un poco descolocada y girada, como en una partida real)
  for (const [list, key, yaw] of [[WHITE, 'marbleW', -Math.PI / 2], [BLACK, 'marbleB', Math.PI / 2]] as const) {
    for (const tok of list.split(' ')) {
      const [x, z] = square(tok.slice(1));
      standing(tok[0] as Kind, key, x + (rand() - 0.5) * 1.4, z + (rand() - 0.5) * 1.4, yaw + (rand() - 0.5) * 0.3);
    }
  }
  taken.push({ x: 0, z: GAME_Z + 4 * FIELD.sq, r: 4 * FIELD.sq * 1.42 });
  // las dos piezas capturadas, derribadas junto a la partida
  toppled('B', 'marbleW', 4 * FIELD.sq + 14, GAME_Z + 40, 0.6);
  toppled('N', 'marbleB', -4 * FIELD.sq - 12, GAME_Z + 90, 2.4);

  // piezas sueltas por todo el campo, más juntas cerca del lago; lejos, algunas gigantes (hasta 3,4×)
  for (let n = 0, tries = 0; n < 46 && tries < 3000; tries++) {
    const zi = 1 + Math.floor(rand() ** 1.5 * 95), xi = Math.floor((rand() * 2 - 1) * 62);
    const x = (xi + 0.5) * FIELD.sq, z = FIELD.z0 + (zi + 0.5) * FIELD.sq;
    const kind = pickKind(), key = pickKey();
    const giant = z > FIELD.z0 + 260 && rand() < 0.3;
    const s = giant ? 1.8 + 1.6 * rand() : 1;
    const down = !giant && rand() < 0.12;
    const r = RB * SCALE[kind] * s * (down ? 2 : 1);
    if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < t.r + r + 6)) continue;
    taken.push({ x, z, r });
    if (down) toppled(kind, key, x, z, rand() * Math.PI * 2);
    else standing(kind, key, x + (rand() - 0.5) * 2, z + (rand() - 0.5) * 2, rand() * Math.PI * 2, s);
    n++;
  }

  for (const [k, g] of b.build()) {
    const m = new THREE.Mesh(g, materials[k]);
    m.castShadow = true; m.receiveShadow = true;
    m.layers.enable(REFLECT_LAYER);
    group.add(m);
  }

  // piezas flotando sobre el campo y el lago, como las casas sobre el nivel 94
  const floaters: FloaterDef[] = [];
  for (let i = 0; i < 40; i++) {
    const kind = pickKind(), key = pickKey();
    const x = (rand() * 2 - 1) * 850, z = lerp(LAKE.z - 60, FIELD.z0 + 1300, rand() ** 0.8);
    const fb = new GeoBuilder();
    for (const g of geos(kind, false)) { g.translate(0, -1.6 * RB, 0); fb.add(key, g, new THREE.Matrix4(), TINT[key]); }
    floaters.push({
      geos: fb.build(), pos: new THREE.Vector3(x, (z < FIELD.z0 ? WATER_Y : CHESS_Y) + 22 + 165 * rand() ** 1.4, z),
      rot: new THREE.Euler((rand() - 0.5) * 2, rand() * Math.PI * 2, (rand() - 0.5) * 2),
      scale: 0.5 + 1.9 * rand() ** 1.5, phase: rand() * Math.PI * 2, spin: (rand() - 0.5) * 0.06, bob: 2.5,
    });
  }
  for (const list of cache.values()) list.forEach((g) => g.dispose());

  // el tablero: un solo plano hasta la niebla; casillas, juntas, marco y reflejo salen del shader
  const reflection = new FieldReflection();
  const board = new THREE.Mesh(boardGeometry(), boardMaterial(T, reflection));
  board.receiveShadow = true;
  group.add(board);
  return { group, floaters, reflection };
}

// ---------- Tablero ----------
/**
 * Rejilla de celdas de ~100 m hasta la niebla. No puede ser un solo cuadrilátero: con triángulos de
 * kilómetros que pasan por detrás de la cámara, la gráfica (Metal) no dibuja nada.
 */
function boardGeometry(): THREE.BufferGeometry {
  const x0 = -3000, x1 = 3000, z0 = FIELD.z0 - FIELD.frame, z1 = 3200, nx = 60, nz = 26;
  const pos: number[] = [], nrm: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
      pos.push(x, BOARD_Y, z); nrm.push(0, 1, 0);
      uv.push(x, z);   // UV = (x, z) del mundo, igual que el terreno: la base tangente coincide con la del shader
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const BOARD_MAP = /* glsl */ `
  vec2 q = vec2(vWPos.x, vWPos.z - FIELD_Z0) / FIELD_SQ;   // en casillas; q.y < 0 es el marco
  vec2 cell = floor(q);
  float inField = step(0.0, q.y);
  // tablero filtrado: de lejos tiende a la media de blanco y negro (sin moiré)
  vec2 fw = max(fwidth(q), vec2(1e-4));
  vec2 ci = 2.0 * (abs(fract((q - 0.5 * fw) * 0.5) - 0.5) - abs(fract((q + 0.5 * fw) * 0.5) - 0.5)) / fw;
  float dark = inField > 0.5 ? 0.5 - 0.5 * ci.x * ci.y : 1.0;   // el marco es de mármol negro
  // cada casilla es una losa distinta: la textura se gira 0/90/180/270° y se desplaza
  vec2 id = inField > 0.5 ? cell : vec2(9.0, -7.0);
  float rk = floor(hash12(id + 17.0) * 4.0);
  vec2 cs = vec2(cos(rk * 1.5708), sin(rk * 1.5708));
  mat2 R = mat2(cs.x, cs.y, -cs.y, cs.x);
  vec2 p = vWPos.xz / 3.2;
  vec2 uv = R * p + vec2(hash12(id * 1.7 + 3.0), hash12(id * 2.3 - 5.0)) * 7.0;
  vec2 dx = R * dFdx(p), dy = R * dFdy(p);
  vec3 cW = textureGrad(map, uv, dx, dy).rgb, cB = textureGrad(uMB, uv, dx, dy).rgb;
  vec3 nW = textureGrad(normalMap, uv, dx, dy).xyz, nB = textureGrad(uMBN, uv, dx, dy).xyz;
  float rW = textureGrad(roughnessMap, uv, dx, dy).g, rB = textureGrad(uMBR, uv, dx, dy).g;
  vec3 col = mix(cW * 0.86, cB * mix(1.0, 0.7, 1.0 - inField), dark) * (0.94 + 0.12 * hash12(id + 4.0));
  vec3 boardN = mix(nW, nB, dark) * 2.0 - 1.0;
  boardN.xy = boardN.xy * R;                                    // girar también el relieve
  float boardRough = clamp(mix(rW, rB, dark) * 1.3 + 0.04, 0.06, 1.0);
  // juntas de 3 cm entre losas (se apagan a lo lejos) y filete claro entre el campo y el marco
  vec2 e = min(fract(q), 1.0 - fract(q)) * FIELD_SQ;
  float m = inField > 0.5 ? min(e.x, e.y) : 99.0;
  float aa = max(fwidth(m), 0.004) * 1.5;
  float joint = (1.0 - smoothstep(0.015, 0.015 + aa, m)) * (1.0 - smoothstep(0.02, 0.08, max(fw.x, fw.y)));
  col *= 1.0 - 0.6 * joint;
  boardRough = mix(boardRough, 0.9, joint);
  float edge = abs(vWPos.z - (FIELD_Z0 - 0.18));
  float inlay = 1.0 - smoothstep(0.1, 0.1 + max(fwidth(edge), 0.004) * 1.5, edge);
  col = mix(col, vec3(0.86, 0.78, 0.6), inlay);
  diffuseColor.rgb *= col;
`;

/** Reflejo: más que el de un suelo normal (mármol pulido), sin llegar a espejo. Más fuerte en ángulo rasante. */
const BOARD_REFLECT = /* glsl */ `
  float fres = pow(1.0 - clamp(normalize(cameraPosition - vWPos).y, 0.0, 1.0), 5.0);
  float kRefl = uReflOn * (0.05 + 0.27 * fres) * (1.0 - 0.8 * joint);
  if (kRefl > 0.0) {
    vec2 ruv = vRefl.xy / vRefl.w + boardN.xy * 0.02;
    outgoingLight = mix(outgoingLight, textureLod(uRefl, ruv, 1.2 + boardRough * 5.0).rgb, kRefl);
  }
  #include <opaque_fragment>
`;

function boardMaterial(T: Textures, refl: FieldReflection): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: T.marbleW.color, normalMap: T.marbleW.normal, roughnessMap: T.marbleW.rough, roughness: 1, metalness: 0,
    // el tablero está 4 cm por encima del suelo: evita parpadeos de profundidad a distancia
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  return patch(mat, 'chessboard', (s) => {
    Object.assign(s.uniforms, refl.uniforms, { uMB: { value: T.marbleB.color }, uMBN: { value: T.marbleB.normal }, uMBR: { value: T.marbleB.rough } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec4 vRefl;\nuniform mat4 uReflMat;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vRefl = uReflMat * vec4(vWPos, 1.0);`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying vec4 vRefl;
uniform sampler2D uMB, uMBN, uMBR, uRefl;
uniform float uReflOn;
${ZONES_GLSL}
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', BOARD_MAP)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = boardRough;')
      .replace('#include <normal_fragment_maps>', 'vec3 mapN = boardN; mapN.xy *= normalScale; normal = normalize(tbn * mapN);')
      // el cielo ya llega por el reflejo plano: el del mapa de entorno, más flojo (si no, el negro parece cristal azul).
      // envMapIntensity no sirve: con scene.environment three lo sustituye por scene.environmentIntensity
      .replace('#include <aomap_fragment>', 'reflectedLight.indirectSpecular *= 0.25;\n#include <aomap_fragment>')
      .replace('#include <opaque_fragment>', BOARD_REFLECT);
  });
}

// ---------- Reflejo plano ----------
/** Capa de lo que se refleja en el tablero: piezas, objetos flotantes, cielo, colinas y luces (no el césped). */
export const REFLECT_LAYER = 1;

/**
 * Reflejo plano del campo (como Reflector de three, pero dentro del shader del tablero): una cámara
 * simétrica respecto al plano dibuja la capa REFLECT_LAYER a media resolución, con mipmaps para
 * difuminarlo. Solo se hace si el campo está a la vista (desde el nivel 94 lo tapa la colina).
 */
export class FieldReflection {
  readonly target = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
  });
  readonly uniforms = {
    uRefl: { value: this.target.texture }, uReflMat: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
  };
  private cam = new THREE.PerspectiveCamera();
  private frustum = new THREE.Frustum();
  private box = new THREE.Box3(new THREE.Vector3(-3000, BOARD_Y - 0.1, FIELD.z0 - FIELD.frame), new THREE.Vector3(3000, BOARD_Y + 0.1, 3200));
  private size = new THREE.Vector2();
  private v = { a: new THREE.Vector3(), b: new THREE.Vector3(), c: new THREE.Vector3(), m: new THREE.Matrix4(), q: new THREE.Vector4(), plane: new THREE.Plane() };

  constructor() {
    this.cam.layers.set(REFLECT_LAYER);
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    const { a: view, b: target, c: tmp, m: rot, q, plane } = this.v;
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(rot.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const visible = camera.position.y > BOARD_Y + 0.05 && camera.position.z > RIDGE_Z - 60 && this.frustum.intersectsBox(this.box);
    this.uniforms.uReflOn.value = visible ? 1 : 0;
    if (!visible) return;

    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.round(this.size.x / 2)), h = Math.max(1, Math.round(this.size.y / 2));
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);

    // cámara simétrica respecto al plano y = BOARD_Y
    const cam = this.cam;
    view.copy(camera.position).setY(2 * BOARD_Y - camera.position.y);
    rot.extractRotation(camera.matrixWorld);
    target.set(0, 0, -1).applyMatrix4(rot).add(camera.position);
    target.y = 2 * BOARD_Y - target.y;
    cam.position.copy(view);
    cam.up.set(0, 1, 0).applyMatrix4(rot).reflect(tmp.set(0, 1, 0));
    cam.lookAt(target);
    cam.far = camera.far;
    cam.updateMatrixWorld();
    cam.projectionMatrix.copy(camera.projectionMatrix);
    this.uniforms.uReflMat.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)
      .multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse);
    // plano de recorte oblicuo: no dibujar lo que queda por debajo del tablero
    plane.setFromNormalAndCoplanarPoint(tmp.set(0, 1, 0), view.set(0, BOARD_Y, 0)).applyMatrix4(cam.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = cam.projectionMatrix.elements;
    q.set((Math.sign(clip.x) + e[8]) / e[0], (Math.sign(clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x; e[6] = clip.y; e[10] = clip.z + 1; e[14] = clip.w;

    // las sombras se quedan como están: este dibujo solo ve una parte de la escena
    const shadow = renderer.shadowMap.needsUpdate;
    renderer.shadowMap.needsUpdate = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, cam);
    renderer.setRenderTarget(prev);
    renderer.shadowMap.needsUpdate = shadow;
  }
}
