import * as THREE from "three";

/**
 * Procedural window facades injected into a Lambert material: a window grid
 * drawn in world space on near-vertical faces (floor pitch ≈ 3.1 m, window
 * pitch ≈ 2.6 m). Light mode recesses the glass slightly; dark mode lights a
 * random subset of windows warm — the night-city look. World-space math means
 * the merged single-draw-call geometry needs no UVs.
 */
export function makeFacadeMaterial(opts: {
  night: boolean;
  vertexColors: boolean;
  baseColor?: string;
}): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    ...(opts.baseColor ? { color: opts.baseColor } : {}),
    vertexColors: opts.vertexColors,
    flatShading: true,
  });

  material.onBeforeCompile = (shader) => {
    shader.uniforms["uNight"] = { value: opts.night ? 1 : 0 };

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;`,
      )
      .replace(
        "#include <worldpos_vertex>",
        `#include <worldpos_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vWorldPos;
        varying vec3 vWorldNormal;
        uniform float uNight;
        float cellHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }`,
      )
      .replace(
        "#include <dithering_fragment>",
        `{
          float vertical = 1.0 - abs(vWorldNormal.y); // 1 on walls, 0 on roofs
          if (vertical > 0.7 && vWorldPos.y > 1.5) {
            // Horizontal coordinate along the facade: project world XZ onto
            // the facade tangent (perpendicular of the horizontal normal).
            vec2 n = normalize(vWorldNormal.xz + vec2(1e-5));
            float along = dot(vWorldPos.xz, vec2(-n.y, n.x));
            vec2 cell = vec2(floor(along / 2.6), floor(vWorldPos.y / 3.1));
            vec2 f = vec2(fract(along / 2.6), fract(vWorldPos.y / 3.1));
            // Window pane occupies the middle of each cell.
            float inWindow = step(0.18, f.x) * step(f.x, 0.82) * step(0.25, f.y) * step(f.y, 0.85);
            float h = cellHash(cell + floor(vWorldPos.y * 0.001));
            if (uNight > 0.5) {
              // ~38% of windows lit, warm, brightness varied per cell.
              float lit = step(0.62, h) * inWindow;
              vec3 glow = vec3(1.0, 0.82, 0.55) * (0.55 + 0.45 * cellHash(cell.yx));
              gl_FragColor.rgb = mix(gl_FragColor.rgb, glow, lit * 0.85);
              gl_FragColor.rgb *= 1.0 - inWindow * (1.0 - lit) * 0.25; // unlit panes darker
            } else {
              // Daytime: glass reads slightly darker/cooler than the wall.
              gl_FragColor.rgb *= 1.0 - inWindow * (0.13 + 0.06 * h);
            }
          } else if (vertical <= 0.7) {
            gl_FragColor.rgb *= 1.04; // roofs catch a touch more sky
          }
        }
        #include <dithering_fragment>`,
      );
  };
  // Different shader per night flag — key the program cache accordingly.
  material.customProgramCacheKey = () => `facade-${opts.night ? "night" : "day"}`;
  return material;
}
