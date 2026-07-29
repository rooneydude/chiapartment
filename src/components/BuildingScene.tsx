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

export default function BuildingScene({
  spec,
  plate,
  units,
  selectedUnitCode,
  onSelect,
}: Props) {
  const height = buildingHeightM(spec);
  const span = plateSpan(plate.outline);
  // Frame the whole tower with a little headroom, from the south-east.
  const distance = Math.max(height * 1.15, span * 2.4);

  return (
    <Canvas
      shadows={false}
      dpr={[1, 2]}
      camera={{ position: [distance * 0.62, height * 0.72, distance * 0.72], fov: 38, far: 8000 }}
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
        minDistance={span * 0.6}
        maxDistance={distance * 3}
        maxPolarAngle={Math.PI * 0.495}
        target={[0, height * 0.45, 0]}
      />
    </Canvas>
  );
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

      {selected && <ViewCone placement={selected.placement} length={span * 3.2} />}
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
      // Selected units render slightly proud of the facade so they never z-fight.
      scale={selected ? 1.012 : 1.004}
    >
      <meshBasicMaterial
        color={selected ? "#ffb038" : "#ffd79a"}
        transparent
        opacity={emphasis}
        depthWrite={selected}
        toneMapped={false}
      />
    </mesh>
  );
}

/**
 * A wedge showing which way the selected unit's windows point. This is the
 * "position NSEW" answer made visual — the thing a floor number alone can't
 * tell you.
 */
function ViewCone({ placement, length }: { placement: UnitPlacement; length: number }) {
  const geometry = useMemo(() => {
    const spread = (34 * Math.PI) / 180;
    const heading = (placement.facingDeg * Math.PI) / 180;
    const origin = new THREE.Vector3(placement.center.x, 0, -placement.center.y);
    const positions: number[] = [];

    for (const side of [-1, 1]) {
      const a = heading + side * spread;
      // Bearing 0 = north = −Z; bearing 90 = east = +X.
      positions.push(
        origin.x,
        0,
        origin.z,
        origin.x + Math.sin(a) * length,
        0,
        origin.z - Math.cos(a) * length,
      );
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    return g;
  }, [placement, length]);

  return (
    <lineSegments geometry={geometry} position={[0, placement.slabHeightM + 1.4, 0]}>
      <lineBasicMaterial color="#ffb038" transparent opacity={0.5} />
    </lineSegments>
  );
}

function UnitCallout({ unit }: { unit: SceneUnit }) {
  const { placement } = unit;
  return (
    <Html
      position={[placement.center.x, placement.slabHeightM + 3, -placement.center.y]}
      center
      distanceFactor={90}
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
            distanceFactor={120}
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
