import * as THREE from "three";
import { SKY_GLSL, type SkyUniforms } from "./sky";

/**
 * Facade material for the surrounding ("context") buildings: ONE merged mesh,
 * ONE draw call, MeshLambertMaterial + onBeforeCompile.
 *   - injected BEFORE lighting / tone mapping / fog (albedo + emissive), not after them
 *   - per-building attribute aBld = (seed, roof height, class, sink flag) -> material classes,
 *     parapets, per-building night look
 *   - derivative-based anti-aliasing + distance LOD (no moire)
 *   - recessed-window parallax up close, sky reflection on glass classes, shop fronts,
 *     lit windows at night
 * World-space math means the merged geometry needs no UVs.
 */

export const FacadeClass = { MASONRY: 0, CONCRETE: 1, GLASS: 2, DARK: 3 } as const;
export type FacadeClass = (typeof FacadeClass)[keyof typeof FacadeClass];

// Muted, slightly warm hue families with their values compressed into a light
// band (L* ~ 66-84), so the context reads as "city" but never out-contrasts
// the tracked tower or the unit marks. Variety comes from hue, not from value.
const WALL_PALETTE: Record<FacadeClass, readonly string[]> = {
  [FacadeClass.MASONRY]: [
    "#cdb5a6", "#c6ad9f", "#d5c4b1", "#dcd2c2", "#c9b3a0", "#c2ab9d", "#d8ccbe",
  ],
  [FacadeClass.CONCRETE]: ["#d6d3cb", "#cfccc3", "#dedbd4", "#cac6bc", "#d9d4c8"],
  [FacadeClass.GLASS]: ["#bcc7ce", "#b3c0ca", "#c3cdd2", "#aebbc6"],
  [FacadeClass.DARK]: ["#a2a9b0", "#989fa6", "#aaa49d"],
};
const ROOF_PALETTE: readonly string[] = ["#c2bfb7", "#b8b5ad", "#cbc8bf", "#b1afa8"];

/** Deterministic 0..1 hash of an OSM id: every per-building choice derives from it. */
export function seedOf(osmId: number): number {
  return (((osmId * 2654435761) >>> 8) % 100000) / 100000;
}

/** Material class by height band, with the seed picking within the band's mix. */
export function classFor(height: number, seed: number): FacadeClass {
  const r = (seed * 7.13) % 1;
  if (height < 14) return r < 0.82 ? FacadeClass.MASONRY : FacadeClass.CONCRETE;
  if (height < 45) {
    return r < 0.45 ? FacadeClass.MASONRY : r < 0.85 ? FacadeClass.CONCRETE : FacadeClass.GLASS;
  }
  if (height < 110) {
    return r < 0.38 ? FacadeClass.CONCRETE : r < 0.84 ? FacadeClass.GLASS : FacadeClass.DARK;
  }
  return r < 0.58 ? FacadeClass.GLASS : r < 0.85 ? FacadeClass.DARK : FacadeClass.CONCRETE;
}

/** Writes the building's wall colour into `target`. */
export function wallColor(cls: FacadeClass, seed: number, target: THREE.Color): THREE.Color {
  const palette = WALL_PALETTE[cls];
  target.set(palette[Math.floor(seed * 977) % palette.length]!);
  return target.offsetHSL(0, 0, ((seed * 31) % 1) * 0.05 - 0.025);
}

/** Writes the building's roof colour into `target`. */
export function roofColor(seed: number, target: THREE.Color): THREE.Color {
  return target.set(ROOF_PALETTE[Math.floor(seed * 613) % ROOF_PALETTE.length]!);
}

export type FacadeUniforms = {
  /** xz centre, radius and height of the tracked tower: the axis of the view-corridor cutaway. */
  uHero: THREE.IUniform<THREE.Vector4>;
  /**
   * Strength of the view-corridor cutaway, which dissolves whatever stands
   * between the camera and the tracked tower. 0 = off; it also needs the
   * material's alphaToCoverage to be compiled in at all.
   */
  uCutaway: THREE.IUniform<number>;
  /** 1 = light, low-contrast glazing that matches the wall palette; 0 = dark glazing. */
  uCalm: THREE.IUniform<number>;
  /** Height (m) that buildings flagged in aBld.w are flattened to. */
  uSinkTo: THREE.IUniform<number>;
};

export function makeFacadeUniforms(hero: {
  x: number;
  z: number;
  radius: number;
  height: number;
}): FacadeUniforms {
  return {
    uHero: { value: new THREE.Vector4(hero.x, hero.z, hero.radius, hero.height) },
    uCutaway: { value: 0 },
    uCalm: { value: 1 },
    uSinkTo: { value: 7 },
  };
}

export function makeFacadeMaterial(
  sky: SkyUniforms,
  uniforms: FacadeUniforms,
): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec4 aBld;
        uniform float uSinkTo;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        flat out vec4 vBld;   // per-building constants MUST be flat: interpolated "constants" jitter in the last bits and make hashes sparkle`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        // "sink" flagged occluders to podium height
        if (aBld.w > 0.5) transformed.y = min(transformed.y, uSinkTo);`,
      )
      .replace(
        "#include <worldpos_vertex>",
        /* glsl */ `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);
        vBld = aBld;
        if (aBld.w > 0.5) vBld.y = min(aBld.y, uSinkTo);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        flat in vec4 vBld;
        uniform vec4 uHero;      // xz centre, radius, height of the tracked tower (view-corridor cutaway)
        uniform float uCutaway;  // 0 = off
        uniform float uCalm;     // 1 = low-contrast glazing
        ${SKY_GLSL}
        float fHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        // anti-aliased 0..1 box in cell space; w = filter width in cell units
        float fBox(float x, float lo, float hi, float w) {
          return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
        }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec3 fcN = normalize(vWNrm);
        vec3 fcV = normalize(cameraPosition - vWPos);
        vec3 fcEmissive = vec3(0.0);
        vec3 fcReflect = vec3(0.0);
        float fcCls = vBld.z;
        float fcSeed = vBld.x;
        if (abs(fcN.y) < 0.3) {
          // ---- wall ----
          vec2 hn = normalize(fcN.xz + vec2(1e-5));
          vec2 tg = vec2(-hn.y, hn.x);
          float along = dot(vWPos.xz, tg) + fcSeed * 17.0;       // per-building phase so grids don't line up
          float isGlass = step(1.5, fcCls);
          float floorH = fcCls < 0.5 ? 3.3 : (fcCls < 1.5 ? 3.6 : 3.9);
          float bayW = fcCls < 0.5 ? 2.7 + fract(fcSeed * 5.0) * 0.8 : (fcCls < 1.5 ? 3.4 : 1.5);
          // window opening inside one bay (fractions of the cell)
          vec2 lo = fcCls < 0.5 ? vec2(0.28, 0.30) : (fcCls < 1.5 ? vec2(0.14, 0.26) : vec2(0.05, 0.24));
          vec2 hi = fcCls < 0.5 ? vec2(0.72, 0.82) : (fcCls < 1.5 ? vec2(0.86, 0.84) : vec2(0.95, 0.985));
          float h = vWPos.y;
          float shopH = vBld.y > 13.0 ? 4.6 : 0.0;               // street-level retail band on anything above ~4 floors
          vec2 cellUv = vec2(along / bayW, (h - shopH) / floorH);
          vec2 cell = floor(cellUv);
          vec2 f = fract(cellUv);
          vec2 fw = vec2(fwidth(cellUv.x), fwidth(cellUv.y));
          float lod = smoothstep(0.22, 0.6, max(fw.x, fw.y));   // 0 near .. 1 when a bay is < ~2 px
          float cover = (hi.x - lo.x) * (hi.y - lo.y);
          float body = step(shopH, h) * step(h, vBld.y - 1.4);   // no windows in the parapet / shop band
          float open = fBox(f.x, lo.x, hi.x, fw.x * 0.75) * fBox(f.y, lo.y, hi.y, fw.y * 0.75);
          // recessed glass: shift the glass plane by the view parallax (0.35 m reveal) - near field only
          vec2 par = vec2(dot(fcV.xz, tg), fcV.y) / max(dot(fcV.xz, hn), 0.2) * (isGlass > 0.5 ? 0.08 : 0.35);
          vec2 fr = f - par / vec2(bayW, floorH);
          float glassNear = open * fBox(fr.x, lo.x, hi.x, fw.x * 0.75) * fBox(fr.y, lo.y, hi.y, fw.y * 0.75);
          float glass = mix(glassNear, cover, lod) * body;
          float reveal = (open - glassNear) * (1.0 - lod) * body;  // the jamb / sill you see obliquely
          float rnd = fHash(cell + fcSeed * 91.0);
          // albedo (+ base occlusion: walls darken over the lowest ~11 m, per fragment so it needs no extra vertices)
          vec3 wall = diffuseColor.rgb * mix(0.80, 1.0, smoothstep(0.0, 11.0, h));
          vec3 glassCol = mix(mix(vec3(0.10, 0.13, 0.17), vec3(0.22, 0.26, 0.30), rnd), mix(vec3(0.27, 0.31, 0.36), vec3(0.40, 0.44, 0.48), rnd), uCalm) * (isGlass > 0.5 ? 1.0 : 0.9);
          // blinds / curtains: some panes read light
          glassCol = mix(glassCol, wall * 0.9, step(0.78, rnd) * (1.0 - lod) * 0.75);
          diffuseColor.rgb = mix(wall, glassCol, glass);
          diffuseColor.rgb *= 1.0 - reveal * 0.45;
          // parapet / cornice line + a faint floor line on masonry and concrete
          float cap = smoothstep(vBld.y - 1.0, vBld.y - 0.8, h);
          diffuseColor.rgb *= 1.0 - cap * 0.16;
          // street-level shop band: dark continuous glazing between piers
          float shop = step(0.4, h) * step(h, shopH - 0.9) * step(0.5, shopH);
          float pier = fBox(fract(along / 6.0), 0.07, 0.93, fwidth(along / 6.0));
          float shopGlass = shop * mix(pier, 0.86, smoothstep(0.2, 0.6, fwidth(along / 6.0)));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.12, 0.14, 0.16), shopGlass * 0.85);
          // reflections: fresnel-weighted analytic sky (same function the dome draws)
          float ndv = clamp(dot(fcN, fcV), 0.0, 1.0);
          float fres = 0.05 + 0.95 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-fcV, fcN);
          vec3 skyR = skyGradient(vec3(R.x, abs(R.y) * 0.6 + 0.02, R.z)) * mix(0.55, 1.0, smoothstep(-0.3, 0.2, R.y));
          fcReflect = skyR * fres * (glass * mix(0.55, 1.0, isGlass) + shopGlass * 0.6);
          // night: lit windows (per-building share, warm/neutral/cool mix), shop fronts glow
          if (uNight > 0.01) {
            float share = mix(0.16, 0.5, fract(fcSeed * 13.7)) * (isGlass > 0.5 ? 0.75 : 1.0);
            float rowLit = step(0.72, fHash(vec2(cell.y, fcSeed * 57.0))) * isGlass;      // whole office floors left on
            float lit = max(step(1.0 - share, fract(rnd * 7.31)), rowLit * step(0.25, rnd));
            float tone = fract(rnd * 3.17);
            vec3 warm = tone < 0.62 ? vec3(1.0, 0.74, 0.42) : (tone < 0.9 ? vec3(1.0, 0.9, 0.72) : vec3(0.62, 0.78, 1.0));
            float litMask = mix(glassNear * lit, cover * share, lod) * body;
            fcEmissive += warm * litMask * (0.38 + 0.62 * fract(rnd * 11.3)) * uNight;
            fcEmissive += vec3(1.0, 0.8, 0.52) * shopGlass * step(0.35, fHash(vec2(floor(along / 6.0), fcSeed))) * 0.8 * uNight;
          }
        } else {
          // ---- roof ----
          // roof: baked class colour + low-frequency blotches + a faint 6 m paver/membrane grid that fades with distance
          vec2 rp = vWPos.xz;
          float blot = fHash(floor(rp / 9.0) + fcSeed * 31.0) * 0.5 + fHash(floor(rp / 3.5) + fcSeed * 7.0) * 0.5;
          vec2 rg = abs(fract(rp / 6.0) - 0.5);
          float rline = smoothstep(0.47, 0.5, max(rg.x, rg.y)) * (1.0 - smoothstep(0.06, 0.25, fwidth(rp.x / 6.0)));
          diffuseColor.rgb *= (0.955 + 0.07 * blot) * (1.0 - 0.06 * rline);
        }
        // ---- view-corridor cutaway: dissolve whatever stands between the camera and the tracked tower ----
        #ifdef ALPHA_TO_COVERAGE
        if (uCutaway > 0.0) {
          vec2 c2 = cameraPosition.xz;
          vec2 toHero = uHero.xy - c2;
          float L = length(toHero);
          vec2 dir = toHero / L;
          float tAlong = dot(vWPos.xz - c2, dir);
          float lat = abs(dot(vWPos.xz - c2, vec2(-dir.y, dir.x)));
          float nearFace = L - uHero.z;
          float between = smoothstep(4.0, 30.0, tAlong) * (1.0 - smoothstep(nearFace - 14.0, nearFace - 2.0, tAlong));
          float corridor = 1.0 - smoothstep(uHero.z * 0.85, uHero.z * 1.35, lat);
          float sight = cameraPosition.y * (1.0 - tAlong / max(nearFace, 1.0)); // height of the line camera -> tower base
          float hides = smoothstep(-3.0, 3.0, vWPos.y - sight);
          float cut = between * corridor * hides * uCutaway;
          // 4x4 ordered dither on top of MSAA coverage -> smooth-looking fade without a transparent pass
          const float BAYER[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
          ivec2 q = ivec2(mod(gl_FragCoord.xy, 4.0));
          float bayer = BAYER[q.x + q.y * 4] / 16.0;
          diffuseColor.a = clamp(1.0 - cut * 0.92 + (bayer - 0.5) * 0.24 * step(0.01, cut), 0.0, 1.0);
        }
        #endif
        `,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += fcEmissive;`,
      )
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `outgoingLight += fcReflect;
        #include <opaque_fragment>`,
      );
  };
  // The injected shader is the same for every instance: let three share one program.
  material.customProgramCacheKey = () => "context-facade";
  return material;
}
