import * as THREE from "three";
import type { Atmosphere } from "./atmosphere";

/**
 * Gradient sky dome plus the "sky" uniforms that every reflective surface
 * (tower glass, context glazing, water) reads, so a reflection always shows
 * the same sky the dome draws.
 */

/** One object shared by reference between the dome and every material that reflects the sky. */
export type SkyUniforms = {
  uZenith: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uGlow: THREE.IUniform<number>;
  uNight: THREE.IUniform<number>;
  /** 0 = clear sky, 1 = the high cloud layer at full strength. */
  uClouds: THREE.IUniform<number>;
};

export function makeSkyUniforms(): SkyUniforms {
  return {
    uZenith: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunColor: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uGlow: { value: 0 },
    uNight: { value: 0 },
    uClouds: { value: 0 },
  };
}

export function applyAtmosphereToSky(sky: SkyUniforms, atmosphere: Atmosphere): void {
  sky.uZenith.value.copy(atmosphere.zenith);
  sky.uHorizon.value.copy(atmosphere.horizon);
  sky.uSunColor.value.copy(atmosphere.sunColor);
  sky.uSunDir.value.copy(atmosphere.sunDir);
  sky.uGlow.value = atmosphere.glow;
  sky.uNight.value = atmosphere.night;
}

/** GLSL for every material that needs "what colour is the sky in direction d" (dome + reflections). */
export const SKY_GLSL = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uGlow;
  uniform float uNight;
  uniform float uClouds;
  vec3 skyGradient(vec3 d) {
    // optical-depth style falloff: most of the colour change happens in the first ~15 degrees
    float t = pow(clamp(d.y, 0.0, 1.0), 0.42);
    return mix(uHorizon, uZenith, t);
  }
  vec3 skyGlow(vec3 d) {
    float mu = max(dot(d, uSunDir), 0.0);
    // suppressed right at the horizon so the fogged ground line (fog colour == uHorizon) stays seamless
    float above = smoothstep(-0.01, 0.09, d.y);
    return uSunColor * (uGlow * above * (0.22 * pow(mu, 5.0) + 0.55 * pow(mu, 40.0)));
  }
`;

export function makeSkyDome(
  sky: SkyUniforms,
): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  const material = new THREE.ShaderMaterial({
    name: "SkyDome",
    uniforms: sky,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    // authored display-referred so it matches scene.fog (which three also applies un-tonemapped)
    toneMapped: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        // rotation-only view matrix: the dome is always centred on the camera
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww; // sit on the far plane
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      ${SKY_GLSL}
      float hash13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = skyGradient(d) + skyGlow(d);
        // sun disc (0.53 deg would be sub-pixel at fov 45 -> drawn ~1.6 deg so it reads)
        float mu = dot(d, uSunDir);
        col += uSunColor * smoothstep(0.99955, 0.99985, mu) * step(0.0, uSunDir.y + 0.03) * 1.5;
        // sparse stars, only well above the light-polluted horizon
        if (uNight > 0.01) {
          vec3 p = d * 140.0;
          vec3 id = floor(p);
          float r = hash13(id);
          vec3 c = id + 0.5 + (vec3(hash13(id + 7.0), hash13(id + 13.0), hash13(id + 29.0)) - 0.5) * 0.6;
          float star = step(0.9965, r) * smoothstep(0.42, 0.0, length(p - c));
          col += vec3(0.85, 0.9, 1.0) * star * uNight * smoothstep(0.08, 0.45, d.y) * (0.35 + 0.65 * fract(r * 91.7));
        }
        // optional high cirrus/cumulus layer: 4-octave value noise on a plane above the camera, soft threshold
        if (uClouds > 0.0 && d.y > 0.02) {
          vec2 q = d.xz / (d.y + 0.22) * 1.6 + vec2(3.7, 1.3);
          float n = 0.0, a = 0.5;
          for (int i = 0; i < 4; i++) {
            vec2 ip = floor(q), fp = fract(q);
            fp = fp * fp * (3.0 - 2.0 * fp);
            float v = mix(mix(hash13(vec3(ip, 1.0)), hash13(vec3(ip + vec2(1.0, 0.0), 1.0)), fp.x),
                          mix(hash13(vec3(ip + vec2(0.0, 1.0), 1.0)), hash13(vec3(ip + vec2(1.0, 1.0), 1.0)), fp.x), fp.y);
            n += a * v; a *= 0.5; q = q * 2.03 + 7.1;
          }
          float cov = smoothstep(0.52, 0.78, n) * smoothstep(0.02, 0.22, d.y) * uClouds;
          float sunSide = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 2.0);
          vec3 cloudCol = mix(uHorizon, vec3(1.0), 0.55 * (1.0 - uNight)) + uSunColor * 0.18 * sunSide * uGlow;
          cloudCol = mix(cloudCol, uHorizon * 1.25, uNight);
          col = mix(col, cloudCol, cov * 0.75);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000; // first: everything else draws over it
  mesh.matrixAutoUpdate = false;
  return mesh;
}
