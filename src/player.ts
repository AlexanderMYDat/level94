import * as THREE from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import { heightAt, clampToWorld } from './terrain';

// Movimiento: velocidad de caminar (antes 9 m/s, parecía correr) y de correr con Shift (antes 20).
// El salto no se baja: con menos de 10 m/s ya no se saltan las vallas (1,15 m) caminando.
const WALK = 4.2, RUN = 8.5, ACCEL = 40, GRAV = 28, JUMP = 10;
// Giro del ratón (rad/px): horizontal +25 % respecto a 0.0034; vertical igual
export const MOUSE_SENS_X = 0.0042;
export const MOUSE_SENS_Y = 0.0034;

const RADIUS = 0.35, HEIGHT = 1.8, EYE = 1.65;
const MAX_STEP = 1 / 90;  // subpasos de física para no atravesar paredes corriendo (8,5 m/s → < 10 cm por paso)

/** Teclas de movimiento: cualquiera de ellas cancela la caminata automática. */
export const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  /** Caminata automática (tecla F): avanza hacia donde mira la cámara hasta pulsar WASD o las flechas. */
  auto = false;

  private seg = new THREE.Line3();
  private box = new THREE.Box3();
  private triP = new THREE.Vector3();
  private capP = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private delta = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private wish = new THREE.Vector3();

  constructor(private bvh: MeshBVH | null) {}

  look(dx: number, dy: number) {
    dx = THREE.MathUtils.clamp(dx, -250, 250);
    dy = THREE.MathUtils.clamp(dy, -250, 250);
    this.yaw -= dx * MOUSE_SENS_X;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy * MOUSE_SENS_Y, -1.5, 1.5);
  }

  update(dt: number, keys: Set<string>) {
    const f = this.fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const r = this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = this.wish.set(0, 0, 0);
    if (this.auto) wish.add(f);
    else {
      if (keys.has('KeyW') || keys.has('ArrowUp')) wish.add(f);
      if (keys.has('KeyS') || keys.has('ArrowDown')) wish.sub(f);
      if (keys.has('KeyD') || keys.has('ArrowRight')) wish.add(r);
      if (keys.has('KeyA') || keys.has('ArrowLeft')) wish.sub(r);
    }
    if (wish.lengthSq() > 0) wish.normalize();
    const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? RUN : WALK;
    wish.multiplyScalar(speed);
    const jump = keys.has('Space');

    const steps = Math.max(1, Math.ceil(dt / MAX_STEP));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      // acelerar hacia la velocidad deseada (limitando el vector, no cada eje: así no hay empuje diagonal)
      const a = (this.onGround ? ACCEL : ACCEL * 0.35) * h;
      let dvx = wish.x - this.vel.x, dvz = wish.z - this.vel.z;
      const dl = Math.hypot(dvx, dvz);
      if (dl > a) { dvx *= a / dl; dvz *= a / dl; }
      this.vel.x += dvx;
      this.vel.z += dvz;
      if (this.onGround && jump) { this.vel.y = JUMP; this.onGround = false; }
      const wasGround = this.onGround;
      this.vel.y -= GRAV * h;
      this.pos.addScaledVector(this.vel, h);

      let grounded = false;
      // suelo (mapa de alturas)
      const g = heightAt(this.pos.x, this.pos.z);
      if (this.pos.y <= g) {
        this.pos.y = g;
        if (this.vel.y < 0) this.vel.y = 0;
        grounded = true;
      } else if (wasGround && this.vel.y <= 0 && this.pos.y - g < 0.45) {
        this.pos.y = g; this.vel.y = 0; grounded = true; // pegarse al suelo en bajadas
      }
      // casas, vallas, postes, torres
      if (this.resolveColliders()) grounded = true;
      this.onGround = grounded;

      // límites del mundo (el campo de ajedrez es más ancho que el resto)
      clampToWorld(this.pos);
    }
  }

  /** Empuja la cápsula fuera de la geometría de colisión. Devuelve true si se apoya encima de algo. */
  private resolveColliders(): boolean {
    if (!this.bvh) return false;
    const { seg, box, triP, capP, dir, delta } = this;
    seg.start.set(this.pos.x, this.pos.y + RADIUS, this.pos.z);
    seg.end.set(this.pos.x, this.pos.y + HEIGHT - RADIUS, this.pos.z);
    box.makeEmpty();
    box.expandByPoint(seg.start).expandByPoint(seg.end);
    box.min.addScalar(-RADIUS); box.max.addScalar(RADIUS);
    let hit = false;
    this.bvh.shapecast({
      intersectsBounds: (b) => b.intersectsBox(box),
      intersectsTriangle: (tri: ExtendedTriangle) => {
        const d = tri.closestPointToSegment(seg, triP, capP);
        if (d < RADIUS) {
          if (d > 1e-6) dir.subVectors(capP, triP).divideScalar(d);
          else tri.getNormal(dir);
          const depth = RADIUS - d;
          seg.start.addScaledVector(dir, depth);
          seg.end.addScaledVector(dir, depth);
          hit = true;
        }
        return false;
      },
    });
    if (!hit) return false;
    delta.set(seg.start.x - this.pos.x, seg.start.y - RADIUS - this.pos.y, seg.start.z - this.pos.z);
    this.pos.add(delta);
    const len = delta.length();
    if (len < 1e-7) return false;
    delta.divideScalar(len);
    const vn = this.vel.dot(delta);
    if (vn < 0) this.vel.addScaledVector(delta, -vn); // frena solo contra la pared
    return delta.y > 0.55;
  }

  applyCamera(camera: THREE.PerspectiveCamera) {
    camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
