import * as THREE from "three";
import { BELT_SLOT_BASE } from "./markGeometry";
import { MARK_COLORS } from "./unitMarks";

/**
 * The unlit material of the unit marks (geometry: markGeometry.ts). One
 * shader draws every kind of mark inside its quad from the quad's local
 * coordinates in metres: body, outline, hatch, whiskers, dashes, a dark edge
 * and the hover / selection ring. Line weights never fall below a set number
 * of screen pixels, so an outline is still an outline from across the street.
 *
 * Unlit, no fog, not tone-mapped: a mark has the legend's colour at noon, at
 * golden hour and at night. No depth write, so marks cannot z-fight with each
 * other, and a polygon offset keeps them clear of the wall at any distance.
 *
 * Two passes share the geometry:
 *   "ghost"  no depth test, faint — what the tower (or a neighbour) hides is
 *            still hinted at, so the viewer knows there is more on the far side;
 *   "solid"  depth-tested, drawn over the ghosts.
 */
export type MarkPass = "ghost" | "solid";

/** Opacity of a mark seen through the tower. */
const GHOST_OPACITY = 0.24;
/** ...and of the hovered / selected one, which has to be found wherever it is. */
const GHOST_LIT_OPACITY = 0.8;

export interface MarkUniforms {
  [uniform: string]: THREE.IUniform<unknown>;
  /** 1 in the ghost pass. */
  uGhost: THREE.IUniform<number>;
  /** State index of the hovered mark, -1 = none. */
  uHover: THREE.IUniform<number>;
  /** State index of the selected mark, -1 = none. */
  uSelected: THREE.IUniform<number>;
  /** Device pixels per CSS pixel: line weights are set in CSS pixels. */
  uDpr: THREE.IUniform<number>;
  uCasing: THREE.IUniform<THREE.Color>;
  uRing: THREE.IUniform<THREE.Color>;
}

const VERTEX = /* glsl */ `
  attribute vec2 aLocal;
  attribute vec4 aShape;
  attribute vec4 aStyle;
  attribute vec3 aColor;
  varying vec2 vLocal;
  flat out vec4 vShape;
  flat out vec4 vStyle;
  flat out vec3 vColor;
  void main() {
    vLocal = aLocal;
    vShape = aShape;
    vStyle = aStyle;
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform float uGhost;
  uniform float uHover;
  uniform float uSelected;
  uniform float uDpr;
  uniform vec3 uCasing;
  uniform vec3 uRing;
  varying vec2 vLocal;
  flat in vec4 vShape;
  flat in vec4 vStyle;
  flat in vec3 vColor;

  // Coverage (0..1) of the box |p| <= h + grow, anti-aliased over one pixel; px = metres per pixel.
  float boxCov(vec2 p, vec2 h, vec2 grow, vec2 px) {
    vec2 d = (abs(p) - h - grow) / px;
    return clamp(0.5 - max(d.x, d.y), 0.0, 1.0);
  }

  void main() {
    float kind = vStyle.x;   // 0 plate, 1 band, 2 strip, 3 whisker
    float fill = vStyle.y;   // 0 outline, 1 solid, 2 hatch, 3 muted
    float id = vStyle.z;
    vec2 p = vLocal;
    vec2 px = max(fwidth(vLocal), vec2(1e-5));
    vec2 hs = vShape.xy;
    bool selected = abs(id - uSelected) < 0.5;
    bool lit = selected || abs(id - uHover) < 0.5;
    bool muted = fill > 2.5;
    float ghost = step(0.5, uGhost);

    vec3 acc = vec3(0.0);    // premultiplied colour
    float a = 0.0;

    if (kind > 2.5) {
      // ---- whisker: a line from each side of the plate, ending in a tick ----
      float reach = p.x < 0.0 ? vShape.z : vShape.w;
      float ax = abs(p.x) - hs.x;                         // metres beyond the plate's edge
      float weight = muted ? 0.75 : 1.0;
      float run = clamp(ax / px.x + 0.5, 0.0, 1.0) * clamp((reach - ax) / px.x + 0.5, 0.0, 1.0);
      float thick = max(0.34, 1.5 * uDpr * px.y) * weight;
      float line = clamp((0.5 * thick - abs(p.y)) / px.y + 0.5, 0.0, 1.0);
      float tickW = max(0.34, 1.5 * uDpr * px.x) * weight;
      float tick = clamp((ax - (reach - tickW)) / px.x + 0.5, 0.0, 1.0)
                 * clamp((hs.y - abs(p.y)) / px.y + 0.5, 0.0, 1.0);
      a = run * max(line, tick) * step(0.01, reach) * (muted ? 0.85 : 1.0);
      acc = vColor * a;
    } else {
      if (kind > 0.5 && kind < 1.5) {
        // ---- band: the perimeter is cut into dashes; this listing owns every count-th one ----
        // A band goes all the way round: its near side says everything, and its far side seen
        // through the tower would only draw a second, slanted row of dashes across the first.
        if (ghost > 0.5) discard;
        float period = vShape.z;
        float count = floor(vShape.w / ${BELT_SLOT_BASE.toFixed(1)} + 0.001);
        float slot = vShape.w - count * ${BELT_SLOT_BASE.toFixed(1)};
        float cell = floor(p.x / period);
        if (abs(mod(cell, count) - slot) > 0.5) discard;
        p.x = (fract(p.x / period) - 0.5) * period;
      }
      // line weight in metres, per axis: never thinner than ~1.7 CSS px, never more than a third of the body
      vec2 line = max(vec2(muted ? 0.34 : 0.42), (muted ? 1.4 : 1.7) * uDpr * px);
      line = min(line, hs * 0.62);
      float body = boxCov(p, hs, vec2(0.0), px);
      float inner = boxCov(p, hs, -line, px);
      float edge = max(body - inner, 0.0);

      if (fill < 0.5) {                 // outline: the colour as a frame, a thin wash inside
        a = edge + inner * 0.16;
        acc = vColor * a;
      } else if (fill < 1.5) {          // solid
        a = body;
        acc = vColor * a;
      } else if (fill < 2.5) {          // hatch: diagonal stripes of the colour on a dark wash
        float pitch = max(1.25, 5.0 * uDpr * max(px.x, px.y));
        float t = (p.x + p.y) / pitch;
        float w = (px.x + px.y) / pitch;
        float stripe = clamp((0.25 - abs(fract(t) - 0.5)) / max(w, 1e-4) + 0.5, 0.0, 1.0);
        float gapA = inner * (1.0 - stripe) * 0.34;
        float colA = edge + inner * stripe;
        a = colA + gapA;
        acc = vColor * colA + uCasing * gapA;
      } else {                          // muted: a grey frame around a pale wash — there, and out of the way
        float washA = inner * 0.3;
        a = edge + washA;
        acc = vColor * edge + uRing * washA;
      }

      // hover / selection ring just outside the body, then a dark edge outside that
      vec2 ringW = lit ? max(vec2(selected ? 0.55 : 0.32), (selected ? 3.0 : 1.9) * uDpr * px) : vec2(0.0);
      float ringCov = max(boxCov(p, hs, ringW, px) - body, 0.0);
      vec2 caseW = max(vec2(0.1), 1.0 * uDpr * px);
      float caseCov = max(boxCov(p, hs, ringW + caseW, px) - boxCov(p, hs, ringW, px), 0.0);
      float caseA = caseCov * (lit ? 0.6 : (muted ? 0.0 : 0.5 * (1.0 - ghost)));
      acc += uRing * ringCov + uCasing * caseA;
      a += ringCov + caseA;
    }

    float seen = mix(1.0, lit ? ${GHOST_LIT_OPACITY.toFixed(2)} : ${GHOST_OPACITY.toFixed(2)}, ghost);
    a *= seen;
    acc *= seen;
    if (a < 0.004) discard;
    gl_FragColor = vec4(acc / a, a);
    #include <colorspace_fragment>
  }
`;

export function makeMarkMaterial(pass: MarkPass): THREE.ShaderMaterial & { uniforms: MarkUniforms } {
  const uniforms: MarkUniforms = {
    uGhost: { value: pass === "ghost" ? 1 : 0 },
    uHover: { value: -1 },
    uSelected: { value: -1 },
    uDpr: { value: 1 },
    uCasing: { value: new THREE.Color(MARK_COLORS.casing) },
    uRing: { value: new THREE.Color(MARK_COLORS.ring) },
  };
  const material = new THREE.ShaderMaterial({
    name: `unit-marks-${pass}`,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: pass === "solid",
    // Every quad faces outward. The ghost pass also has to show the ones seen from behind.
    side: pass === "solid" ? THREE.FrontSide : THREE.DoubleSide,
    toneMapped: false,
    fog: false,
    polygonOffset: pass === "solid",
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -6,
  });
  return material as THREE.ShaderMaterial & { uniforms: MarkUniforms };
}
