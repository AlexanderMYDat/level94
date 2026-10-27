import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { fogShared, NOISE_GLSL } from './materials';
import { mulberry32 } from './noise';
import { Q } from './config';

// ---------- Paleta por elevación del sol (grados). Colores en sRGB. ----------
interface Key {
  e: number;
  sun: string; sunI: number;      // luz directa (sol)
  fog: string; fogSun: string;    // niebla lejos del sol / hacia el sol
  dens: number;                   // densidad de la niebla
  hemiSky: string; hemiGround: string; hemiI: number;
  env: number; exposure: number;
  cloud: number;                  // brillo de las nubes
}
const KEYS: Key[] = [
  { e: -90, sun: '#000000', sunI: 0, fog: '#06080e', fogSun: '#06080e', dens: 0.0022, hemiSky: '#1c2a4a', hemiGround: '#0a0c10', hemiI: 0.35, env: 0.0, exposure: 1.5, cloud: 0.0 },
  { e: -12, sun: '#000000', sunI: 0, fog: '#0a0e18', fogSun: '#10121e', dens: 0.0021, hemiSky: '#1c2a4a', hemiGround: '#0a0c10', hemiI: 0.35, env: 0.1, exposure: 1.4, cloud: 0.0 },
  { e: -4, sun: '#ff6a3a', sunI: 0, fog: '#3b3c52', fogSun: '#8a5040', dens: 0.0019, hemiSky: '#5a5e86', hemiGround: '#181a1e', hemiI: 0.6, env: 0.3, exposure: 1.15, cloud: 0.25 },
  { e: 0, sun: '#ff7a40', sunI: 0.9, fog: '#a88a86', fogSun: '#ff9a5a', dens: 0.0016, hemiSky: '#8a7a90', hemiGround: '#2a2a20', hemiI: 0.45, env: 0.45, exposure: 0.75, cloud: 0.8 },
  { e: 5, sun: '#ffa868', sunI: 2.0, fog: '#cdb3a6', fogSun: '#ffc08a', dens: 0.0014, hemiSky: '#a8b0c8', hemiGround: '#3a3a26', hemiI: 0.3, env: 0.5, exposure: 0.65, cloud: 1.0 },
  { e: 14, sun: '#ffe0bf', sunI: 2.8, fog: '#c4d0dc', fogSun: '#f0e2cc', dens: 0.00115, hemiSky: '#bcd4ff', hemiGround: '#46502c', hemiI: 0.3, env: 0.5, exposure: 0.6, cloud: 1.1 },
  { e: 30, sun: '#fff3e6', sunI: 3.2, fog: '#bccde0', fogSun: '#e8eae6', dens: 0.001, hemiSky: '#c0d8ff', hemiGround: '#4a5630', hemiI: 0.3, env: 0.5, exposure: 0.56, cloud: 1.15 },
  { e: 90, sun: '#fff8ee', sunI: 3.4, fog: '#bccde2', fogSun: '#e8eae6', dens: 0.001, hemiSky: '#c0d8ff', hemiGround: '#4a5630', hemiI: 0.3, env: 0.5, exposure: 0.55, cloud: 1.15 },
];
const col = (s: string) => new THREE.Color().setStyle(s, THREE.SRGBColorSpace);
const KEYC = KEYS.map((k) => ({
  sun: col(k.sun), fog: col(k.fog), fogSun: col(k.fogSun), hemiSky: col(k.hemiSky), hemiGround: col(k.hemiGround),
}));

const SKY_NIGHT = /* glsl */ `
uniform float uNight;
uniform float uTwilight;
uniform float uDay;
`;

const DOME_FRAG = /* glsl */ `
uniform vec3 uSunDir, uLightDir, uLightCol, uAmb, uFogCol, uFogSunCol, uMoonDir;
uniform float uTime, uCover, uNight;
varying vec3 vDir;
${NOISE_GLSL}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  mat2 R = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 6; i++) { s += a * vnoise(p); p = R * p; a *= 0.5; }
  return s;
}
void main() {
  vec3 dir = normalize(vDir);
  vec3 C = vec3(0.0); float A = 0.0;
  if (dir.y > 0.0) {
    vec2 p = dir.xz / (dir.y + 0.12) * 1.7;
    vec2 wind = vec2(uTime * 0.006, uTime * 0.0023);
    float n = fbm(p + wind);
    float dens = smoothstep(uCover, uCover + 0.26, n);
    if (dens > 0.0) {
      vec2 toL = normalize(uLightDir.xz + 1e-4) * 0.07;
      float occ = smoothstep(uCover, uCover + 0.4, fbm(p + wind + toL)) * dens;
      float direct = mix(1.0, 0.6, occ) * smoothstep(-0.1, 0.06, uLightDir.y);
      float silver = pow(max(dot(dir, uSunDir), 0.0), 10.0) * (1.0 - dens) * 2.5;
      vec3 lit = uLightCol * (direct + silver) + uAmb * mix(1.0, 0.75, dens);
      float a = dens * smoothstep(0.0, 0.22, dir.y) * 0.96;
      C = lit * a; A = a;
    }
  }
  // luna (detrás de las nubes)
  float md = dot(dir, uMoonDir);
  float disc = smoothstep(0.999935, 0.99996, md);
  vec2 mp = (dir - uMoonDir * md).xy * 800.0;
  float maria = 0.75 + 0.25 * vnoise(mp * 1.3 + 4.0);
  float glow = pow(max(md, 0.0), 900.0) * 0.25 + pow(max(md, 0.0), 6000.0) * 0.4;
  vec3 moon = vec3(0.95, 0.96, 1.0) * (disc * 2.2 * maria + glow) * uNight;
  float moonA = clamp(disc + glow, 0.0, 1.0) * uNight;
  C += moon * (1.0 - A); A += moonA * (1.0 - A);
  // banda de horizonte = mismo color que la niebla del terreno
  vec3 fogC = mix(uFogCol, uFogSunCol, pow(max(dot(dir, uSunDir), 0.0), 8.0));
  float band = 1.0 - smoothstep(-0.03, 0.13, dir.y);
  C = C * (1.0 - band) + fogC * band;
  A = A * (1.0 - band) + band;
  gl_FragColor = vec4(C, A);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class SkySystem {
  readonly sky = new Sky();
  readonly dome: THREE.Mesh;
  readonly stars: THREE.Points;
  readonly light = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.3);
  readonly sunDir = new THREE.Vector3();
  readonly moonDir = new THREE.Vector3();
  /** 0 = medianoche, 0.25 amanecer, 0.5 mediodía, 0.75 atardecer */
  time: number;
  elevation = 0;

  private domeU: Record<string, THREE.IUniform>;
  private starU: Record<string, THREE.IUniform>;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envRT: THREE.WebGLRenderTarget | null = null;
  // el cielo se dibuja siempre en el mismo cubemap y el PMREM se escribe siempre en el mismo destino:
  // fromScene() crea un render target nuevo en cada llamada y liberarlo provocaba parones de ~0,5 s
  private envCube = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
  private envCam = new THREE.CubeCamera(0.1, 100, this.envCube);
  private envTime = -1;
  private shadowCenter = new THREE.Vector3(1e9, 0, 0);
  private shadowDir = new THREE.Vector3();
  private shadowAge = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, startTime: number) {
    this.time = startTime;

    // atmósfera de Preetham, oscurecida de noche hacia un azul profundo
    const sm = this.sky.material as THREE.ShaderMaterial;
    sm.uniforms.uNight = { value: 0 };
    sm.uniforms.uTwilight = { value: 0 };
    sm.uniforms.uDay = { value: 1 };
    sm.fragmentShader = sm.fragmentShader
      .replace('uniform float mieDirectionalG;', `uniform float mieDirectionalG;\n${SKY_NIGHT}`)
      .replace('gl_FragColor = vec4( retColor, 1.0 );', `
        // de día: azul más profundo y saturado
        float lumi = dot(retColor, vec3(0.2126, 0.7152, 0.0722));
        retColor = mix(retColor, max(mix(vec3(lumi), retColor, 1.35) * 0.78, 0.0), uDay * smoothstep(-0.05, 0.25, direction.y));
        // hora azul y noche
        float hy = clamp(direction.y * 2.0, 0.0, 1.0);
        vec3 blueHour = mix(vec3(0.16, 0.13, 0.20), vec3(0.035, 0.06, 0.14), hy);
        vec3 nightCol = mix(vec3(0.010, 0.016, 0.034), vec3(0.003, 0.005, 0.013), hy);
        retColor = mix(retColor, blueHour, uTwilight * (1.0 - uNight));
        retColor = mix(retColor, nightCol, uNight);
        gl_FragColor = vec4( retColor, 1.0 );`);
    sm.uniforms.mieCoefficient.value = 0.004;
    sm.uniforms.mieDirectionalG.value = 0.82;
    this.sky.scale.setScalar(1000);
    this.sky.renderOrder = 1000;
    this.sky.frustumCulled = false;

    // estrellas
    const rand = mulberry32(31337);
    const N = 3800;
    const p = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), c = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const u = rand() * 2 - 1, th = rand() * Math.PI * 2;
      const y = Math.abs(u) * 0.98 + 0.02, r = Math.sqrt(1 - y * y);
      p.set([Math.cos(th) * r * 800, y * 800, Math.sin(th) * r * 800], i * 3);
      size[i] = 1.0 + Math.pow(rand(), 6) * 3.2;
      phase[i] = rand() * 100;
      const t = rand();
      c.set(t < 0.15 ? [1.0, 0.85, 0.7] : t < 0.3 ? [0.75, 0.85, 1.0] : [1, 1, 1], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(p, 3));
    sg.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    sg.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    sg.setAttribute('aColor', new THREE.BufferAttribute(c, 3));
    this.starU = { uNight: { value: 0 }, uTime: { value: 0 }, uScale: { value: renderer.getPixelRatio() } };
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.starU,
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aPhase; attribute vec3 aColor;
        uniform float uTime, uScale, uNight;
        varying vec3 vCol;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w;   // en el plano lejano: solo se dibuja donde no hay nada delante
          float tw = 0.7 + 0.3 * sin(uTime * (1.5 + fract(aPhase) * 3.0) + aPhase);
          float horizon = smoothstep(0.0, 0.25, normalize(position).y);
          vCol = aColor * tw * uNight * horizon * (0.35 + 0.65 * aSize / 4.2);
          gl_PointSize = aSize * uScale;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vCol;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.05, d);
          gl_FragColor = vec4(vCol * a * 1.6, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: false,
    }));
    this.stars.renderOrder = 1001;
    this.stars.frustumCulled = false;

    // cúpula de nubes, luna y banda de horizonte
    this.domeU = {
      uSunDir: { value: new THREE.Vector3() }, uLightDir: { value: new THREE.Vector3() }, uMoonDir: { value: new THREE.Vector3() },
      uLightCol: { value: new THREE.Color() }, uAmb: { value: new THREE.Color() },
      uFogCol: { value: new THREE.Color() }, uFogSunCol: { value: new THREE.Color() },
      uTime: { value: 0 }, uCover: { value: 0.55 }, uNight: { value: 0 },
    };
    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(900, 48, 24),
      new THREE.ShaderMaterial({
        uniforms: this.domeU,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = (modelMatrix * vec4(position, 1.0)).xyz - cameraPosition;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            gl_Position.z = gl_Position.w;
          }`,
        fragmentShader: DOME_FRAG,
        side: THREE.BackSide, depthWrite: false, transparent: false,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      }),
    );
    this.dome.renderOrder = 1002;
    this.dome.frustumCulled = false;

    scene.add(this.sky, this.stars, this.dome, this.light, this.light.target, this.hemi);

    // sombras: un mapa que sigue al jugador. Solo se vuelve a dibujar cuando hace falta (ver update)
    const L = this.light;
    L.castShadow = true;
    L.shadow.mapSize.set(Q.shadowMap, Q.shadowMap);
    renderer.shadowMap.autoUpdate = false;
    const S = Q.shadowRange;
    Object.assign(L.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 800 });
    L.shadow.bias = -0.0002;
    L.shadow.normalBias = 0.05;

    // entorno para reflejos y luz ambiente (PMREM del propio cielo, sin el disco solar:
    // el sol ya es la luz direccional y su brillo extremo lavaría toda la escena)
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envSkyMat = sm.clone();
    this.envSkyMat.fragmentShader = sm.fragmentShader.replace('L0 += ( vSunE * 19000.0 * Fex ) * sundisk;', '');
    const envSky = new THREE.Mesh(this.sky.geometry, this.envSkyMat);
    envSky.scale.setScalar(10);
    this.envScene.add(envSky);
  }
  private envSkyMat: THREE.ShaderMaterial;

  /** Tamaño de las estrellas cuando cambia la resolución dinámica. */
  setPixelRatio(pr: number) { this.starU.uScale.value = pr; }

  private keyframe(e: number) {
    let i = 0;
    while (i < KEYS.length - 2 && e > KEYS[i + 1].e) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    const t = THREE.MathUtils.clamp((e - a.e) / (b.e - a.e), 0, 1);
    const L = (x: number, y: number) => x + (y - x) * t;
    const C = (name: keyof (typeof KEYC)[number], out: THREE.Color) => out.copy(KEYC[i][name]).lerp(KEYC[i + 1][name], t);
    return { t, i, L, C, a, b };
  }

  update(dt: number, camera: THREE.Camera, target: THREE.Vector3, fast: boolean, frozen: boolean) {
    // avance del tiempo: el día (sol sobre −6°) dura ~12 min y la noche ~2,3 min
    if (!frozen) {
      const rate = this.elevation < -6 ? 1 / 300 : 1 / 1350;
      this.time = (this.time + dt * rate * (fast ? 40 : 1)) % 1;
    }
    const a = (this.time - 0.25) * Math.PI * 2;
    const tilt = THREE.MathUtils.degToRad(35);
    this.sunDir.set(Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)).normalize();
    this.moonDir.set(-this.sunDir.x * 0.9, -this.sunDir.y + 0.25, -this.sunDir.z * 0.9 + 0.2).normalize();
    const e = THREE.MathUtils.radToDeg(Math.asin(this.sunDir.y));
    this.elevation = e;
    const k = this.keyframe(e);
    const night = THREE.MathUtils.smoothstep(-e, 4, 14);

    // cielo
    const su = (this.sky.material as THREE.ShaderMaterial).uniforms;
    su.sunPosition.value.copy(this.sunDir);
    const golden = 1 - THREE.MathUtils.smoothstep(e, 2, 20);
    su.turbidity.value = 2.4 + 6 * golden;
    su.rayleigh.value = 2.2 + 1.0 * golden;
    su.uNight.value = night;
    su.uTwilight.value = THREE.MathUtils.smoothstep(-e, 0.5, 5);
    su.uDay.value = THREE.MathUtils.smoothstep(e, 6, 22);

    // luz principal: sol de día, luna de noche
    const L = this.light;
    const moonI = THREE.MathUtils.smoothstep(-e, 3, 10) * 0.32;
    const sunI = k.L(k.a.sunI, k.b.sunI);
    const lightDir = sunI >= moonI ? this.sunDir : this.moonDir;
    if (sunI >= moonI) { L.intensity = sunI; k.C('sun', L.color); }
    else { L.intensity = moonI; L.color.setRGB(0.55, 0.65, 0.95); }
    L.visible = L.intensity > 0.001;

    // Sombra centrada en el jugador, ajustada a la rejilla del mapa para que no tiemble.
    // Casi todo lo que proyecta sombra está quieto, así que el mapa solo se redibuja si el jugador se ha
    // alejado del centro, si la luz ha girado algo o cada 0,25 s (casas flotantes). Antes: 60 veces por segundo.
    this.shadowAge += dt;
    if (fast || this.shadowAge > 0.25 || target.distanceToSquared(this.shadowCenter) > 16 || lightDir.dot(this.shadowDir) < 0.999996) {
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(lightDir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
      const texel = (L.shadow.camera.right * 2) / L.shadow.mapSize.x;
      const snapped = target.clone().applyQuaternion(q.clone().invert());
      snapped.x = Math.round(snapped.x / texel) * texel;
      snapped.y = Math.round(snapped.y / texel) * texel;
      snapped.applyQuaternion(q);
      L.target.position.copy(snapped);
      L.position.copy(snapped).addScaledVector(lightDir, 400);
      this.shadowCenter.copy(target);
      this.shadowDir.copy(lightDir);
      this.shadowAge = 0;
      this.renderer.shadowMap.needsUpdate = true;
    }

    // ambiente, niebla y exposición
    k.C('hemiSky', this.hemi.color);
    k.C('hemiGround', this.hemi.groundColor);
    this.hemi.intensity = k.L(k.a.hemiI, k.b.hemiI);
    const fog = this.scene.fog as THREE.FogExp2;
    k.C('fog', fog.color);
    k.C('fogSun', fogShared.fogSunColor.value);
    fogShared.fogSunDir.value.copy(this.sunDir);
    fog.density = k.L(k.a.dens, k.b.dens);
    this.renderer.toneMappingExposure = k.L(k.a.exposure, k.b.exposure);
    this.scene.environmentIntensity = k.L(k.a.env, k.b.env);

    // nubes, luna, estrellas
    const d = this.domeU;
    d.uSunDir.value.copy(this.sunDir);
    d.uLightDir.value.copy(lightDir);
    d.uMoonDir.value.copy(this.moonDir);
    const cloudB = k.L(k.a.cloud, k.b.cloud);
    if (sunI >= moonI) (d.uLightCol.value as THREE.Color).copy(L.color).multiplyScalar(cloudB);
    else (d.uLightCol.value as THREE.Color).setRGB(0.05, 0.06, 0.09);
    (d.uAmb.value as THREE.Color).copy(fog.color).multiplyScalar(0.55).lerp(this.hemi.color, 0.25);
    (d.uFogCol.value as THREE.Color).copy(fog.color);
    (d.uFogSunCol.value as THREE.Color).copy(fogShared.fogSunColor.value);
    d.uNight.value = night;
    d.uTime.value += dt;
    d.uCover.value = 0.62 + 0.04 * Math.sin(d.uTime.value * 0.01);
    this.starU.uNight.value = night;
    this.starU.uTime.value = d.uTime.value;

    for (const o of [this.sky, this.stars, this.dome]) o.position.copy(camera.position);

    // reflejos/ambiente: rehacer el mapa de entorno cuando el sol se ha movido (≈ cada 5 s de día)
    if (Math.abs(this.time - this.envTime) > 0.0055 || !this.envRT) {
      this.envTime = this.time;
      const eu = this.envSkyMat.uniforms;
      for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'uNight', 'uTwilight', 'uDay']) eu[k].value = su[k].value;
      eu.sunPosition.value.copy(this.sunDir);
      this.envCam.update(this.renderer, this.envScene);
      if (this.envRT) this.pmrem.fromCubemap(this.envCube.texture, this.envRT);
      else this.scene.environment = (this.envRT = this.pmrem.fromCubemap(this.envCube.texture)).texture;
    }
  }
}
