import * as THREE from 'three';
import { patch, NOISE_GLSL } from './materials';
import { HEIGHT_GLSL, ZONES_GLSL, LAKE, WATER_Y } from './terrain';

/**
 * Lago: solo visual (no hay física de agua). Una elipse a la altura WATER_Y; el terreno tapa lo que queda
 * fuera de la orilla. El color y la transparencia dependen de la profundidad real (mapa de alturas),
 * los reflejos salen del mapa de entorno del cielo y las ondas son normales procedurales.
 */
const WATER_FRAG = /* glsl */ `
  float depth = WATER_Y - terrainH(vWPos.xz);
  vec3 shallow = vec3(0.10, 0.22, 0.20), deep = vec3(0.012, 0.045, 0.06);
  diffuseColor.rgb = mix(shallow, deep, smoothstep(0.0, 1.1, depth));
  // espuma suave donde el agua apenas cubre
  float foam = (1.0 - smoothstep(0.02, 0.16, depth)) * smoothstep(0.35, 0.7, vnoise(vWPos.xz * 1.6 + uTime * 0.25));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.8, 0.78), foam * 0.6);
  diffuseColor.a = smoothstep(0.0, 0.45, depth) * 0.9 + 0.1 * smoothstep(0.0, 1.0, depth);
  diffuseColor.a *= 1.0 - smoothstep(1.0, 1.08, lakeQ(vWPos.xz));   // nunca fuera de la cubeta
`;

const WATER_NORMAL = /* glsl */ `
  // ondas: tres capas de ruido que se desplazan; la pendiente sale de diferencias finitas
  vec2 wp = vWPos.xz;
  float eps = 0.15;
  #define WAVES(p) (vnoise((p) * 0.35 + uTime * vec2(0.09, 0.05)) * 0.6 + vnoise((p) * 0.9 - uTime * vec2(0.05, 0.11)) * 0.3 + vnoise((p) * 2.3 + uTime * vec2(0.17, -0.08)) * 0.1)
  float h0 = WAVES(wp);
  float hx = WAVES(wp + vec2(eps, 0.0)), hz = WAVES(wp + vec2(0.0, eps));
  float fade = 1.0 - smoothstep(60.0, 220.0, distance(vWPos, cameraPosition));   // lejos, casi un espejo
  vec3 nW = normalize(vec3(-(hx - h0) / eps * 0.45 * fade, 1.0, -(hz - h0) / eps * 0.45 * fade));
  normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
`;

export function createWater(heightTex: THREE.Texture) {
  const uniforms = { uTime: { value: 0 } };
  const mat = patch(new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.04, metalness: 0, transparent: true,
  }), 'water', (s) => {
    Object.assign(s.uniforms, uniforms, { uHeight: { value: heightTex } });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform float uTime;
${HEIGHT_GLSL}
${ZONES_GLSL}
${NOISE_GLSL}`)
      .replace('#include <color_fragment>', WATER_FRAG)
      .replace('#include <normal_fragment_maps>', WATER_NORMAL);
  });
  const geo = new THREE.CircleGeometry(1.3, 128);
  geo.rotateX(-Math.PI / 2);
  geo.scale(LAKE.rx, 1, LAKE.rz);
  geo.translate(LAKE.x, WATER_Y, LAKE.z);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return { mesh, uniforms };
}
