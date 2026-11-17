import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Vec2 } from "../../../shared/src/placement";
import { planToThree, type SceneTheme } from "./geometry";

export interface StreetName {
  name: string;
  /** Where the name goes: a point on the street's centre-line, in plan metres. */
  pos: Vec2;
  /** Unit vector along the street there, in plan coordinates. */
  dir: Vec2;
}

/** Height of the lettering on the ground, in metres (a street is about 20 m wide). */
const TEXT_HEIGHT_M = 8;
/** Texture pixels for that height: sharp close up, eight small textures in all. */
const PX = 96;

/** One street name drawn into a texture with the system font: no font file to download. */
function nameTexture(
  text: string,
  color: string,
  halo: string,
  anisotropy: number,
): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement("canvas");
  const font = `600 ${Math.round(PX * 0.6)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const measure = canvas.getContext("2d")!;
  measure.font = font;
  const width = Math.ceil(measure.measureText(text).width + PX * 0.6);
  canvas.width = width;
  canvas.height = PX;
  const ctx = canvas.getContext("2d")!; // resizing a canvas resets its drawing state
  ctx.font = font;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // a halo in the ground-label colour, so the name reads on asphalt and on grass
  ctx.lineJoin = "round";
  ctx.lineWidth = PX * 0.16;
  ctx.strokeStyle = halo;
  ctx.strokeText(text, width / 2, PX / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, PX / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // seen at a shallow angle from across the scene: without this it smears
  texture.anisotropy = anisotropy;
  return { texture, aspect: width / PX };
}

/**
 * Street names painted on the ground, the way a map prints them along the
 * street. Being part of the scene they are hidden by whatever stands in front
 * of them — a label floating in front of the canvas printed straight across
 * the tower and its unit marks.
 */
export default function StreetNames({
  streets,
  theme,
}: {
  streets: readonly StreetName[];
  theme: SceneTheme;
}) {
  const gl = useThree((s) => s.gl);
  const labels = useMemo(() => {
    const anisotropy = gl.capabilities.getMaxAnisotropy();
    return streets.map((st) => ({
      ...st,
      angle: Math.atan2(st.dir[1], st.dir[0]),
      ...nameTexture(st.name.toUpperCase(), theme.label, theme.labelBg, anisotropy),
    }));
  }, [streets, theme.label, theme.labelBg, gl]);
  useEffect(
    () => () => {
      for (const l of labels) l.texture.dispose();
    },
    [labels],
  );

  // Lettering on the ground reads the right way up from one side only: each
  // name is turned to face whoever is looking, whichever side they orbit to.
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(({ camera }) => {
    labels.forEach((l, i) => {
      const mesh = meshes.current[i];
      if (!mesh) return;
      // the top of the letters, and the way from the viewer to the name, in plan coordinates
      const upX = -Math.sin(l.angle);
      const upY = Math.cos(l.angle);
      const awayX = l.pos[0] - camera.position.x;
      const awayY = l.pos[1] + camera.position.z; // plan y is -z in the scene
      const turned = upX * awayX + upY * awayY < 0 ? l.angle + Math.PI : l.angle;
      if (mesh.rotation.z !== turned) mesh.rotation.z = turned;
    });
  });

  return (
    <>
      {labels.map((l, i) => (
        <mesh
          key={`street-${l.name}`}
          ref={(m) => {
            meshes.current[i] = m;
          }}
          position={planToThree(l.pos[0], l.pos[1], 0.7)}
          rotation={[-Math.PI / 2, 0, l.angle]}
          renderOrder={1}
        >
          <planeGeometry args={[TEXT_HEIGHT_M * l.aspect, TEXT_HEIGHT_M]} />
          <meshBasicMaterial
            map={l.texture}
            transparent
            depthWrite={false}
            toneMapped={false}
            polygonOffset
            polygonOffsetFactor={-4}
            polygonOffsetUnits={-4}
          />
        </mesh>
      ))}
    </>
  );
}
