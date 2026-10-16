import * as THREE from 'three';
import { GeoBuilder, ColliderBuilder } from './builder';
import { TEX_SIZE, patch, type MatKey } from './materials';
import { mulberry32 } from './noise';
import { heightAt, roadZ, roadNormal, domes, pathAt, zonesClear, ROAD_HALF, PLAY_LIMIT, X0, X1 } from './terrain';
import type { Fence } from './houses';

const UP = new THREE.Vector3(0, 1, 0);
const WHITE = new THREE.Color(1, 1, 1);

/** Base ortonormal con el eje x a lo largo de `dir` (horizontal) y el y hacia arriba. */
function alongBasis(dir: THREE.Vector3, pos: THREE.Vector3) {
  const x = dir.clone().normalize();
  const z = new THREE.Vector3().crossVectors(x, UP).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(pos);
}

/** Cilindro entre dos puntos. */
function cylinder(b: GeoBuilder, key: MatKey, a: THREE.Vector3, c: THREE.Vector3, r0: number, r1: number, seg = 8, color?: THREE.Color) {
  const y = new THREE.Vector3().subVectors(c, a);
  const len = y.length();
  y.normalize();
  const ref = Math.abs(y.y) < 0.9 ? UP : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(y, ref).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const g = new THREE.CylinderGeometry(r1, r0, len, seg);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2 * Math.PI * Math.max(r0, r1), uv.getY(i) * len);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(a.clone().add(c).multiplyScalar(0.5));
  b.add(key, g, m, color);
}

export function buildProps(
  materials: Record<MatKey, THREE.MeshStandardMaterial>, colliders: ColliderBuilder, fences: Fence[],
  houses: { x: number; z: number; r: number }[],
) {
  const rand = mulberry32(4994);
  const group = new THREE.Group();
  const b = new GeoBuilder();
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ---------- Vallas blancas de piquetes ----------
  // tramos junto a la carretera, cortados donde cruza un sendero
  for (let k = 0; k < 6; k++) {
    const x0 = (rand() * 2 - 1) * (PLAY_LIMIT - 130), len = 40 + rand() * 90, side = rand() < 0.5 ? -1 : 1;
    let cur: [number, number][] = [];
    for (let x = x0; x < x0 + len; x += 3) {
      const [nx, nz] = roadNormal(x);
      const off = side * (ROAD_HALF + 4.6);
      const px = x + nx * off, pz = roadZ(x) + nz * off;
      if (pathAt(px, pz) > 0.15) { if (cur.length > 1) fences.push({ pts: cur }); cur = []; continue; }
      cur.push([px, pz]);
    }
    if (cur.length > 1) fences.push({ pts: cur });
  }

  const picketMatrices: THREE.Matrix4[] = [];
  for (const f of fences) {
    // subdividir en secciones de ~2.4 m entre postes
    const posts: THREE.Vector3[] = [];
    for (let s = 0; s < f.pts.length - 1; s++) {
      const [ax, az] = f.pts[s], [bx, bz] = f.pts[s + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 2.4));
      for (let i = s === 0 ? 0 : 1; i <= n; i++) {
        const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        posts.push(V(x, heightAt(x, z), z));
      }
    }
    for (const p of posts) b.box('trim', 0.1, 1.3, 0.1, new THREE.Matrix4().makeTranslation(p.x, p.y + 0.55, p.z), WHITE);
    for (let i = 0; i < posts.length - 1; i++) {
      const A = posts[i], B = posts[i + 1];
      const dir = V(B.x - A.x, 0, B.z - A.z);
      const L = dir.length();
      for (const h of [0.28, 0.82]) {
        const a = A.clone().setY(A.y + h), c = B.clone().setY(B.y + h);
        const d3 = new THREE.Vector3().subVectors(c, a);
        b.box('trim', d3.length(), 0.08, 0.04, alongBasis(d3, a.clone().add(c).multiplyScalar(0.5)), WHITE);
      }
      // colisión: una lámina por sección
      const lo = Math.min(A.y, B.y) - 0.3, hi = Math.max(A.y, B.y) + 1.15;
      const mid = A.clone().add(B).multiplyScalar(0.5).setY((lo + hi) / 2);
      colliders.box(L + 0.1, hi - lo, 0.16, alongBasis(dir, mid));
      // piquetes
      const rot = Math.atan2(-(B.z - A.z), B.x - A.x);
      const zx = Math.sin(rot) * 0.045, zz = Math.cos(rot) * 0.045;
      for (let t = 0.09; t < L - 0.05; t += 0.165) {
        const x = A.x + (dir.x / L) * t + zx, z = A.z + (dir.z / L) * t + zz;
        const m = new THREE.Matrix4().makeTranslation(x, heightAt(x, z) - 0.08, z)
          .multiply(new THREE.Matrix4().makeRotationY(rot))
          .multiply(new THREE.Matrix4().makeRotationZ((rand() - 0.5) * 0.02));
        picketMatrices.push(m);
      }
    }
  }
  const picketShape = new THREE.Shape();
  picketShape.moveTo(-0.045, 0); picketShape.lineTo(0.045, 0); picketShape.lineTo(0.045, 0.98);
  picketShape.lineTo(0, 1.08); picketShape.lineTo(-0.045, 0.98); picketShape.closePath();
  const picketGeo = new THREE.ExtrudeGeometry(picketShape, { depth: 0.022, bevelEnabled: false });
  picketGeo.translate(0, 0, -0.011);
  {
    const uv = picketGeo.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / TEX_SIZE.trim[0], uv.getY(i) / TEX_SIZE.trim[1]);
    const n = picketGeo.attributes.position.count;
    picketGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  }
  const pickets = new THREE.InstancedMesh(picketGeo, materials.trim, picketMatrices.length);
  picketMatrices.forEach((m, i) => pickets.setMatrixAt(i, m));
  pickets.castShadow = pickets.receiveShadow = true;
  pickets.computeBoundingSphere();
  group.add(pickets);

  // ---------- Postes de luz con cables ----------
  const poleTops: THREE.Vector3[][] = [];
  // siguen la carretera también por las colinas del borde (hasta donde llega el mapa de alturas)
  for (let x = X0 + 12; x <= X1 - 12; x += 44 + rand() * 6) {
    const [nx, nz] = roadNormal(x);
    const off = -(ROAD_HALF + 2.8);
    const px = x + nx * off, pz = roadZ(x) + nz * off, g = heightAt(px, pz);
    const lean = V((rand() - 0.5) * 0.25, 0, (rand() - 0.5) * 0.25);
    const top = V(px, g + 9.6, pz).add(lean);
    cylinder(b, 'pole', V(px, g - 0.6, pz), top, 0.17, 0.13, 10);
    colliders.box(0.42, 10.5, 0.42, new THREE.Matrix4().makeTranslation(px, g + 4.6, pz));
    const across = V(nx, 0, nz);
    const armC = top.clone().setY(top.y - 0.6);
    b.box('pole', 2.5, 0.12, 0.13, alongBasis(across, armC));
    const ends: THREE.Vector3[] = [];
    for (const o of [-1.05, 0, 1.05]) {
      const base = armC.clone().addScaledVector(across, o).setY(armC.y + (o === 0 ? 0.62 : 0.06));
      cylinder(b, 'metal', base, base.clone().setY(base.y + 0.16), 0.045, 0.035, 6);
      ends.push(base.clone().setY(base.y + 0.16));
    }
    // tirante diagonal
    cylinder(b, 'pole', armC.clone().addScaledVector(across, -0.7).setY(armC.y - 0.02), top.clone().setY(top.y - 1.4), 0.025, 0.025, 4);
    poleTops.push(ends);
  }
  for (let i = 0; i < poleTops.length - 1; i++) {
    for (let w = 0; w < 3; w++) {
      const A = poleTops[i][w], B = poleTops[i + 1][w];
      const sag = 0.55 + rand() * 0.3;
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        pts.push(A.clone().lerp(B, t).setY(A.y + (B.y - A.y) * t - sag * 4 * t * (1 - t)));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 14, 0.013, 4, false);
      b.add('wire', tube, new THREE.Matrix4());
    }
  }

  // ---------- Torres de agua ----------
  const towerSpots = domes
    .filter((d) => Math.abs(d.x) < PLAY_LIMIT - 60 && Math.abs(d.z) < PLAY_LIMIT - 60)
    .sort((a, c) => (a.x * 13.1 + a.z * 7.7) % 1 - (c.x * 13.1 + c.z * 7.7) % 1);
  const towers: [number, number][] = [];
  for (const d of towerSpots) {
    if (towers.length >= 3) break;
    const tx = d.x + d.r * 0.35, tz = d.z - d.r * 0.25;
    if (towers.some(([x, z]) => Math.hypot(x - tx, z - tz) < 260)) continue;
    if (!zonesClear(tx, tz, 8)) continue;
    if (houses.some((h) => Math.hypot(h.x - tx, h.z - tz) < h.r + 10)) continue;
    towers.push([tx, tz]);
  }
  for (const [tx, tz] of towers) waterTower(b, colliders, tx, tz);

  // ---------- Señales de STOP ----------
  const stopTex = stopTexture();
  const stopFace = patch(new THREE.MeshStandardMaterial({ map: stopTex, roughness: 0.45, metalness: 0.1 }), 'stopface');
  const stopBack = patch(new THREE.MeshStandardMaterial({ color: 0x9aa0a4, roughness: 0.5, metalness: 0.6 }), 'stopback');
  const faceGeo = new THREE.CircleGeometry(0.38, 8, Math.PI / 8);
  for (let k = 0; k < 4; k++) {
    const x = (rand() * 2 - 1) * (PLAY_LIMIT - 50);
    const [nx, nz] = roadNormal(x);
    const side = rand() < 0.5 ? 1 : -1;
    const px = x + nx * side * (ROAD_HALF + 1.4), pz = roadZ(x) + nz * side * (ROAD_HALF + 1.4);
    if (pathAt(px, pz) > 0.1) continue;
    const g = heightAt(px, pz);
    b.box('metal', 0.07, 2.9, 0.07, new THREE.Matrix4().makeTranslation(px, g + 1.0, pz));
    colliders.box(0.2, 2.6, 0.2, new THREE.Matrix4().makeTranslation(px, g + 1.3, pz));
    // la cara mira a los coches que vienen por ese carril
    const tang = V(nz, 0, -nx).multiplyScalar(side);
    const yaw = Math.atan2(tang.x, tang.z);
    const face = new THREE.Mesh(faceGeo, stopFace);
    face.position.set(px, g + 2.2, pz).addScaledVector(tang, 0.05);
    face.rotation.y = yaw;
    const back = new THREE.Mesh(faceGeo, stopBack);
    back.position.set(px, g + 2.2, pz).addScaledVector(tang, 0.04);
    back.rotation.y = yaw + Math.PI;
    face.castShadow = back.castShadow = true;
    group.add(face, back);
  }

  for (const [k, g] of b.build()) {
    const m = new THREE.Mesh(g, materials[k]);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

function waterTower(b: GeoBuilder, colliders: ColliderBuilder, x: number, z: number) {
  const V = (a: number, c: number, d: number) => new THREE.Vector3(a, c, d);
  let g = Infinity;
  for (const [ox, oz] of [[-3.4, -3.4], [3.4, -3.4], [-3.4, 3.4], [3.4, 3.4]]) g = Math.min(g, heightAt(x + ox, z + oz));
  const H = 22;
  const paint = new THREE.Color().setStyle('#e8ecef', THREE.SRGBColorSpace);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const legAt = (i: number, h: number) => {
    const [cx, cz] = corners[i % 4];
    const r = 3.4 + (2.5 - 3.4) * (h / H);
    return V(x + cx * r, g + h, z + cz * r);
  };
  for (let i = 0; i < 4; i++) {
    const a = legAt(i, -1), c = legAt(i, H);
    cylinder(b, 'metal', a, c, 0.24, 0.2, 8, paint);
    const mid = a.clone().add(c).multiplyScalar(0.5);
    colliders.box(0.6, H + 1, 0.6, new THREE.Matrix4().makeTranslation(mid.x, mid.y, mid.z));
    for (const [h0, h1] of [[0.5, 7], [7, 14], [14, 21]]) {
      cylinder(b, 'metal', legAt(i, h0), legAt(i + 1, h1), 0.05, 0.05, 5, paint);
      cylinder(b, 'metal', legAt(i + 1, h0), legAt(i, h1), 0.05, 0.05, 5, paint);
      cylinder(b, 'metal', legAt(i, h1), legAt(i + 1, h1), 0.09, 0.09, 6, paint);
    }
  }
  cylinder(b, 'metal', V(x, g - 1, z), V(x, g + H, z), 0.55, 0.55, 14, paint);
  colliders.box(1.2, H + 1, 1.2, new THREE.Matrix4().makeTranslation(x, g + H / 2, z));
  // depósito: fondo cónico, cuerpo, techo y remate
  cylinder(b, 'metal', V(x, g + H - 1.6, z), V(x, g + H + 0.6, z), 1.0, 5.6, 32, paint);
  cylinder(b, 'metal', V(x, g + H + 0.6, z), V(x, g + H + 7.0, z), 5.6, 5.6, 40, paint);
  cylinder(b, 'metal', V(x, g + H + 7.0, z), V(x, g + H + 9.3, z), 5.9, 0.25, 40, paint);
  cylinder(b, 'metal', V(x, g + H + 9.3, z), V(x, g + H + 9.9, z), 0.25, 0.12, 8, paint);
  // pasarela y barandilla
  const ring = (r: number, tube: number, y: number, flat: number) => {
    const t = new THREE.TorusGeometry(r, tube, 4, 64);
    t.rotateX(Math.PI / 2);
    t.scale(1, flat, 1);
    b.add('metal', t, new THREE.Matrix4().makeTranslation(x, y, z), paint);
  };
  ring(6.0, 0.45, g + H + 0.75, 0.12);
  ring(6.35, 0.04, g + H + 1.75, 1);
  for (let k = 0; k < 20; k++) {
    const a = (k / 20) * Math.PI * 2;
    const px = x + Math.cos(a) * 6.35, pz = z + Math.sin(a) * 6.35;
    cylinder(b, 'metal', V(px, g + H + 0.75, pz), V(px, g + H + 1.75, pz), 0.03, 0.03, 4, paint);
  }
}

function stopTexture(): THREE.CanvasTexture {
  const S = 512, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const oct = (r: number) => {
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = Math.PI / 8 + (i * Math.PI) / 4;
      g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
    }
    g.closePath();
  };
  g.fillStyle = '#f2f2f2'; oct(S / 2); g.fill();
  g.fillStyle = '#b3121b'; oct(S / 2 - 22); g.fill();
  g.fillStyle = '#f5f5f5';
  g.font = `bold ${S * 0.3}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('STOP', S / 2, S / 2 + 6);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
