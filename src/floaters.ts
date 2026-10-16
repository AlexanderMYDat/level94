import * as THREE from 'three';
import type { MatKey } from './materials';

/** Un objeto flotante (casa o pieza de ajedrez): su geometría por material y cómo se mueve. */
export interface FloaterDef {
  geos: Map<MatKey, THREE.BufferGeometry>;  // construidas alrededor del origen
  pos: THREE.Vector3;
  rot: THREE.Euler;   // inclinación inicial; gira despacio sobre su eje y
  scale: number;
  phase: number;
  spin: number;       // rad/s
  bob: number;        // amplitud de la oscilación vertical (m)
}

/**
 * Todos los objetos flotantes en un BatchedMesh por material: unas 9 llamadas de dibujo en total,
 * tengan las casas que tengan, en lugar de ~7 por casa. Cada objeto sigue moviéndose por separado.
 */
export class Floaters {
  readonly group = new THREE.Group();
  readonly defs: FloaterDef[];
  private slots: [THREE.BatchedMesh, number][][] = [];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private p = new THREE.Vector3();
  private s = new THREE.Vector3();

  constructor(defs: FloaterDef[], materials: Record<MatKey, THREE.Material>) {
    this.defs = defs;
    const need = new Map<MatKey, { v: number; i: number; n: number }>();
    for (const d of defs) {
      for (const [k, g] of d.geos) {
        const s = need.get(k) ?? { v: 0, i: 0, n: 0 };
        s.v += g.attributes.position.count; s.i += g.index!.count; s.n++;
        need.set(k, s);
      }
    }
    const batches = new Map<MatKey, THREE.BatchedMesh>();
    for (const [k, s] of need) {
      const bm = new THREE.BatchedMesh(s.n, s.v, s.i, materials[k]);
      bm.castShadow = k !== 'glass';
      bm.receiveShadow = true;
      bm.frustumCulled = false;   // se mueven: el recorte se hace por objeto (perObjectFrustumCulled)
      batches.set(k, bm);
      this.group.add(bm);
    }
    for (const d of defs) {
      const slot: [THREE.BatchedMesh, number][] = [];
      for (const [k, g] of d.geos) {
        const bm = batches.get(k)!;
        slot.push([bm, bm.addInstance(bm.addGeometry(g))]);
        g.dispose();
      }
      this.slots.push(slot);
    }
    this.update(0);
  }

  /** Oscilan arriba y abajo y giran despacio. */
  update(time: number) {
    const { m, q, e, p, s } = this;
    this.defs.forEach((d, i) => {
      e.set(d.rot.x, d.rot.y + d.spin * time, d.rot.z);
      p.set(d.pos.x, d.pos.y + Math.sin(time * 0.35 + d.phase) * d.bob, d.pos.z);
      m.compose(p, q.setFromEuler(e), s.setScalar(d.scale));
      for (const [bm, id] of this.slots[i]) bm.setMatrixAt(id, m);
    });
  }
}
