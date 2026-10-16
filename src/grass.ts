import * as THREE from 'three';
import { patch, NOISE_GLSL } from './materials';
import { HEIGHT_GLSL, MASK_GLSL, ROAD_GLSL, ZONES_GLSL } from './terrain';
import { mulberry32 } from './noise';
import { Q } from './config';

/**
 * Dos anillos de briznas que siguen al jugador:
 * - cercano: denso, hasta 30 m;
 * - lejano: menos briznas, más anchas, de 22 a 75 m.
 * En vez de encoger todas las briznas a la misma distancia (eso se veía como "césped que crece"),
 * cada brizna tiene su propia distancia de corte: el césped se aclara poco a poco y no hay borde.
 */
interface Ring {
  key: string;
  count: number;
  patch: number;            // las briznas se repiten cada `patch` metros alrededor del jugador
  levels: number[];         // alturas relativas de los tramos de la brizna
  keepGLSL: string;         // fracción de briznas visibles según la distancia `d`
  width: number; height: number;
}

const RINGS: Ring[] = [
  {
    key: 'grass', count: Q.grassNear, patch: 60, levels: [0, 0.3, 0.55, 0.8],
    keepGLSL: '1.0 - smoothstep(16.0, 30.0, d)', width: 1, height: 1,
  },
  {
    key: 'grassFar', count: Q.grassFar, patch: 150, levels: [0, 0.5],
    keepGLSL: 'smoothstep(20.0, 30.0, d) * (1.0 - smoothstep(50.0, 74.0, d))', width: 2.6, height: 1.15,
  },
];

const GRASS_VERT_HEAD = /* glsl */ `
attribute vec4 aBlade;
uniform vec3 uCenter;
uniform vec2 uFwd;
uniform float uTime;
varying vec3 vGrassCol;
${HEIGHT_GLSL}
${MASK_GLSL}
${ROAD_GLSL}
${ZONES_GLSL}
${NOISE_GLSL}
`;

const grassBody = (r: Ring) => /* glsl */ `
  vec2 wp = aBlade.xy + floor((uCenter.xz - aBlade.xy) / ${r.patch.toFixed(1)} + 0.5) * ${r.patch.toFixed(1)};
  vec2 rel = wp - uCenter.xz;
  float d = length(rel);
  // aclarado: cada brizna desaparece a su propia distancia (umbral aleatorio r3)
  float r3 = hash12(wp * 0.71 + 9.2);
  float vis = clamp(((${r.keepGLSL}) * 1.2 - 0.1 - r3) * 8.0 + 0.5, 0.0, 1.0);
  // descarte barato: invisible, más de 4 m detrás de la cámara o sobre el campo de ajedrez (sin leer texturas)
  if (vis <= 0.0 || dot(rel, uFwd) < -4.0 || wp.y > FIELD_Z0 - FIELD_FRAME - 0.2) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
  float r1 = hash12(wp * 1.37 + 0.5);
  float r2 = hash12(wp * 2.71 - 3.1);
  vec2 mk = textureLod(uMask, maskUV(wp), 0.0).rg;
  float gh = terrainH(wp);
  float keep = smoothstep(ROAD_HALF + 0.4, ROAD_HALF + 1.8, abs(roadDist(wp))) * (1.0 - smoothstep(0.12, 0.5, mk.r));
  if (nearLake(wp) && lakeQ(wp) < 1.6) keep *= smoothstep(WATER_Y + 0.2, WATER_Y + 0.5, gh);   // ni bajo el agua
  float clump = vnoise(wp * 0.33);
  float bladeH = (0.12 + 0.24 * r1 + 0.22 * clump) * ${r.height.toFixed(2)} * vis * keep;
  float bladeW = (0.032 + 0.024 * r2) * ${r.width.toFixed(2)} * (0.6 + 0.4 * vis);
  float ang = r2 * 6.2832;
  vec2 fwd = vec2(cos(ang), sin(ang));
  float gust = vnoise(wp * 0.045 + vec2(uTime * 0.32, uTime * 0.11));
  float sway = sin(uTime * 2.0 + wp.x * 0.33 + wp.y * 0.21) * 0.1 + (gust - 0.35) * 0.7;
  float t = position.y;
  vec3 bend = vec3(fwd.x, 0.0, fwd.y) * (0.18 + 0.28 * r1) * t * t + vec3(0.94, 0.0, 0.33) * sway * t * t;
  vec3 side = vec3(-fwd.y, 0.0, fwd.x);
  vec3 bladePos = vec3(wp.x, gh, wp.y) + side * position.x * bladeW + vec3(0.0, t * bladeH, 0.0) + bend * bladeH;
  vec3 objectNormal = normalize(vec3(fwd.x, 0.0, fwd.y) * -0.6 + vec3(0.0, 1.0, 0.0));
  vec3 tip = mix(GRASS_TIP_A, GRASS_TIP_B, r1 * 0.6 + clump * 0.4);
  vGrassCol = mix(GRASS_BASE, tip, smoothstep(0.0, 1.0, t)) * (1.0 - mk.g * 0.45) * (0.85 + 0.3 * gust);
`;

/** Brizna: tramos que se estrechan + punta. */
function bladeGeometry(levels: number[]): THREE.InstancedBufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  levels.forEach((t, i) => {
    const w = 1 - Math.pow(t, 1.4) * 0.85;
    pos.push(-0.5 * w, t, 0, 0.5 * w, t, 0);
    uv.push(0, t, 1, t);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  pos.push(0, 1, 0); uv.push(0.5, 1);
  const last = (levels.length - 1) * 2;
  idx.push(last, last + 1, last + 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

export function createGrass(heightTex: THREE.Texture, maskTex: THREE.Texture) {
  const uniforms = {
    uCenter: { value: new THREE.Vector3() },
    uFwd: { value: new THREE.Vector2(0, -1) },
    uTime: { value: 0 },
  };
  const mesh = new THREE.Group();
  const rand = mulberry32(777);
  for (const r of RINGS) {
    const geo = bladeGeometry(r.levels);
    const inst = new Float32Array(r.count * 4);
    for (let i = 0; i < r.count; i++) {
      inst[i * 4] = rand() * r.patch; inst[i * 4 + 1] = rand() * r.patch;
      inst[i * 4 + 2] = rand(); inst[i * 4 + 3] = rand();
    }
    geo.setAttribute('aBlade', new THREE.InstancedBufferAttribute(inst, 4));
    geo.instanceCount = r.count;

    const mat = patch(new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, side: THREE.DoubleSide }), r.key, (s) => {
      Object.assign(s.uniforms, uniforms, { uHeight: { value: heightTex }, uMask: { value: maskTex } });
      s.vertexShader = s.vertexShader
        .replace('#include <common>', `#include <common>\n${GRASS_VERT_HEAD}`)
        .replace('#include <beginnormal_vertex>', grassBody(r))
        .replace('#include <begin_vertex>', 'vec3 transformed = bladePos;');
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassCol;')
        .replace('#include <color_fragment>', 'diffuseColor.rgb *= vGrassCol;')
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
      s.vertexShader = `#define GRASS_BASE ${GRASS_BASE}\n#define GRASS_TIP_A ${GRASS_TIP_A}\n#define GRASS_TIP_B ${GRASS_TIP_B}\n` + s.vertexShader;
    });
    const m = new THREE.Mesh(geo, mat);
    m.frustumCulled = false;   // las posiciones salen del shader
    m.receiveShadow = true;
    mesh.add(m);
  }
  return { mesh, uniforms };
}

const GRASS_BASE = 'vec3(0.020, 0.045, 0.010)';
const GRASS_TIP_A = 'vec3(0.105, 0.215, 0.030)';
const GRASS_TIP_B = 'vec3(0.170, 0.290, 0.050)';
