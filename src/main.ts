import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { loadTextures, createMaterials, createTerrainMaterial } from './materials';
import { generateHeights, buildTerrainGeometry, heightTexture, maskTexture, roadZ, heightAt } from './terrain';
import { ColliderBuilder } from './builder';
import { placeHouses } from './houses';
import { buildProps } from './props';
import { buildChess, fieldPath, REFLECT_LAYER } from './chess';
import { createWater } from './water';
import { Floaters } from './floaters';
import { createGrass } from './grass';
import { SkySystem } from './sky';
import { Player } from './player';
import { Q } from './config';

// Parámetros opcionales en la URL (para pruebas): ?t=0.72 hora del día, ?x=&z=&yaw=&pitch= posición, ?freeze=1
const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);

const hud = document.getElementById('hud')!;
const hudText = document.getElementById('hudText')!;
const fpsEl = document.getElementById('fps')!;
const setStatus = (s: string) => { hudText.innerHTML = s; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- Renderizador ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
let pixelRatio = Math.min(devicePixelRatio, Q.pixelRatio);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0xbccde0, 0.001);
const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 3200);

async function init() {
  setStatus('Cargando texturas… 0%');
  const manager = new THREE.LoadingManager();
  manager.onProgress = (_u, loaded, total) => setStatus(`Cargando texturas… ${Math.round((loaded / total) * 100)}%`);
  const T = await loadTextures(manager, renderer.capabilities.getMaxAnisotropy());

  setStatus('Generando terreno…');
  await nextFrame();
  generateHeights();

  setStatus('Construyendo el nivel…');
  await nextFrame();
  fieldPath();                                     // antes que las casas: así no se construye encima
  const mats = createMaterials(T);
  const colliders = new ColliderBuilder();
  const houses = placeHouses(mats, colliders);     // también traza senderos y sombras de contacto
  scene.add(houses.group);
  scene.add(buildProps(mats, colliders, houses.fences, houses.placed));
  const chess = buildChess(T, mats, colliders);
  scene.add(chess.group);
  // materiales propios para lo que flota: el BatchedMesh usa otra variante del shader y así no se alternan
  const floaters = new Floaters([...houses.floaters, ...chess.floaters], createMaterials(T));
  scene.add(floaters.group);

  const maskTex = maskTexture();
  const terrain = new THREE.Mesh(buildTerrainGeometry(), createTerrainMaterial(T, maskTex));
  terrain.receiveShadow = true;
  scene.add(terrain);

  const heightTex = heightTexture();
  const grass = createGrass(heightTex, maskTex);
  scene.add(grass.mesh);
  const water = createWater(heightTex);
  scene.add(water.mesh);

  const colGeo = colliders.build();
  const player = new Player(colGeo ? new MeshBVH(colGeo) : null);
  player.pos.set(num('x', 0), 0, num('z', roadZ(0)));
  player.pos.y = num('y', 0) + heightAt(player.pos.x, player.pos.z);
  player.yaw = num('yaw', -Math.PI / 2);
  player.pitch = num('pitch', 0.02);

  const sky = new SkySystem(renderer, scene, num('t', 0.4));

  // lo que se refleja en el campo de ajedrez (además de las piezas, que ya están en esa capa)
  for (const o of [floaters.group, houses.group, terrain, sky.sky, sky.stars, sky.dome, sky.light, sky.hemi]) {
    o.traverse((c) => c.layers.enable(REFLECT_LAYER));
  }
  const frozen = params.get('freeze') === '1';
  const shot = params.get('shot') === '1';
  Object.assign(window, { __game: { THREE, scene, renderer, camera, player, sky, terrain, mats, grass, houses, chess, water, floaters } });

  // ---------- Controles ----------
  const keys = new Set<string>();
  let locked = false;
  let needsFrame = true;   // dibujar un fotograma aunque el juego esté en pausa (al cargar, al redimensionar)
  addEventListener('keydown', (e) => { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
  hud.addEventListener('click', () => renderer.domElement.requestPointerLock());
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === renderer.domElement;
    hud.classList.toggle('hidden', locked);
    if (!locked) { keys.clear(); fpsEl.textContent = ''; }
  });
  addEventListener('mousemove', (e) => {
    if (locked) player.look(e.movementX, e.movementY);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    needsFrame = true;
  });

  setStatus('<b style="font-size:24px">LEVEL 94 — MOTION</b><br>Click para jugar<br><small>WASD mover · Shift correr · Espacio saltar · T (mantener) adelantar la hora · Esc soltar el ratón</small>');
  if (shot) hud.classList.add('hidden');

  // ---------- Bucle ----------
  // · Con el menú abierto no se dibuja nada (antes seguía a pleno rendimiento).
  // · Límite de FPS (Q.fpsCap): en pantallas de 120 Hz dibujaría el doble sin necesidad.
  // · Resolución dinámica: si durante 6 s seguidos no se llega al ritmo de la pantalla, baja un escalón
  //   (nunca por debajo de Q.minPixelRatio). Se ignoran el arranque y los tirones sueltos (compilar shaders).
  const FRAME = 1 / Q.fpsCap;
  let last = -1, lastRender = 0, budget = 0, elapsed = 0;
  let refresh = 1 / 60;                     // intervalo medio entre fotogramas de la pantalla
  let fpsT = 0, fpsN = 0, dynT = 0, dynN = 0, slow = 0, played = 0, hitch = false;
  renderer.setAnimationLoop((now: number) => {
    const t = now / 1000;
    if (last < 0) last = lastRender = t;
    const raw = Math.min(t - last, 0.1);
    last = t;
    refresh += (raw - refresh) * 0.05;
    const paused = !locked && !shot;
    if (paused && !needsFrame) return;
    budget += raw;
    if (!needsFrame && budget < FRAME * 0.92) return;
    budget = Math.min(Math.max(budget - FRAME, 0), FRAME);
    const realDt = t - lastRender;
    lastRender = t;
    needsFrame = false;
    const dt = paused ? 0 : Math.min(realDt, 0.05);

    elapsed += dt;
    if (!paused) player.update(dt, keys);
    player.applyCamera(camera);
    sky.update(dt, camera, player.pos, keys.has('KeyT'), frozen);
    grass.uniforms.uCenter.value.copy(player.pos);
    grass.uniforms.uFwd.value.set(-Math.sin(player.yaw), -Math.cos(player.yaw));
    grass.uniforms.uTime.value = elapsed;
    water.uniforms.uTime.value = elapsed;
    floaters.update(elapsed);
    chess.reflection.update(renderer, scene, camera);
    renderer.render(scene, camera);
    if (paused) return;

    fpsT += realDt; fpsN++;
    if (fpsT > 0.5) {
      fpsEl.textContent = `${Math.round(fpsN / fpsT)} fps`;
      fpsT = 0; fpsN = 0;
      (window as unknown as { __ready: boolean }).__ready = true;
    }
    dynT += realDt; dynN++; played += realDt;
    if (realDt > 0.1) hitch = true;
    if (dynT > 2) {
      if (played > 6 && !hitch) {
        const target = Math.min(Q.fpsCap, 1 / refresh);
        slow = dynN / dynT < target * 0.85 ? slow + 1 : 0;
        if (slow >= 3 && pixelRatio > Q.minPixelRatio + 1e-3) {
          pixelRatio = Math.max(Q.minPixelRatio, pixelRatio - 0.125);
          renderer.setPixelRatio(pixelRatio);
          sky.setPixelRatio(pixelRatio);
          slow = 0;
        }
      }
      dynT = 0; dynN = 0; hitch = false;
    }
  });
}

init().catch((err) => {
  console.error(err);
  setStatus(`Error al cargar: ${err?.message ?? err}`);
});
