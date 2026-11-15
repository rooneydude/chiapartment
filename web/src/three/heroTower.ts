import * as THREE from "three";
import type { Vec2 } from "../../../shared/src/placement";
import { SKY_GLSL, type SkyUniforms } from "./sky";

/**
 * A tracked tower as an opaque glass-and-floor-plate curtain wall.
 * Geometry: one quad per footprint edge (uv = metres along the edge, metres
 * above ground; aEdge = edge length, edge id) plus a parapet lip and a
 * recessed roof. Material: MeshLambertMaterial + onBeforeCompile, no textures.
 */

/**
 * Inward offset of a CCW ring by d metres (mitred corners; fine for the small
 * offsets used for the parapet).
 */
function insetRing(ring: Vec2[], d: number): Vec2[] {
  const n = ring.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ring[(i + n - 1) % n]!;
    const p1 = ring[i]!;
    const p2 = ring[(i + 1) % n]!;
    const e1x = p1[0] - p0[0];
    const e1y = p1[1] - p0[1];
    const e2x = p2[0] - p1[0];
    const e2y = p2[1] - p1[1];
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    // inward normals of a CCW ring are the left normals
    const n1x = -e1y / l1;
    const n1y = e1x / l1;
    const n2x = -e2y / l2;
    const n2y = e2x / l2;
    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by) || 1;
    bx /= bl;
    by /= bl;
    const cosHalf = Math.max(bx * n1x + by * n1y, 0.35);
    out.push([p1[0] + (bx * d) / cosHalf, p1[1] + (by * d) / cosHalf]);
  }
  return out;
}

type Point3 = readonly [number, number, number];
type Point2 = readonly [number, number];

/** Height of the parapet above the roof and width of its coping, in metres. */
const PARAPET_M = 1.1;
const COPING_M = 0.45;

/**
 * ring: CCW open ring in plan metres (x east, y north). Output is three-space (x, up, -north).
 * Walls run 0..zTop; the roof sits a parapet's height below the wall top behind the coping.
 */
export function buildHeroGeometry(ring: Vec2[], zTop: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const edge: number[] = [];
  const idx: number[] = [];
  const quad = (
    corners: readonly [Point3, Point3, Point3, Point3],
    normal: Point3,
    uvs: readonly [Point2, Point2, Point2, Point2],
    edgeAttr: Point2,
  ): void => {
    const base = pos.length / 3;
    for (const p of corners) pos.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) {
      nrm.push(normal[0], normal[1], normal[2]);
      edge.push(edgeAttr[0], edgeAttr[1]);
    }
    for (const t of uvs) uv.push(t[0], t[1]);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const P = (p: Vec2, z: number): Point3 => [p[0], z, -p[1]];
  const UNIT_UVS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    // outward normal of a CCW ring = right normal of the edge; plan (nx, ny) -> three (nx, 0, -ny)
    const nx = (b[1] - a[1]) / len;
    const ny = -(b[0] - a[0]) / len;
    quad(
      [P(a, 0), P(b, 0), P(b, zTop), P(a, zTop)],
      [nx, 0, -ny],
      [[0, 0], [len, 0], [len, zTop], [0, zTop]],
      [len, i + 1],
    );
  }
  // parapet: coping strip (top), inner face, recessed roof
  const inner = insetRing(ring, COPING_M);
  const zRoof = zTop - PARAPET_M;
  for (let i = 0; i < n; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!;
    const ia = inner[i]!;
    const ib = inner[(i + 1) % n]!;
    quad([P(a, zTop), P(b, zTop), P(ib, zTop), P(ia, zTop)], [0, 1, 0], UNIT_UVS, [0, -1]);
    const len = Math.hypot(ib[0] - ia[0], ib[1] - ia[1]) || 1;
    const nx = -(ib[1] - ia[1]) / len; // inward-facing
    const ny = (ib[0] - ia[0]) / len;
    quad([P(ib, zRoof), P(ia, zRoof), P(ia, zTop), P(ib, zTop)], [nx, 0, -ny], UNIT_UVS, [0, -1]);
  }
  const tris = THREE.ShapeUtils.triangulateShape(
    inner.map((p) => new THREE.Vector2(p[0], p[1])),
    [],
  );
  const base = pos.length / 3;
  for (const p of inner) {
    pos.push(p[0], zRoof, -p[1]);
    nrm.push(0, 1, 0);
    uv.push(p[0], p[1]);
    edge.push(0, -2); // -2 = roof membrane
  }
  for (const t of tris) idx.push(base + t[0]!, base + t[1]!, base + t[2]!);

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 2));
  g.setIndex(idx);
  return g;
}

export interface HeroMaterialOptions {
  /** Residential storeys and the height of one, in metres. */
  floors: number;
  floorHeightM: number;
  /** Height of the lobby / retail podium below the first residential floor, in metres. */
  podiumHeightM: number;
  /** Spandrel / mullion metal and the body colour of the glass. */
  frame: THREE.ColorRepresentation;
  glass: THREE.ColorRepresentation;
  /** Share (0..1) of rooms with their lights on at night. */
  litShare: number;
  /** Paint the parapet in the accent colour: the mark of the tower this page is about. */
  crown: boolean;
  /**
   * What the glass "sees" below the horizon (the sun-lit city). Shared by
   * reference so one update per atmosphere reaches every tower.
   */
  groundReflection: THREE.IUniform<THREE.Color>;
}

export type HeroUniforms = {
  uFloors: THREE.IUniform<number>;
  uFloorH: THREE.IUniform<number>;
  uBase: THREE.IUniform<number>;
  /** Width of one curtain-wall pane, in metres. */
  uModule: THREE.IUniform<number>;
  /** Colour mixed into frame, glass and reflections by uTintAmt (0 = none). */
  uTint: THREE.IUniform<THREE.Color>;
  uTintAmt: THREE.IUniform<number>;
  /** Colour of the crown and of the per-floor marks. */
  uAccent: THREE.IUniform<THREE.Color>;
  /**
   * Optional floors x 1 RGBA8 texture of per-floor state: R = "has available
   * units", G = inside the floor filter, B = selected floor. The shader lights
   * the slab-edge band of flagged floors — honest at every placement
   * confidence, because only the FLOOR is asserted.
   */
  uFloorTex: THREE.IUniform<THREE.DataTexture | null>;
  uHasFloorTex: THREE.IUniform<number>;
  uLitShare: THREE.IUniform<number>;
  uGroundRefl: THREE.IUniform<THREE.Color>;
  /** 1 = light, low-contrast curtain wall (the contrast is left to the unit marks); 0 = dark vision glass. */
  uQuiet: THREE.IUniform<number>;
  uCrown: THREE.IUniform<number>;
  uFrameCol: THREE.IUniform<THREE.Color>;
  uGlassCol: THREE.IUniform<THREE.Color>;
};

/** The light theme's accent; owners recolour through uniforms.uAccent. */
const DEFAULT_ACCENT = "#2a78d6";

export function makeHeroMaterial(
  sky: SkyUniforms,
  opts: HeroMaterialOptions,
): { material: THREE.MeshLambertMaterial; uniforms: HeroUniforms } {
  const uniforms: HeroUniforms = {
    uFloors: { value: opts.floors },
    uFloorH: { value: opts.floorHeightM },
    uBase: { value: opts.podiumHeightM },
    uModule: { value: 1.5 },
    uTint: { value: new THREE.Color(DEFAULT_ACCENT) },
    uTintAmt: { value: 0 },
    uAccent: { value: new THREE.Color(DEFAULT_ACCENT) },
    uFloorTex: { value: null },
    uHasFloorTex: { value: 0 },
    uLitShare: { value: opts.litShare },
    uGroundRefl: opts.groundReflection,
    uQuiet: { value: 1 },
    uCrown: { value: opts.crown ? 1 : 0 },
    uFrameCol: { value: new THREE.Color(opts.frame) },
    uGlassCol: { value: new THREE.Color(opts.glass) },
  };
  const material = new THREE.MeshLambertMaterial({ color: "#ffffff" });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, sky, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        attribute vec2 aEdge;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec2 vHUv;
        flat out vec2 vEdge;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        /* glsl */ `#include <worldpos_vertex>
        vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm = normalize(mat3(modelMatrix) * objectNormal);
        vHUv = uv;
        vEdge = aEdge;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying vec2 vHUv;
        flat in vec2 vEdge;
        uniform float uFloors, uFloorH, uBase, uModule, uTintAmt, uHasFloorTex, uLitShare, uQuiet, uCrown;
        uniform vec3 uTint, uAccent, uGroundRefl, uFrameCol, uGlassCol;
        uniform sampler2D uFloorTex;
        ${SKY_GLSL}
        float hHash(vec2 p) {
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }
        float hBox(float x, float lo, float hi, float w) {
          return smoothstep(lo - w, lo + w, x) * (1.0 - smoothstep(hi - w, hi + w, x));
        }`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
        vec3 hN = normalize(vWNrm);
        vec3 hV = normalize(cameraPosition - vWPos);
        vec3 hEmissive = vec3(0.0);
        vec3 hReflect = vec3(0.0);
        if (vEdge.y > 0.5) {
          // ================= curtain wall =================
          float h = vHUv.y;
          float top = uBase + uFloors * uFloorH;
          // an integer number of panes per facade, so mullions land exactly on the corners
          float panes = max(1.0, floor(vEdge.x / uModule + 0.5));
          float px = vHUv.x / vEdge.x * panes;         // pane coordinate along this facade
          float sf = (h - uBase) / uFloorH;            // storey coordinate (0 = first residential floor)
          float fi = floor(sf);
          float ff = fract(sf);
          float inTower = step(0.0, sf) * step(sf, uFloors);
          float wx = fwidth(px);
          float wy = fwidth(sf);
          float lod = smoothstep(0.25, 0.7, max(wx, wy * 0.6));
          // vision glass between slab edges; spandrel = bottom 24 % of a storey, plus a dark shadow joint
          float glassV = hBox(ff, 0.24, 0.975, wy * 0.75);
          float joint = 1.0 - hBox(ff, 0.03, 1.0, wy * 0.75);
          float mullW = 0.045 + 0.03 * step(0.5, mod(floor(px), 2.0));      // every other mullion is a unit party wall
          float glassH = hBox(fract(px), mullW, 1.0 - mullW, wx * 0.75);
          glassH = mix(glassH, 1.0 - 2.0 * mullW, lod);
          float glass = glassV * glassH * inTower;
          // podium: one tall storefront band with double-width bays and a signage band above it
          float pod = step(h, uBase);
          float px2 = px * 0.5;
          float podGlass = pod * hBox(h, 0.7, uBase - 1.0, fwidth(h)) * mix(hBox(fract(px2), 0.06, 0.94, fwidth(px2)), 0.88, lod);
          // crown: the parapet above the last storey is solid
          float crown = step(top, h);

          vec2 pane = vec2(floor(px), fi);
          float rnd = hHash(pane + 3.7);
          float room = hHash(vec2(floor(px * 0.5), fi) + 11.3);   // two panes share a room

          vec3 frame = mix(vec3(0.80, 0.82, 0.84), uTint, uTintAmt * 0.35);           // spandrel / mullion metal
          vec3 stone = vec3(0.36, 0.37, 0.39);                                       // podium base
          vec3 interior = mix(vec3(0.07, 0.09, 0.12), uTint * 0.30, uTintAmt);         // looking into a dark room
          // blinds: ~30 % of panes show a light blind drawn to a random height
          float blindLvl = step(0.8, room) * (0.25 + 0.75 * fract(room * 9.7));
          float blind = step(1.0 - blindLvl, (ff - 0.24) / 0.735) * (1.0 - lod);
          vec3 glassCol = mix(interior, vec3(0.50, 0.51, 0.50), blind * 0.7);
          if (uQuiet > 0.5) {
            // light, calm curtain wall: the glass body is a mid-light blue-grey (reads as sky-reflecting coated glass),
            // spandrels a touch lighter; a faint per-pane value jitter keeps it from looking like a flat poster.
            frame = uFrameCol;
            glassCol = uGlassCol * (0.94 + 0.12 * rnd);
            blind = 0.0;
          }
          vec3 wallCol = mix(frame, stone, pod);
          wallCol *= 1.0 - joint * mix(0.45, 0.22, uQuiet) * inTower * (1.0 - lod);
          wallCol = mix(wallCol, frame * 0.9, crown);
          float crownBand = smoothstep(top + 0.15, top + 0.35, h) * uCrown;
          wallCol = mix(wallCol, uAccent, crownBand);
          diffuseColor.rgb = mix(wallCol, glassCol, max(glass, podGlass));

          // --- reflections: per-pane tilt (real curtain walls are never perfectly flat) + fresnel ---
          vec3 T = normalize(cross(vec3(0.0, 1.0, 0.0), hN));
          float tilt = mix(0.022, 0.008, uQuiet);
          vec3 Np = normalize(hN + T * (rnd - 0.5) * tilt + vec3(0.0, 1.0, 0.0) * (fract(rnd * 5.3) - 0.5) * tilt);
          vec3 R = reflect(-hV, Np);
          float ndv = clamp(dot(Np, hV), 0.0, 1.0);
          float fres = 0.20 + 0.80 * pow(1.0 - ndv, 5.0);       // coated architectural glass: ~20 % at normal incidence
          // What the glass "sees": sky above the horizon; below it the sun-lit city (uGroundRefl). The switch is
          // deliberately wide and the upper floors see more sky (fewer neighbours in the way) - that vertical
          // gradient is what makes a flat facade read as glass.
          float skyVis = smoothstep(-0.75, 0.25, R.y + 0.55 * (h / top - 0.5));
          vec3 env = mix(uGroundRefl, skyGradient(vec3(R.x, max(R.y, 0.0) + 0.12, R.z)), skyVis);
          env = mix(env, env * uTint * 2.2, uTintAmt * 0.55);
          env += skyGlow(R) * 1.5;
          float sunSpec = pow(max(dot(R, uSunDir), 0.0), 900.0) * step(0.0, uSunDir.y);
          hReflect = (env * fres * mix(1.0, 0.55, uQuiet) + uSunColor * sunSpec * mix(5.0, 1.5, uQuiet)) * (max(glass, podGlass) * (1.0 - blind * 0.7));
          hReflect += env * 0.05 * (1.0 - max(glass, podGlass));   // faint sheen on the metal

          // --- night: lit rooms ---
          if (uNight > 0.01) {
            float lit = step(1.0 - uLitShare, room);
            vec3 warm = mix(vec3(1.0, 0.72, 0.40), vec3(1.0, 0.88, 0.68), fract(room * 7.7));
            float ceilGlow = mix(0.55, 1.15, ff);                                  // brighter towards the ceiling
            float litMask = mix(glass * lit, glassV * inTower * uLitShare * 0.9, lod);
            hEmissive += warm * litMask * ceilGlow * (0.32 + 0.5 * fract(room * 3.3)) * mix(1.0, 1.3, blind) * uNight;
            hEmissive += vec3(1.0, 0.86, 0.62) * podGlass * 0.9 * uNight;           // lobby / retail always on
          }

          hEmissive += uAccent * crownBand * (0.15 + 0.85 * uNight) * 0.9;
          // night "architectural wash" (quiet style only): the tracked tower has no random lit rooms, so give the
          // facade a faint cool up-light that fades with height + a hair of light on every slab edge. Keeps the
          // floor grid readable at night without competing with unit marks.
          float wash = uQuiet * uNight * inTower;
          hEmissive += vec3(0.42, 0.50, 0.62) * wash * (0.030 + 0.075 * exp(-(h - uBase) / 28.0)) * mix(1.0, 0.55, glass);
          hEmissive += vec3(0.55, 0.62, 0.72) * wash * (1.0 - glassV) * 0.035 * (1.0 - lod);
          // --- per-floor state (availability / filter / selection) painted on the slab-edge band ---
          if (uHasFloorTex > 0.5 && inTower > 0.5) {
            vec4 st = texture2D(uFloorTex, vec2((fi + 0.5) / uFloors, 0.5));
            float band = (1.0 - glassV);
            vec3 mark = uAccent * (0.55 * st.r + 0.9 * st.b);
            diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, band * clamp(st.r * 0.85 + st.b, 0.0, 1.0));
            hEmissive += mark * band * (0.25 + 0.75 * uNight);
            // floors outside the active filter recede
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.333))) * 0.8, (1.0 - st.g) * 0.55);
            hReflect *= mix(0.45, 1.0, st.g);
          }
        } else if (vEdge.y > -1.5) {
          diffuseColor.rgb = mix(vec3(0.74, 0.75, 0.76), uAccent, uCrown);          // parapet coping + inner face
        } else {
          // roof membrane with a faint paver grid
          vec2 g = abs(fract(vHUv / 3.0) - 0.5);
          float line = smoothstep(0.47, 0.5, max(g.x, g.y)) * (1.0 - smoothstep(0.1, 0.4, fwidth(vHUv.x / 3.0)));
          diffuseColor.rgb = vec3(0.66, 0.66, 0.64) * (1.0 - 0.10 * line);
        }
        `,
      )
      .replace(
        "#include <emissivemap_fragment>",
        /* glsl */ `#include <emissivemap_fragment>
        totalEmissiveRadiance += hEmissive;`,
      )
      .replace(
        "#include <opaque_fragment>",
        /* glsl */ `outgoingLight += hReflect;
        #include <opaque_fragment>`,
      );
  };
  // The injected shader is the same for every instance: let three share one program.
  material.customProgramCacheKey = () => "hero-tower";
  return { material, uniforms };
}
