import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TEX_SIZE, type MatKey } from './materials';

const WHITE = new THREE.Color(1, 1, 1);

/** Escala las UV de una BoxGeometry para que la textura quede a tamaño real (metros). */
function boxUVMeters(g: THREE.BufferGeometry, w: number, h: number, d: number) {
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // caras en orden +x, -x, +y, -y, +z, -z (4 vértices cada una)
  const dims: [number, number][] = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const k = f * 4 + v;
      uv.setXY(k, uv.getX(k) * dims[f][0], uv.getY(k) * dims[f][1]);
    }
  }
}

/** mergeGeometries y BatchedMesh exigen que todas las piezas tengan índice (o ninguna). */
function ensureIndex(g: THREE.BufferGeometry) {
  if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
}

function paint(g: THREE.BufferGeometry, color: THREE.Color) {
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { c[i * 3] = color.r; c[i * 3 + 1] = color.g; c[i * 3 + 2] = color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
}

/**
 * Acumula piezas por material y las fusiona: una casa entera son ~7 draw calls.
 * Las UV de las piezas van en metros; aquí se dividen por el tamaño real de cada textura.
 */
export class GeoBuilder {
  parts = new Map<MatKey, THREE.BufferGeometry[]>();

  /** Añade una geometría con UV en metros. */
  add(key: MatKey, g: THREE.BufferGeometry, m: THREE.Matrix4, color: THREE.Color = WHITE, uvOffset = 0) {
    const [su, sv] = TEX_SIZE[key];
    const uv = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / su + uvOffset, uv.getY(i) / sv + uvOffset * 0.37);
    ensureIndex(g);
    paint(g, color);
    g.applyMatrix4(m);
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(g);
  }

  box(key: MatKey, w: number, h: number, d: number, m: THREE.Matrix4, color?: THREE.Color, uvOffset = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    boxUVMeters(g, w, h, d);
    this.add(key, g, m, color, uvOffset);
  }

  /** Triángulo plano con UV planares (u a lo largo de `uAxis`, v en altura). */
  triangle(key: MatKey, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, outward: THREE.Vector3,
    uAxis: THREE.Vector3, m: THREE.Matrix4, color?: THREE.Color, vBase = 0) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.dot(outward) < 0) { const t = b; b = c; c = t; }
    const pts = [a, b, c];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
    const nn = outward.clone().normalize();
    g.setAttribute('normal', new THREE.Float32BufferAttribute([nn.x, nn.y, nn.z, nn.x, nn.y, nn.z, nn.x, nn.y, nn.z], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.dot(uAxis), p.y - vBase]), 2));
    g.setIndex([0, 1, 2]);
    this.add(key, g, m, color);
  }

  /** Fusiona por material. */
  build(): Map<MatKey, THREE.BufferGeometry> {
    const out = new Map<MatKey, THREE.BufferGeometry>();
    for (const [k, list] of this.parts) {
      const merged = mergeGeometries(list, false);
      if (merged) { merged.computeBoundingSphere(); out.set(k, merged); }
      list.forEach((g) => g.dispose());
    }
    this.parts.clear();
    return out;
  }
}

/** Geometrías de colisión (solo posiciones) en coordenadas del mundo. */
export class ColliderBuilder {
  list: THREE.BufferGeometry[] = [];

  box(w: number, h: number, d: number, m: THREE.Matrix4) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    g.applyMatrix4(m);
    this.list.push(g);
  }

  /** Prisma triangular (el volumen bajo un tejado a dos aguas). */
  prism(w: number, d: number, h: number, m: THREE.Matrix4) {
    const x = w / 2, z = d / 2;
    const p = [
      -x, 0, -z, -x, 0, z, -x, h, 0,
      x, 0, -z, x, 0, z, x, h, 0,
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    g.setIndex([0, 1, 2, 3, 5, 4, 0, 2, 5, 0, 5, 3, 1, 4, 5, 1, 5, 2, 0, 3, 4, 0, 4, 1]);
    g.applyMatrix4(m);
    this.list.push(g);
  }

  /** Una malla cualquiera como colisión (se copia; solo se guardan las posiciones). */
  mesh(src: THREE.BufferGeometry, m: THREE.Matrix4) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.attributes.position.clone());
    if (src.index) g.setIndex(src.index.clone());
    ensureIndex(g);
    g.applyMatrix4(m);
    this.list.push(g);
  }

  build(): THREE.BufferGeometry | null {
    return this.list.length ? mergeGeometries(this.list, false) : null;
  }
}
