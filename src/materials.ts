import * as THREE from 'three';
import { ROAD_GLSL, MASK_GLSL, ZONES_GLSL } from './terrain';

// ---------- Niebla con dispersión hacia el sol (sustituye la niebla estándar de three) ----------
export const fogShared = {
  fogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  fogSunColor: { value: new THREE.Color(1, 1, 1) },
};

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogDir;
#endif`;
THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = length(mvPosition.xyz);
  vFogDir = transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 fogSunDir;
  uniform vec3 fogSunColor;
  varying float vFogDepth;
  varying vec3 vFogDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
  #else
    float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  float fogSun = pow(max(dot(normalize(vFogDir), fogSunDir), 0.0), 8.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(fogColor, fogSunColor, fogSun), fogFactor);
#endif`;

export type Shader = Parameters<THREE.Material['onBeforeCompile']>[0];

/** Conecta la niebla compartida y, opcionalmente, modifica el shader. Cada `key` es un programa distinto. */
export function patch<T extends THREE.Material>(mat: T, key: string, fn?: (s: Shader) => void): T {
  mat.onBeforeCompile = (s) => {
    s.uniforms.fogSunDir = fogShared.fogSunDir;
    s.uniforms.fogSunColor = fogShared.fogSunColor;
    fn?.(s);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

export const NOISE_GLSL = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

// ---------- Texturas PBR (CC0: ambientCG y Poly Haven) ----------
export interface PBR { color: THREE.Texture; normal: THREE.Texture; rough: THREE.Texture; ao?: THREE.Texture }

export async function loadTextures(manager: THREE.LoadingManager, anisotropy: number) {
  const loader = new THREE.TextureLoader(manager);
  const load = async (path: string, srgb = false) => {
    const t = await loader.loadAsync(path);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = anisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  const set = async (name: string, ao: boolean): Promise<PBR> => {
    const base = `textures/${name}/`;
    const [color, normal, rough, aoT] = await Promise.all([
      load(base + 'color.jpg', true), load(base + 'normal.jpg'), load(base + 'rough.jpg'),
      ao ? load(base + 'ao.jpg') : Promise.resolve(undefined),
    ]);
    return { color, normal, rough, ao: aoT };
  };
  const [grass, dirt, road, siding, roof, brick, trim, pole, metal, marbleW, marbleB] = await Promise.all([
    set('grass', false), set('dirt', false), set('road', false), set('siding', true), set('roof', true),
    set('brick', true), set('trim', true), set('pole', false), set('metal', false),
    set('marble_w', false), set('marble_b', false),
  ]);
  return { grass, dirt, road, siding, roof, brick, trim, pole, metal, marbleW, marbleB };
}
export type Textures = Awaited<ReturnType<typeof loadTextures>>;

// ---------- Materiales de construcción ----------
/** Tamaño real (m) que cubre una repetición de cada textura. */
export const TEX_SIZE = {
  siding: [2.88, 1.44], trim: [1.5, 1.5], roof: [2.2, 2.2], brick: [1.2, 1.2],
  glass: [1, 1], metal: [2, 2], pole: [0.9, 2.5], wire: [1, 1],
  marbleW: [3.2, 3.2], marbleB: [3.2, 3.2],
} as const;
export type MatKey = keyof typeof TEX_SIZE;

export function createMaterials(T: Textures): Record<MatKey, THREE.MeshStandardMaterial> {
  const pbr = (p: PBR, key: string, extra: THREE.MeshStandardMaterialParameters = {}) =>
    patch(new THREE.MeshStandardMaterial({
      map: p.color, normalMap: p.normal, roughnessMap: p.rough, aoMap: p.ao ?? null,
      aoMapIntensity: 1, vertexColors: true, metalness: 0, ...extra,
    }), key);
  return {
    siding: pbr(T.siding, 'siding'),
    trim: pbr(T.trim, 'trim', { color: 0xf3f1ea }),
    roof: pbr(T.roof, 'roof'),
    brick: pbr(T.brick, 'brick'),
    metal: pbr(T.metal, 'metal', { metalness: 0.35, color: 0xd9dee2 }),
    pole: pbr(T.pole, 'pole', { color: 0x8a7866 }),
    glass: patch(new THREE.MeshStandardMaterial({
      color: 0x161c22, roughness: 0.03, metalness: 0.0, envMapIntensity: 6.0, vertexColors: true,
    }), 'glass'),
    wire: patch(new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.55, vertexColors: true }), 'wire'),
    // mármol pulido de las piezas de ajedrez (la rugosidad original, ~0,11, es casi un espejo)
    marbleW: pbr(T.marbleW, 'marbleW', { roughness: 2.2 }),
    marbleB: pbr(T.marbleB, 'marbleB', { roughness: 2.2 }),
  };
}

// ---------- Terreno: césped + senderos de tierra + carretera con pintura + orilla del lago ----------
// Para ahorrar trabajo a la gráfica, las texturas de tierra y asfalto solo se leen donde se ven, y la
// segunda escala del césped y su relieve solo de cerca. Dentro de un `if` las derivadas no son fiables,
// así que esas lecturas usan textureGrad con derivadas calculadas fuera.
const TERRAIN_MAP = /* glsl */ `
  vec2 wxz = vWPos.xz;
  float camD = distance(vWPos, cameraPosition);
  vec2 gdx = dFdx(wxz), gdy = dFdy(wxz);
  float mac = vnoise(wxz * 0.021) * 0.6 + vnoise(wxz * 0.0057 + 7.3) * 0.4;
  float patchy = vnoise(wxz * 0.11 + 3.7) * 0.5 + vnoise(wxz * 0.045 - 1.3) * 0.5;
  vec2 gUV1 = wxz * 0.3125, gUV2 = wxz * 0.1031 + vec2(0.31, 0.77);
  vec3 gCol = texture2D(map, gUV1).rgb;
  float gRough = texture2D(roughnessMap, gUV1).g;
  // relieve del césped hasta ~260 m (más lejos los mipmaps ya lo dejan plano)
  float wN = 1.0 - smoothstep(220.0, 260.0, camD);
  vec3 gNrm = vec3(0.5, 0.5, 1.0);
  if (wN > 0.0) gNrm = mix(gNrm, textureGrad(normalMap, gUV1, gdx * 0.3125, gdy * 0.3125).xyz, wN);
  // segunda escala del césped (rompe la repetición): solo hasta ~170 m
  float w2 = 0.4 * (1.0 - smoothstep(120.0, 170.0, camD));
  if (w2 > 0.0) {
    gCol = mix(gCol, textureGrad(map, gUV2, gdx * 0.1031, gdy * 0.1031).rgb, w2);
    gNrm = mix(gNrm, textureGrad(normalMap, gUV2, gdx * 0.1031, gdy * 0.1031).xyz, w2);
  }
  vec3 grassCol = gCol * mix(GRASS_A, GRASS_B, mac);
  // manchas de césped más claro/seco y más oscuro: rompen la uniformidad en las colinas lejanas
  grassCol *= mix(vec3(0.78, 0.84, 0.8), vec3(1.18, 1.12, 0.92), smoothstep(0.25, 0.75, patchy));
  // a partir de donde se aclaran las briznas, el suelo toma el color medio del césped con briznas:
  // así no se nota dónde terminan
  grassCol *= mix(vec3(1.0), FIELD_TINT, smoothstep(14.0, 60.0, camD));
  vec2 mk = texture2D(uMask, maskUV(wxz)).rg;
  float edgeN = vnoise(wxz * 0.7);
  float wDirt = smoothstep(0.3, 0.7, mk.r + (edgeN - 0.5) * 0.35);
  float ard = abs(roadDist(wxz));
  float wShoulder = 1.0 - smoothstep(ROAD_HALF + 0.2, ROAD_HALF + 1.3 + edgeN * 0.9, ard);
  float wRoad = 1.0 - smoothstep(ROAD_HALF - 0.06, ROAD_HALF + 0.1 + edgeN * 0.12, ard);
  float wGround = max(wDirt, wShoulder * 0.85);
  // orilla del lago: tierra húmeda y más oscura junto al agua
  float wet = 0.0;
  if (nearLake(wxz)) {
    float shore = 1.0 - smoothstep(1.45, 1.6, lakeQ(wxz));   // solo en la cubeta, no en otras hondonadas
    wGround = max(wGround, shore * (1.0 - smoothstep(WATER_Y + 0.12, WATER_Y + 0.4 + edgeN * 0.3, vWPos.y)));
    wet = shore * (1.0 - smoothstep(WATER_Y + 0.02, WATER_Y + 0.2, vWPos.y));
  }
  vec3 terrainCol = grassCol, terrainN = gNrm;
  // el césped y la tierra de las texturas vienen "mojados" (rugosidad ~0.3): aquí se dejan mate
  float terrainRough = 0.8 + 0.2 * gRough;
  if (wGround > 0.0) {
    vec2 dirtUV = wxz * 0.385, ddx = gdx * 0.385, ddy = gdy * 0.385;
    terrainCol = mix(terrainCol, textureGrad(uDirtMap, dirtUV, ddx, ddy).rgb, wGround);
    terrainN = mix(terrainN, textureGrad(uDirtNormal, dirtUV, ddx, ddy).xyz, wGround);
    terrainRough = mix(terrainRough, 0.82 + 0.18 * textureGrad(uDirtRough, dirtUV, ddx, ddy).g, wGround);
  }
  vec2 roadUV = vec2(0.1 + 0.34 * clamp(ard / ROAD_HALF, 0.0, 1.0), wxz.x * 0.1163);
  vec2 rdx = dFdx(roadUV), rdy = dFdy(roadUV);
  if (wRoad > 0.0) {
    vec3 roadCol = textureGrad(uRoadMap, roadUV, rdx, rdy).rgb;
    float wear = smoothstep(0.2, 0.75, vnoise(wxz * vec2(1.3, 3.1)));
    float edgeLine = 1.0 - smoothstep(0.055, 0.08, abs(ard - (ROAD_HALF - 0.45)));
    float centerLine = (1.0 - smoothstep(0.055, 0.08, ard)) * step(fract(wxz.x / 12.0), 0.27);
    float paintW = max(edgeLine, centerLine) * (0.45 + 0.55 * wear);
    roadCol = mix(roadCol, ard < 0.3 ? vec3(0.62, 0.42, 0.05) : vec3(0.62), paintW);
    terrainCol = mix(terrainCol, roadCol, wRoad);
    terrainN = mix(terrainN, textureGrad(uRoadNormal, roadUV, rdx, rdy).xyz, wRoad);
    terrainRough = mix(terrainRough, mix(textureGrad(uRoadRough, roadUV, rdx, rdy).g, 0.55, paintW), wRoad);
  }
  terrainCol *= 1.0 - mk.g * 0.45 * (1.0 - wRoad);
  terrainCol *= 1.0 - 0.45 * wet;
  terrainRough = mix(terrainRough, 0.4, wet);
  diffuseColor.rgb *= terrainCol;
`;
const TERRAIN_ROUGH = /* glsl */ `
  float roughnessFactor = roughness * terrainRough;
`;
const TERRAIN_NORMAL = /* glsl */ `
  vec3 mapN = terrainN * 2.0 - 1.0;
  mapN.xy *= normalScale;
  normal = normalize(tbn * mapN);
`;

export const GRASS_A = [0.86, 1.06, 0.62];
export const GRASS_B = [1.08, 1.2, 0.58];
/** Color medio del césped con briznas respecto al suelo desnudo (medido comparando capturas con y sin briznas). */
const FIELD_TINT = [0.74, 0.88, 1.25];
const vec3 = (v: number[]) => `vec3(${v.map((x) => x.toFixed(3)).join(', ')})`;

export function createTerrainMaterial(T: Textures, mask: THREE.Texture): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    map: T.grass.color, normalMap: T.grass.normal, roughnessMap: T.grass.rough, metalness: 0, roughness: 1,
  });
  return patch(mat, 'terrain', (s) => {
    Object.assign(s.uniforms, {
      uDirtMap: { value: T.dirt.color }, uDirtNormal: { value: T.dirt.normal }, uDirtRough: { value: T.dirt.rough },
      uRoadMap: { value: T.road.color }, uRoadNormal: { value: T.road.normal }, uRoadRough: { value: T.road.rough },
      uMask: { value: mask },
    });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform sampler2D uDirtMap, uDirtNormal, uDirtRough, uRoadMap, uRoadNormal, uRoadRough;
#define GRASS_A ${vec3(GRASS_A)}
#define GRASS_B ${vec3(GRASS_B)}
#define FIELD_TINT ${vec3(FIELD_TINT)}
${ROAD_GLSL}
${MASK_GLSL}
${ZONES_GLSL}
${NOISE_GLSL}`)
      .replace('#include <map_fragment>', TERRAIN_MAP)
      .replace('#include <roughnessmap_fragment>', TERRAIN_ROUGH)
      .replace('#include <normal_fragment_maps>', TERRAIN_NORMAL);
  });
}
