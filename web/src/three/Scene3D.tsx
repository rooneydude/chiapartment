import { OrbitControls, Sky } from "@react-three/drei";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useLocation } from "react-router-dom";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { makeProjector } from "../../../shared/src/geo";
import { parseUnitNumber, stackFromPlan } from "../../../shared/src/parse";
import {
  facadeParam,
  makeBoxRing,
  normalizeRing,
  orientedBoxRing,
  placeStackBand,
  placeUnit,
  ringCentroid,
  type UnitPlacement,
  type Vec2,
} from "../../../shared/src/placement";
import { isBuildingFeature } from "../../../shared/src/types";
import type {
  BuildingConfig,
  BuildingHistory,
  Facing,
  SkylineCollection,
  UnitMapSidecar,
} from "../../../shared/src/types";
import { sunPosition } from "../../../shared/src/sun";
import CompassHud from "../components/CompassHud";
import TuneOverlay, { type TuneClick } from "../components/TuneOverlay";
import { loadSkyline, loadUnitMap } from "../lib/data";
import { useStore } from "../state/store";
import {
  buildAreaGeometry,
  buildContextGeometry,
  buildLineGeometry,
  buildRoadRibbonGeometry,
  DARK_THEME,
  extrudeRing,
  LIGHT_THEME,
  planToThree,
  type SceneTheme,
} from "./geometry";
import Landmarks from "./Landmarks";

/** Writes camera azimuth into the compass disc's transform — no React state. */
function AzimuthBridge({ discRef }: { discRef: MutableRefObject<HTMLDivElement | null> }) {
  const dir = useRef(new THREE.Vector3());
  useFrame(({ camera }) => {
    camera.getWorldDirection(dir.current);
    const az = (Math.atan2(dir.current.x, -dir.current.z) * 180) / Math.PI;
    if (discRef.current) discRef.current.style.transform = `rotate(${-az}deg)`;
  });
  return null;
}

function useTheme(): SceneTheme {
  const [dark, setDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const fn = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** Everything the scene needs, derived once per building/skyline. */
interface SceneModel {
  ring: Vec2[]; // building footprint, plan meters
  center: Vec2;
  buildingHeight: number;
  contextGeometry: THREE.BufferGeometry | null;
  roadGeometry: THREE.BufferGeometry | null;
  roadRibbonGeometry: THREE.BufferGeometry | null;
  railGeometry: THREE.BufferGeometry | null;
  waterGeometry: THREE.BufferGeometry | null;
  parkGeometry: THREE.BufferGeometry | null;
  trackedGeometry: THREE.BufferGeometry;
  skyline: SkylineCollection | null;
  trackedOsmIds: Set<number>;
  fromOsm: boolean;
}

function configuredHeight(b: BuildingConfig): number {
  return b.geometry.groundFloorOffsetM + b.geometry.floors * b.geometry.floorHeightM;
}

function findFeature(building: BuildingConfig, skyline: SkylineCollection) {
  return skyline.features.filter(isBuildingFeature).find(
    (f) =>
      (building.geometry.osmWayId !== undefined &&
        f.properties.osmId === building.geometry.osmWayId) ||
      f.properties.trackedId === building.id,
  );
}

function buildModel(
  building: BuildingConfig,
  allBuildings: BuildingConfig[],
  skyline: SkylineCollection | null,
  contextColor: string,
): SceneModel {
  const g = building.geometry;
  const buildingHeight = configuredHeight(building);

  let ring: Vec2[] | null = null;
  let contextGeometry: THREE.BufferGeometry | null = null;
  let roadGeometry: THREE.BufferGeometry | null = null;
  let roadRibbonGeometry: THREE.BufferGeometry | null = null;
  let railGeometry: THREE.BufferGeometry | null = null;
  let waterGeometry: THREE.BufferGeometry | null = null;
  let parkGeometry: THREE.BufferGeometry | null = null;
  const trackedOsmIds = new Set<number>();
  let fromOsm = false;

  if (skyline) {
    const feature = findFeature(building, skyline);
    if (feature?.geometry.coordinates[0]) {
      ring = normalizeRing(feature.geometry.coordinates[0] as Vec2[]);
      fromOsm = true;
    }
    // Other tracked towers keep their configured heights in the context —
    // OSM's data for new towers is often stale (podium-only levels).
    const exclude = new Set<number>();
    const overrides = new Map<number, number>();
    for (const b of allBuildings) {
      const f = findFeature(b, skyline);
      if (!f) continue;
      trackedOsmIds.add(f.properties.osmId);
      if (b.id === building.id) exclude.add(f.properties.osmId);
      else overrides.set(f.properties.osmId, configuredHeight(b));
    }
    contextGeometry = buildContextGeometry(skyline, exclude, overrides, contextColor);
    roadGeometry = buildLineGeometry(skyline, "road");
    roadRibbonGeometry = buildRoadRibbonGeometry(skyline);
    railGeometry = buildLineGeometry(skyline, "rail");
    waterGeometry = buildAreaGeometry(skyline, "water");
    parkGeometry = buildAreaGeometry(skyline, "park");
    if (!ring) {
      const projector = makeProjector(skyline.meta.origin);
      const [x, y] = projector.toLocal(building.lon, building.lat);
      ring = makeBoxRing(x, y, g.fallbackWidthM, g.fallbackDepthM);
    }
  } else {
    ring = makeBoxRing(0, 0, g.fallbackWidthM, g.fallbackDepthM);
  }

  // Extrude the tracked building to its CONFIGURED height (floors-derived),
  // which the floor math uses — OSM height may disagree.
  const trackedGeometry = extrudeRing(ring, 0, buildingHeight);

  return {
    ring,
    center: ringCentroid(ring),
    buildingHeight,
    contextGeometry,
    roadGeometry,
    roadRibbonGeometry,
    railGeometry,
    waterGeometry,
    parkGeometry,
    trackedGeometry,
    skyline,
    trackedOsmIds,
    fromOsm,
  };
}

/** Sun direction in three-space from real solar position (clamped to dusk). */
function sunVector(building: BuildingConfig): [number, number, number] {
  const { azimuthDeg, altitudeDeg } = sunPosition(new Date(), building.lat, building.lon);
  const alt = Math.max(altitudeDeg, 12) * (Math.PI / 180); // never fully horizontal
  const az = azimuthDeg * (Math.PI / 180);
  const east = Math.sin(az) * Math.cos(alt);
  const north = Math.cos(az) * Math.cos(alt);
  const up = Math.sin(alt);
  return planToThree(east * 900, north * 900, up * 900);
}

/** Animates the camera between orbit mode and the unit's window viewpoint. */
function CameraRig({
  placement,
  center,
  buildingHeight,
}: {
  placement: UnitPlacement | null;
  center: Vec2;
  buildingHeight: number;
}) {
  const cameraMode = useStore((s) => s.cameraMode);
  const controls = useRef<OrbitControlsImpl>(null);
  const goal = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; t: number } | null>(null);

  const homePos = useMemo(() => {
    // Short buildings still need enough distance and altitude to clear
    // taller neighbors.
    const d = Math.max(buildingHeight, 110);
    return new THREE.Vector3(
      ...planToThree(center[0] + d * 1.5, center[1] - d * 1.7, d * 1.35),
    );
  }, [center, buildingHeight]);
  const homeTarget = useMemo(
    () => new THREE.Vector3(...planToThree(center[0], center[1], buildingHeight * 0.45)),
    [center, buildingHeight],
  );

  // Recompute the animation goal when mode or placement changes.
  useEffect(() => {
    if (cameraMode === "unit-view" && placement?.viewCamera) {
      const { position, dir } = placement.viewCamera;
      goal.current = {
        pos: new THREE.Vector3(...planToThree(...position)),
        target: new THREE.Vector3(
          ...planToThree(
            position[0] + dir[0] * 400,
            position[1] + dir[1] * 400,
            position[2] + dir[2] * 400,
          ),
        ),
        t: 0,
      };
    } else {
      goal.current = { pos: homePos.clone(), target: homeTarget.clone(), t: 0 };
    }
  }, [cameraMode, placement, homePos, homeTarget]);

  useFrame(({ camera }, delta) => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    g.t = Math.min(g.t + delta * 1.8, 1);
    const k = 1 - Math.pow(1 - g.t, 3); // ease-out cubic
    camera.position.lerp(g.pos, k);
    c.target.lerp(g.target, k);
    c.update();
    if (g.t >= 1) goal.current = null; // hand control back to the user
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      maxPolarAngle={Math.PI / 2 - 0.02}
      minDistance={5}
      maxDistance={2600}
    />
  );
}

function SceneContent({
  building,
  model,
  theme,
  exactFor,
  onTuneClick,
}: {
  building: BuildingConfig;
  model: SceneModel;
  theme: SceneTheme;
  exactFor: (unit: string | null) => { x: number; y: number } | undefined;
  onTuneClick?: (c: TuneClick) => void;
}) {
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const setFloorRange = useStore((s) => s.setFloorRange);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);
  const g = building.geometry;

  const placement = useMemo(
    () =>
      selectedUnit
        ? placeUnit(selectedUnit, building.unitMapping, g, model.ring, exactFor(selectedUnit))
        : null,
    [selectedUnit, building, g, model.ring, exactFor],
  );

  // Full-height band when a floorplan-as-stack is selected (Stead 220).
  const bandGeometry = useMemo(() => {
    if (!selectedPlan || !building.unitMapping) return null;
    const stack = stackFromPlan(selectedPlan, building.unitMapping);
    if (!stack) return null;
    const band = placeStackBand(stack, building.unitMapping, g, model.ring);
    if (!band) return null;
    return extrudeRing(orientedBoxRing(band.point, band.normal, 9, 5), band.zMin, band.zMax);
  }, [selectedPlan, building, g, model.ring]);

  // Clicking the tower: tune mode emits a stacks-config snippet; otherwise
  // filter the table to the clicked floor.
  const onBuildingClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const z = e.point.y; // three y == height
    const floor = Math.floor((z - g.groundFloorOffsetM) / g.floorHeightM) + 1;
    if (onTuneClick) {
      const fp = facadeParam(model.ring, [e.point.x, -e.point.z]);
      if (fp) {
        onTuneClick({
          facing: fp.facing,
          u: fp.u,
          floor: floor >= 1 && floor <= g.floors ? floor : null,
        });
      }
      return;
    }
    if (floor >= 1 && floor <= g.floors) {
      if (floorMin === floor && floorMax === floor) setFloorRange(null, null);
      else setFloorRange(floor, floor);
    }
  };

  const slabGeometry = useMemo(() => {
    if (!placement?.floorSlab) return null;
    return extrudeRing(
      model.ring.map(([x, y]): Vec2 => {
        // Slightly outset so the slab reads through the tower walls.
        const [cx, cy] = model.center;
        const dx = x - cx;
        const dy = y - cy;
        const len = Math.hypot(dx, dy) || 1;
        return [x + (dx / len) * 0.6, y + (dy / len) * 0.6];
      }),
      placement.floorSlab.zMin,
      placement.floorSlab.zMax,
    );
  }, [placement, model]);

  const filterSlabGeometry = useMemo(() => {
    if (floorMin === null && floorMax === null) return null;
    if (placement) return null; // selected-unit slab wins
    const lo = floorMin ?? 1;
    const hi = floorMax ?? g.floors;
    return extrudeRing(
      model.ring,
      g.groundFloorOffsetM + (lo - 1) * g.floorHeightM,
      g.groundFloorOffsetM + hi * g.floorHeightM,
    );
  }, [floorMin, floorMax, placement, model, g]);

  const sunPos = useMemo(() => sunVector(building), [building]);
  const outlineGeometry = useMemo(
    () => new THREE.EdgesGeometry(model.trackedGeometry, 25),
    [model.trackedGeometry],
  );

  return (
    <>
      <fog attach="fog" args={[theme.fog, 700, 3600]} />
      {theme.sky && (
        <Sky sunPosition={sunPos} turbidity={6} rayleigh={1.2} distance={45000} />
      )}
      <ambientLight intensity={theme.sky ? 0.75 : 0.9} />
      <directionalLight position={sunPos} intensity={theme.sky ? 1.6 : 1.1} color="#fff4e0" />
      <directionalLight position={[-300, 200, -400]} intensity={0.3} />

      {/* ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]}>
        <circleGeometry args={[3800, 48]} />
        <meshLambertMaterial color={theme.ground} />
      </mesh>

      {/* water + parks */}
      {model.waterGeometry && (
        <mesh geometry={model.waterGeometry}>
          <meshLambertMaterial color={theme.water} />
        </mesh>
      )}
      {model.parkGeometry && (
        <mesh geometry={model.parkGeometry}>
          <meshLambertMaterial color={theme.park} />
        </mesh>
      )}

      {/* merged skyline context (per-building vertex colors) */}
      {model.contextGeometry && (
        <mesh geometry={model.contextGeometry}>
          <meshLambertMaterial vertexColors flatShading />
        </mesh>
      )}

      {/* streets + rail */}
      {model.roadRibbonGeometry && (
        <mesh geometry={model.roadRibbonGeometry}>
          <meshBasicMaterial color={theme.roadRibbon} />
        </mesh>
      )}
      {model.roadGeometry && (
        <lineSegments geometry={model.roadGeometry}>
          <lineBasicMaterial color={theme.road} />
        </lineSegments>
      )}
      {model.railGeometry && (
        <lineSegments geometry={model.railGeometry}>
          <lineBasicMaterial color={theme.rail} />
        </lineSegments>
      )}

      {/* station markers + landmark labels */}
      {model.skyline && (
        <Landmarks
          skyline={model.skyline}
          center={model.center}
          theme={theme}
          excludeOsmIds={model.trackedOsmIds}
        />
      )}

      {/* the tracked building */}
      <mesh geometry={model.trackedGeometry} onClick={onBuildingClick}>
        <meshLambertMaterial color={theme.accent} transparent opacity={0.55} flatShading />
      </mesh>
      <lineSegments geometry={outlineGeometry}>
        <lineBasicMaterial color={theme.outline} transparent opacity={0.5} />
      </lineSegments>

      {/* selected unit floor slab */}
      {slabGeometry && (
        <mesh geometry={slabGeometry}>
          <meshBasicMaterial color={theme.slab} transparent opacity={0.85} depthWrite={false} />
        </mesh>
      )}

      {/* floor-filter band */}
      {filterSlabGeometry && (
        <mesh geometry={filterSlabGeometry}>
          <meshBasicMaterial color={theme.slab} transparent opacity={0.28} depthWrite={false} />
        </mesh>
      )}

      {/* floorplan-as-stack band (ground to roof) */}
      {bandGeometry && (
        <mesh geometry={bandGeometry}>
          <meshBasicMaterial color={theme.slab} transparent opacity={0.4} depthWrite={false} />
        </mesh>
      )}

      {/* unit marker beacon */}
      {placement?.marker && (
        <group position={planToThree(...placement.marker)}>
          <mesh>
            <sphereGeometry args={[2.4, 20, 20]} />
            <meshBasicMaterial color={theme.marker} />
          </mesh>
          <mesh>
            <sphereGeometry args={[4.2, 20, 20]} />
            <meshBasicMaterial color={theme.marker} transparent opacity={0.25} />
          </mesh>
        </group>
      )}

      <CameraRig
        placement={placement}
        center={model.center}
        buildingHeight={model.buildingHeight}
      />
    </>
  );
}

export default function Scene3D({
  building,
  allBuildings,
}: {
  building: BuildingConfig;
  allBuildings: BuildingConfig[];
  history: BuildingHistory;
}) {
  const [skyline, setSkyline] = useState<SkylineCollection | null | undefined>(undefined);
  const [unitMap, setUnitMap] = useState<UnitMapSidecar | null>(null);
  const [tuneClick, setTuneClick] = useState<TuneClick | null>(null);
  const discRef = useRef<HTMLDivElement | null>(null);
  const theme = useTheme();
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  // HashRouter reconciles this component across /b/:id routes — the query
  // must come from the router so ?tune=1 applies without a full reload.
  const tuneMode = new URLSearchParams(useLocation().search).has("tune");

  useEffect(() => {
    void loadSkyline().then(setSkyline);
  }, []);
  useEffect(() => {
    setUnitMap(null);
    void loadUnitMap(building.id).then(setUnitMap);
  }, [building.id]);

  const model = useMemo(
    () =>
      skyline === undefined ? null : buildModel(building, allBuildings, skyline, theme.context),
    [building, allBuildings, skyline, theme.context],
  );

  // Exact sidecar position (projected into scene-local meters) for a unit.
  const exactFor = useMemo(() => {
    if (!unitMap || !skyline) return () => undefined;
    const projector = makeProjector(skyline.meta.origin);
    return (unit: string | null): { x: number; y: number } | undefined => {
      const entry = unit ? unitMap.units[unit] : undefined;
      if (!entry) return undefined;
      const [x, y] = projector.toLocal(entry.lon, entry.lat);
      return { x, y };
    };
  }, [unitMap, skyline]);

  const placement = useMemo(
    () =>
      model && selectedUnit
        ? placeUnit(
            selectedUnit,
            building.unitMapping,
            building.geometry,
            model.ring,
            exactFor(selectedUnit),
          )
        : null,
    [model, selectedUnit, building, exactFor],
  );

  useEffect(() => {
    // Leaving unit-view when the selection loses its viewpoint.
    if (cameraMode === "unit-view" && !placement?.viewCamera) setCameraMode("orbit");
  }, [cameraMode, placement, setCameraMode]);

  // Which way does the selection face? Sidecar beats stack map; never guess.
  const mapping = building.unitMapping;
  const facing: Facing | null = useMemo(() => {
    if (selectedUnit) {
      const sidecarFacing = unitMap?.units[selectedUnit]?.facing;
      if (sidecarFacing) return sidecarFacing;
      const { stack } = parseUnitNumber(selectedUnit, mapping ?? { scheme: "floor-prefix", stackDigits: 2, floorOffset: 0, stacks: {} });
      return (stack && mapping?.stacks[stack]?.facing) || null;
    }
    if (selectedPlan && mapping) {
      const stack = stackFromPlan(selectedPlan, mapping);
      return (stack && mapping.stacks[stack]?.facing) || null;
    }
    return null;
  }, [selectedUnit, selectedPlan, unitMap, mapping]);

  const selectedStack: string | null = useMemo(() => {
    if (selectedUnit && mapping) return parseUnitNumber(selectedUnit, mapping).stack;
    if (selectedPlan && mapping) return stackFromPlan(selectedPlan, mapping);
    return null;
  }, [selectedUnit, selectedPlan, mapping]);

  if (!model) {
    return (
      <div className="scene-wrap">
        <div className="scene-empty">Loading 3D scene…</div>
      </div>
    );
  }

  const note = !selectedUnit
    ? selectedPlan
      ? `plan "${selectedPlan}" — stack band, all floors`
      : "click a unit, or click the tower to filter a floor"
    : placement?.confidence === "exact"
      ? `unit ${selectedUnit} — exact position (floorplate)`
      : placement?.confidence === "stack"
        ? `unit ${selectedUnit} — approximate position`
        : placement?.confidence === "floor-only"
          ? `unit ${selectedUnit} — floor shown; exact position unknown`
          : `unit ${selectedUnit} — can't infer floor from unit number`;

  return (
    <div className="scene-wrap">
      <Canvas
        dpr={[1, 2]}
        camera={{ fov: 45, near: 1, far: 8000 }}
        style={{ background: theme.background }}
      >
        <SceneContent
          building={building}
          model={model}
          theme={theme}
          exactFor={exactFor}
          {...(tuneMode ? { onTuneClick: setTuneClick } : {})}
        />
        <AzimuthBridge discRef={discRef} />
      </Canvas>
      <CompassHud building={building} facing={facing} discRef={discRef} />
      {tuneMode && (
        <TuneOverlay mapping={mapping} lastClick={tuneClick} selectedStack={selectedStack} />
      )}
      <div className="scene-overlay">
        {placement?.viewCamera && (
          <button
            className={`scene-btn${cameraMode === "unit-view" ? " on" : ""}`}
            onClick={() => setCameraMode(cameraMode === "unit-view" ? "orbit" : "unit-view")}
          >
            {cameraMode === "unit-view" ? "✕ exit unit view" : "👁 view from unit"}
          </button>
        )}
        {cameraMode === "unit-view" && (
          <span className="scene-note" style={{ position: "static" }}>
            approximate view — massing only
          </span>
        )}
      </div>
      <div className="scene-note">{note}</div>
    </div>
  );
}
