"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { BuildingSpec } from "@/lib/massing/spec";
import {
  buildingHeightM,
  floorSlabHeight,
  orderedSegments,
  segmentFloorCount,
  segmentForFloor,
} from "@/lib/massing/spec";
import type { FloorPlate, Point } from "@/lib/floorplan/schema";
import type { UnitPlacement } from "@/lib/units/placement";

/**
 * Low-poly massing viewer.
 *
 * The model exists to answer one question — where in this building is the unit
 * — so it is deliberately plain: extruded floor plates, a floor-line texture
 * for scale, every available unit shown as a faint slab, and the selected one
 * lit. No windows, no materials, nothing that would imply more precision than
 * the inferred geometry actually has.
 *
 * Coordinates: the app's local frame is x = east, y = north, z = up. Three.js
 * is y-up, so the mapping is x → +X, north → −Z, height → +Y.
 */

export interface SceneUnit {
  unitCode: string;
  placement: UnitPlacement;
  rent: number | null;
  bedrooms: number | null;
  status: string;
}

interface Props {
  spec: BuildingSpec;
  plate: FloorPlate;
  units: SceneUnit[];
  selectedUnitCode?: string | null;
  onSelect?: (unitCode: string) => void;
}

const FOV = 38;
/** Fraction of the viewport the building should occupy vertically. */
const FILL = 0.82;

/**
 * Distance at which a building of this height fits the frame.
 *
 * Deriving it from the field of view rather than guessing a multiple of the
 * height is what keeps a 12-storey bar block and a 60-storey tower both framed
 * correctly — a fixed multiplier gets one of them wrong every time.
 */
function framingDistance(height: number, span: number): number {
  const halfFov = (FOV * Math.PI) / 360;
  const fitHeight = height / FILL / (2 * Math.tan(halfFov));
  // Wide, short buildings are constrained by width instead.
  const fitWidth = span * 1.9;
  return Math.max(fitHeight, fitWidth);
}

export default function BuildingScene({
  spec,
  plate,
  units,
  selectedUnitCode,
  onSelect,
}: Props) {
  const height = buildingHeightM(spec);
  const span = plateSpan(plate.outline);
  const distance = framingDistance(height, span);
  const target: [number, number, number] = [0, height * 0.45, 0];

  // Look from the south-east and slightly above the midpoint, placed at
  // exactly `distance` from the target so the framing math actually holds.
  const dir = normalize([0.62, 0.32, 0.72]);
  const position: [number, number, number] = [
    target[0] + dir[0] * distance,
    target[1] + dir[1] * distance,
    target[2] + dir[2] * distance,
  ];

  return (
    <Canvas
      shadows={false}
      dpr={[1, 2]}
      camera={{ position, fov: FOV, near: 1, far: 20_000 }}
      gl={{ antialias: true }}
      style={{ background: "linear-gradient(180deg,#12161d 0%,#0b0d10 100%)" }}
    >
      <SceneContents
        spec={spec}
        plate={plate}
        units={units}
        selectedUnitCode={selectedUnitCode}
        onSelect={onSelect}
      />
      <OrbitControls
        makeDefault
        enablePan
        minDistance={span * 0.8}
        maxDistance={distance * 2.5}
        maxPolarAngle={Math.PI * 0.495}
        target={target}
      />
    </Canvas>
  );
}

function normalize([x, y, z]: [number, number, number]): [number, number, number] {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
}

function SceneContents({ spec, plate, units, selectedUnitCode, onSelect }: Props) {
  const height = buildingHeightM(spec);
  const span = plateSpan(plate.outline);
  const selected = units.find((u) => u.unitCode === selectedUnitCode);

  return (
    <>
      <ambientLight intensity={0.75} />
      <directionalLight position={[80, 160, 60]} intensity={1.15} />
      <directionalLight position={[-90, 60, -80]} intensity={0.35} color="#7fa8c8" />

      <Ground radius={span * 6} />
      <CompassRing radius={span * 1.35} />

      <Massing spec={spec} plate={plate} />
      <FloorLines spec={spec} plate={plate} />

      {units.map((u) => (
        <UnitSlab
          key={u.unitCode}
          unit={u}
          spec={spec}
          selected={u.unitCode === selectedUnitCode}
          onSelect={onSelect}
        />
      ))}

      {selected && (
        <SelectedFloorRing spec={spec} plate={plate} placement={selected.placement} />
      )}
      {selected && <ViewCone placement={selected.placement} length={span * 1.35} />}
      {selected && <UnitCallout unit={selected} />}

      <SkyGradient height={height} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Massing
// ---------------------------------------------------------------------------

/** Extruded shape from a ring of local-metre points. */
function shapeFromRing(ring: Point[], inset: number): THREE.Shape {
  const scaled = insetRing(ring, inset);
  const shape = new THREE.Shape();
  shape.moveTo(scaled[0].x, scaled[0].y);
  for (const p of scaled.slice(1)) shape.lineTo(p.x, p.y);
  shape.closePath();
  return shape;
}

function insetRing(ring: Point[], inset: number): Point[] {
  if (inset <= 0) return ring;
  const cx = ring.reduce((a, p) => a + p.x, 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p.y, 0) / ring.length;
  const halfSpan = Math.max(
    ...ring.map((p) => Math.max(Math.abs(p.x - cx), Math.abs(p.y - cy))),
  );
  const k = halfSpan > inset ? (halfSpan - inset) / halfSpan : 0.5;
  return ring.map((p) => ({ x: cx + (p.x - cx) * k, y: cy + (p.y - cy) * k }));
}

function Massing({ spec, plate }: { spec: BuildingSpec; plate: FloorPlate }) {
  const parts = useMemo(() => {
    const out: Array<{ geometry: THREE.ExtrudeGeometry; base: number; key: string }> = [];
    for (const seg of orderedSegments(spec)) {
      const floors = segmentFloorCount(spec, seg);
      if (floors <= 0) continue;
      const base = floorSlabHeight(spec, seg.fromFloor);
      const depth = floors * seg.floorHeight;
      const shape = shapeFromRing(plate.outline, seg.inset);
      out.push({
        geometry: new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }),
        base,
        key: `${seg.fromFloor}-${seg.toFloor}`,
      });
    }
    // Roof cap: a slightly inset parapet so the top edge reads as a roofline.
    const topBase = floorSlabHeight(spec, spec.topFloor + 1);
    const topSeg = orderedSegments(spec).at(-1)!;
    out.push({
      geometry: new THREE.ExtrudeGeometry(
        shapeFromRing(plate.outline, topSeg.inset + 0.6),
        { depth: spec.roofHeightM, bevelEnabled: false },
      ),
      base: topBase,
      key: "roof",
    });
    return out;
  }, [spec, plate]);

  return (
    <>
      {parts.map((part) => (
        <mesh
          key={part.key}
          geometry={part.geometry}
          position={[0, part.base, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
        >
          <meshLambertMaterial
            color={part.key === "roof" ? spec.palette.roof : spec.palette.facade}
            flatShading
          />
        </mesh>
      ))}
      {parts.map((part) => (
        <lineSegments key={`${part.key}-edges`} position={[0, part.base, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <edgesGeometry args={[part.geometry]} />
          <lineBasicMaterial color="#0b0d10" transparent opacity={0.55} />
        </lineSegments>
      ))}
    </>
  );
}

/**
 * A horizontal line at every floor slab. This is what makes the model legible
 * as a *building* — without it there is no sense of scale, and "floor 32"
 * means nothing visually.
 */
function FloorLines({ spec, plate }: { spec: BuildingSpec; plate: FloorPlate }) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    for (const seg of orderedSegments(spec)) {
      const ring = insetRing(plate.outline, seg.inset);
      for (let f = seg.fromFloor; f <= seg.toFloor; f++) {
        if (spec.skippedFloors.includes(f)) continue;
        const y = floorSlabHeight(spec, f);
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i];
          const b = ring[(i + 1) % ring.length];
          positions.push(a.x, y, -a.y, b.x, y, -b.y);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [spec, plate]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color="#0b0d10" transparent opacity={0.22} />
    </lineSegments>
  );
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function UnitSlab({
  unit,
  spec,
  selected,
  onSelect,
}: {
  unit: SceneUnit;
  spec: BuildingSpec;
  selected: boolean;
  onSelect?: (code: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { placement } = unit;

  const geometry = useMemo(() => {
    const shape = new THREE.Shape();
    const ring = placement.polygon;
    shape.moveTo(ring[0].x, ring[0].y);
    for (const p of ring.slice(1)) shape.lineTo(p.x, p.y);
    shape.closePath();
    // Slightly less than a full storey so consecutive floors stay distinct.
    return new THREE.ExtrudeGeometry(shape, { depth: 2.6, bevelEnabled: false });
  }, [placement]);

  const emphasis = selected ? 1 : hovered ? 0.55 : 0.16;

  return (
    <mesh
      geometry={geometry}
      position={[0, placement.slabHeightM + 0.15, 0]}
      rotation={[-Math.PI / 2, 0, 0]}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = "";
      }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(unit.unitCode);
      }}
      // Selected units sit clearly proud of the facade: at typical framing
      // distances a fractional offset is sub-pixel and the highlight vanishes
      // into the wall.
      scale={selected ? 1.035 : 1.004}
    >
      <meshBasicMaterial
        color={selected ? "#ffb038" : "#ffd79a"}
        transparent={!selected}
        opacity={emphasis}
        depthWrite
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * A bright band around the whole floor plate at the selected unit's level.
 *
 * The unit slab alone is easy to lose against a 38-storey facade, especially
 * once the camera is far enough back to frame the building. The ring reads at
 * any distance and answers "which floor" before you've found the unit itself.
 */
function SelectedFloorRing({
  spec,
  plate,
  placement,
}: {
  spec: BuildingSpec;
  plate: FloorPlate;
  placement: UnitPlacement;
}) {
  const geometry = useMemo(() => {
    const seg = segmentForFloor(spec, placement.floor);
    const ring = insetRing(plate.outline, seg.inset);
    const positions: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      positions.push(a.x, 0, -a.y, b.x, 0, -b.y);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [spec, plate, placement.floor]);

  return (
    <group position={[0, placement.slabHeightM + 1.3, 0]}>
      <lineSegments geometry={geometry}>
        <lineBasicMaterial color="#ffb038" transparent opacity={0.85} toneMapped={false} />
      </lineSegments>
    </group>
  );
}

/**
 * A wedge showing which way the selected unit's windows point. This is the
 * "position NSEW" answer made visual — the thing a floor number alone can't
 * tell you.
 */
function ViewCone({ placement, length }: { placement: UnitPlacement; length: number }) {
  const geometry = useMemo(() => {
    const spread = (30 * Math.PI) / 180;
    const heading = (placement.facingDeg * Math.PI) / 180;
    const ox = placement.center.x;
    const oz = -placement.center.y;

    // A filled fan rather than two loose rays: as lines it reads as stray
    // geometry crossing the scene, as a wedge it reads as a direction.
    const steps = 12;
    const positions: number[] = [];
    for (let i = 0; i < steps; i++) {
      const a0 = heading - spread + (2 * spread * i) / steps;
      const a1 = heading - spread + (2 * spread * (i + 1)) / steps;
      // Bearing 0 = north = −Z; bearing 90 = east = +X.
      positions.push(
        ox, 0, oz,
        ox + Math.sin(a0) * length, 0, oz - Math.cos(a0) * length,
        ox + Math.sin(a1) * length, 0, oz - Math.cos(a1) * length,
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    return g;
  }, [placement, length]);

  return (
    <mesh geometry={geometry} position={[0, placement.slabHeightM + 1.4, 0]}>
      <meshBasicMaterial
        color="#ffb038"
        transparent
        opacity={0.14}
        side={THREE.DoubleSide}
        depthWrite={false}
        toneMapped={false}
      />
    </mesh>
  );
}

/** Height of the callout above the unit, metres. */
const CALLOUT_LIFT_M = 26;

function UnitCallout({ unit }: { unit: SceneUnit }) {
  const { placement } = unit;

  // A leader line, so lifting the label clear of the unit doesn't disconnect
  // the two. Without the lift the label covers the very slab it describes.
  const leader = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [
          placement.center.x, placement.slabHeightM + 1.5, -placement.center.y,
          placement.center.x, placement.slabHeightM + CALLOUT_LIFT_M, -placement.center.y,
        ],
        3,
      ),
    );
    return g;
  }, [placement]);

  return (
    <>
      <lineSegments geometry={leader}>
        <lineBasicMaterial color="#ffb038" transparent opacity={0.55} toneMapped={false} />
      </lineSegments>
      <Html
        position={[
          placement.center.x,
          placement.slabHeightM + CALLOUT_LIFT_M,
          -placement.center.y,
        ]}
        center
        zIndexRange={[10, 0]}
      >
        <div className="pointer-events-none whitespace-nowrap rounded-md border border-accent/40 bg-ink-950/90 px-2.5 py-1.5 text-[11px] leading-tight text-ink-100 shadow-lg">
          <div className="font-semibold tracking-tight">Unit {unit.unitCode}</div>
          <div className="tnum text-ink-400">
            Floor {placement.floor} · {placement.exposureLabel} ·{" "}
            {placement.areaSqft.toLocaleString()} sqft
          </div>
        </div>
      </Html>
    </>
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function Ground({ radius }: { radius: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.05, 0]}>
      <circleGeometry args={[radius, 64]} />
      <meshBasicMaterial color="#0e1116" />
    </mesh>
  );
}

/** Cardinal labels on the ground so the model's orientation is unambiguous. */
function CompassRing({ radius }: { radius: number }) {
  const marks: Array<[string, number]> = [
    ["N", 0],
    ["E", 90],
    ["S", 180],
    ["W", 270],
  ];
  return (
    <group>
      {marks.map(([label, deg]) => {
        const rad = (deg * Math.PI) / 180;
        return (
          <Html
            key={label}
            position={[Math.sin(rad) * radius, 0.4, -Math.cos(rad) * radius]}
            center
          >
            <div className="pointer-events-none select-none text-[13px] font-semibold tracking-widest text-ink-500">
              {label}
            </div>
          </Html>
        );
      })}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
        <ringGeometry args={[radius * 0.985, radius, 96]} />
        <meshBasicMaterial color="#262d38" />
      </mesh>
    </group>
  );
}

/** A subtle vertical fade so tall towers don't float against a flat backdrop. */
function SkyGradient({ height }: { height: number }) {
  const ref = useRef<THREE.Mesh>(null);
  const { camera } = useThree();
  useFrame(() => {
    // Keep the backdrop behind the building from every orbit angle.
    if (!ref.current) return;
    const dir = new THREE.Vector3(camera.position.x, 0, camera.position.z).normalize();
    ref.current.position.set(-dir.x * height * 4, height * 0.5, -dir.z * height * 4);
    ref.current.lookAt(camera.position.x, height * 0.5, camera.position.z);
  });

  return (
    <mesh ref={ref}>
      <planeGeometry args={[height * 8, height * 4]} />
      <meshBasicMaterial color="#141922" depthWrite={false} />
    </mesh>
  );
}

function plateSpan(ring: Point[]): number {
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}
