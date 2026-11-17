import * as THREE from "three";

/**
 * The scene's "atmosphere": one pure function from the sun's altitude and
 * azimuth to every colour, light intensity and exposure the scene needs.
 * Colours are authored as display sRGB hex; THREE.Color converts them to the
 * linear working space.
 */
export interface Atmosphere {
  altDeg: number;
  azDeg: number;
  /** Unit vector towards the real sun (may point below the horizon). */
  sunDir: THREE.Vector3;
  /** Unit vector towards the key light: the sun while it is up, a fixed moon after dusk. */
  lightDir: THREE.Vector3;
  /** Sky dome gradient. The horizon doubles as the fog colour: ground and sky meet seamlessly. */
  zenith: THREE.Color;
  horizon: THREE.Color;
  /** Key light (directional, casts the shadow). */
  sunColor: THREE.Color;
  sunIntensity: number;
  /** Hemisphere fill: sky colour from above, bounce colour from below. */
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  /** Strength of the sun halo painted into the dome. */
  glow: number;
  /** 0..1 — drives window lights, street lights and stars. */
  night: number;
  /** renderer.toneMappingExposure */
  exposure: number;
  shadowIntensity: number;
}

interface AtmosphereKey {
  /** Sun altitude in degrees this keyframe applies at. */
  alt: number;
  zenith: string;
  horizon: string;
  sun: string;
  sunI: number;
  sky: string;
  gnd: string;
  hemiI: number;
  glow: number;
  night: number;
  exposure: number;
  shadow: number;
}

// Keyframes by sun altitude (degrees). Everything between is linearly interpolated.
const KEYS: readonly AtmosphereKey[] = [
  { alt: -18, zenith: "#070a14", horizon: "#25262f", sun: "#aab8d6", sunI: 0.4, sky: "#2a3146", gnd: "#3a312b", hemiI: 1.0, glow: 0.0, night: 1.0, exposure: 1.0, shadow: 0.55 },
  { alt: -8, zenith: "#0d1630", horizon: "#3a3f58", sun: "#aab8d6", sunI: 0.36, sky: "#364468", gnd: "#3d342e", hemiI: 1.05, glow: 0.0, night: 1.0, exposure: 1.0, shadow: 0.5 },
  { alt: -4, zenith: "#1b2f5e", horizon: "#7f7c92", sun: "#ffb089", sunI: 0.0, sky: "#566a94", gnd: "#4a4440", hemiI: 1.3, glow: 0.35, night: 0.75, exposure: 1.05, shadow: 0.0 },
  { alt: -0.5, zenith: "#34539a", horizon: "#f0b48c", sun: "#ff9a5c", sunI: 0.9, sky: "#8a9ccc", gnd: "#75625a", hemiI: 1.5, glow: 0.9, night: 0.3, exposure: 1.15, shadow: 0.85 },
  { alt: 5, zenith: "#4577c8", horizon: "#f3d3b0", sun: "#ffbf85", sunI: 2.5, sky: "#a9bde6", gnd: "#94806f", hemiI: 1.6, glow: 1.0, night: 0.0, exposure: 1.2, shadow: 0.95 },
  { alt: 14, zenith: "#4a8ae0", horizon: "#e3e8ea", sun: "#ffe6c4", sunI: 2.9, sky: "#b9cdf0", gnd: "#9a8f80", hemiI: 1.4, glow: 0.8, night: 0.0, exposure: 1.05, shadow: 1.0 },
  { alt: 35, zenith: "#3f86e6", horizon: "#d7e6f2", sun: "#fff4e2", sunI: 3.1, sky: "#c2d6f6", gnd: "#a59c8e", hemiI: 1.3, glow: 0.6, night: 0.0, exposure: 1.0, shadow: 1.0 },
  { alt: 75, zenith: "#3a80e4", horizon: "#d3e4f3", sun: "#fff8ee", sunI: 3.2, sky: "#c6daf8", gnd: "#a8a092", hemiI: 1.25, glow: 0.5, night: 0.0, exposure: 0.95, shadow: 1.0 },
];

/** Sun altitude (degrees) at which the sun key has faded to zero and the moon takes over. */
const MOON_HANDOVER_ALT_DEG = -4;

function lerpHex(a: string, b: string, t: number): THREE.Color {
  return new THREE.Color(a).lerp(new THREE.Color(b), t);
}

/**
 * Unit vector for a compass azimuth (0 = N, 90 = E) and an altitude above the
 * horizon, both in degrees. Three-space: x east, y up, z = -north.
 */
function dirFromAltAz(altDeg: number, azDeg: number): THREE.Vector3 {
  const alt = (altDeg * Math.PI) / 180;
  const az = (azDeg * Math.PI) / 180;
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(alt),
    Math.sin(alt),
    -Math.cos(az) * Math.cos(alt),
  );
}

export function atmosphereAt(altDeg: number, azDeg: number): Atmosphere {
  let i = 0;
  while (i < KEYS.length - 2 && altDeg > KEYS[i + 1]!.alt) i++;
  const a = KEYS[i]!;
  const b = KEYS[i + 1]!;
  const t = THREE.MathUtils.clamp((altDeg - a.alt) / (b.alt - a.alt), 0, 1);
  const mix = (from: number, to: number): number => from + (to - from) * t;
  // Key light: the sun while it is up; after dusk a fixed "moon" (high, cool,
  // from the south-east) so the city keeps readable form and soft shadows
  // instead of going black. The hand-over happens exactly where the sun key
  // has faded to zero, so nothing pops.
  const sunUp = altDeg > MOON_HANDOVER_ALT_DEG;
  return {
    altDeg,
    azDeg,
    sunDir: dirFromAltAz(altDeg, azDeg),
    lightDir: sunUp ? dirFromAltAz(Math.max(altDeg, 3), azDeg) : dirFromAltAz(48, 150),
    zenith: lerpHex(a.zenith, b.zenith, t),
    horizon: lerpHex(a.horizon, b.horizon, t),
    sunColor: lerpHex(a.sun, b.sun, t),
    sunIntensity: mix(a.sunI, b.sunI),
    hemiSky: lerpHex(a.sky, b.sky, t),
    hemiGround: lerpHex(a.gnd, b.gnd, t),
    hemiIntensity: mix(a.hemiI, b.hemiI),
    glow: mix(a.glow, b.glow),
    night: mix(a.night, b.night),
    exposure: mix(a.exposure, b.exposure),
    shadowIntensity: mix(a.shadow, b.shadow),
  };
}
