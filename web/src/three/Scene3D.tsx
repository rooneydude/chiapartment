import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useLocation } from "react-router-dom";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { makeProjector } from "../../../shared/src/geo";
import { parseUnitNumber, stackFromPlan } from "../../../shared/src/parse";
import {
  facadeParam,
  orientedBoxRing,
  placeStackBand,
  placeUnit,
  type UnitPlacement,
  type Vec2,
} from "../../../shared/src/placement";
import { sunPosition, wallClockInstant } from "../../../shared/src/sun";
import { CHICAGO_TZ, chicagoDate } from "../../../shared/src/time";
import type {
  BuildingConfig,
  BuildingHistory,
  Facing,
  SkylineCollection,
  UnitListing,
  UnitMapSidecar,
} from "../../../shared/src/types";
import { isDarkActive } from "../lib/theme";
import CompassHud from "../components/CompassHud";
import TuneOverlay, { type TuneClick } from "../components/TuneOverlay";
import { loadSkyline, loadUnitMap } from "../lib/data";
import { useStore } from "../state/store";
import { atmosphereAt, type Atmosphere } from "./atmosphere";
import { createCity, FOG_FAR, FOG_NEAR, type City } from "./city";
import {
  buildRailGeometry,
  DARK_THEME,
  extrudeRing,
  LIGHT_THEME,
  planToThree,
  type SceneTheme,
} from "./geometry";
import Landmarks from "./Landmarks";
import MarksLegend from "./MarksLegend";
import { resolveSite, type Site } from "./site";
import UnitMarks from "./UnitMarks";
import { buildLegend, buildMarkStates, type MarkState } from "./unitMarks";
import { useDisposable } from "./useDisposable";

const CAMERA_FOV_DEG = 45;
const CAMERA = { fov: CAMERA_FOV_DEG, near: 1, far: 9000 };
const RENDERER = { toneMapping: THREE.NeutralToneMapping };
// Nothing that casts a shadow moves, so the shadow map is rendered once per
// sun position or city (see SceneContent) instead of once per frame.
const SHADOWS = { enabled: true, type: THREE.PCFSoftShadowMap, autoUpdate: false };

/**
 * `?t=` in the URL: the hour of the day (Chicago wall clock, 0–24, fractions
 * allowed) to light the scene for. Null = absent or not a time of day.
 */
function parseHourOfDay(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 && hours <= 24 ? hours : null;
}

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
  const [dark, setDark] = useState(isDarkActive);
  useEffect(() => {
    const update = () => setDark(isDarkActive());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", update);
    window.addEventListener("themechange", update);
    return () => {
      mq.removeEventListener("change", update);
      window.removeEventListener("themechange", update);
    };
  }, []);
  return dark ? DARK_THEME : LIGHT_THEME;
}

/** Animates the camera between orbit mode and the unit's window viewpoint. */
function CameraRig({
  placement,
  city,
  sunAzDeg,
  night,
}: {
  placement: UnitPlacement | null;
  city: City;
  sunAzDeg: number;
  night: number;
}) {
  const cameraMode = useStore((s) => s.cameraMode);
  const controls = useRef<OrbitControlsImpl>(null);
  const goal = useRef<{
    pos: THREE.Vector3;
    target: THREE.Vector3;
    t: number;
    started: boolean;
  } | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const aspect = useThree((s) => s.size.width / Math.max(s.size.height, 1));

  // Home view: the whole tower framed for THIS panel's shape, from its
  // least-occluded side. Recomputed when the panel's shape changes by a
  // noticeable step — and deliberately not when the time of day does: the
  // sun only tips the choice of side, and a change of lighting must not send
  // the camera flying.
  const aspectStep = Math.round(aspect * 20);
  const home = useMemo(
    () => city.homeView({ aspect, fovDeg: CAMERA_FOV_DEG, sunAzDeg, night }),
    [city, aspectStep],
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
        started: false,
      };
    } else {
      goal.current = {
        pos: home.position.clone(),
        target: home.target.clone(),
        t: 0,
        started: false,
      };
    }
    invalidate(); // frames are rendered on demand: ask for the first one
  }, [cameraMode, placement, home, invalidate]);

  useFrame(({ camera }, delta) => {
    const g = goal.current;
    const c = controls.current;
    if (!g || !c) return;
    // The first frame after a pause reports the whole pause as its delta,
    // which would finish the move in one jump: the move's clock starts here.
    if (g.started) g.t = Math.min(g.t + delta * 1.8, 1);
    g.started = true;
    const k = 1 - Math.pow(1 - g.t, 3); // ease-out cubic
    camera.position.lerp(g.pos, k);
    c.target.lerp(g.target, k);
    c.update();
    if (g.t >= 1) goal.current = null; // hand control back to the user
    else invalidate(); // keep the frames coming until the move is done
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
  site,
  skyline,
  theme,
  atmosphere,
  placement,
  marks,
  labelLayer,
  onTuneClick,
}: {
  site: Site;
  skyline: SkylineCollection | null;
  theme: SceneTheme;
  atmosphere: Atmosphere;
  placement: UnitPlacement | null;
  /** Every listed unit, as a mark on the tower. */
  marks: readonly MarkState[];
  /** Where the label of the hovered mark is put (see UnitMarks). */
  labelLayer: MutableRefObject<HTMLElement | null>;
  onTuneClick?: (c: TuneClick) => void;
}) {
  const selectedPlan = useStore((s) => s.selectedPlan);
  const setFloorRange = useStore((s) => s.setFloorRange);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);
  const gl = useThree((s) => s.gl);
  const invalidate = useThree((s) => s.invalidate);
  const { building, ring, center } = site;
  const g = building.geometry;

  // The static city. It is disposed from an effect of THIS component, inside
  // the canvas: by the time that cleanup runs, r3f has taken the old city out
  // of the scene, so no later frame can draw (and thereby re-upload) it.
  const city = useMemo(() => createCity(site, skyline), [site, skyline]);
  useEffect(() => () => city.dispose(), [city]);

  // The atmosphere drives every light, sky uniform, the fog and the exposure.
  // A layout effect, so that no frame is drawn with the previous look.
  useLayoutEffect(() => {
    city.setAtmosphere(atmosphere);
    city.setAccent(theme.accent);
    gl.toneMappingExposure = atmosphere.exposure;
    gl.shadowMap.needsUpdate = true;
    invalidate();
  }, [city, atmosphere, theme.accent, gl, invalidate]);

  // Nothing redraws by itself here, so a restored WebGL context has to be
  // asked for a fresh frame and a fresh shadow map.
  useEffect(() => {
    const canvas = gl.domElement;
    const onRestored = () => {
      gl.shadowMap.needsUpdate = true;
      invalidate();
    };
    canvas.addEventListener("webglcontextrestored", onRestored);
    return () => canvas.removeEventListener("webglcontextrestored", onRestored);
  }, [gl, invalidate]);

  const railGeometry = useDisposable(
    () => (skyline ? buildRailGeometry(skyline.features) : null),
    [skyline],
  );

  // Full-height band when a floorplan-as-stack is selected (Stead 220).
  const bandGeometry = useDisposable(() => {
    if (!selectedPlan || !building.unitMapping) return null;
    const stack = stackFromPlan(selectedPlan, building.unitMapping);
    if (!stack) return null;
    const band = placeStackBand(stack, building.unitMapping, g, ring);
    if (!band) return null;
    return extrudeRing(orientedBoxRing(band.point, band.normal, 9, 5), band.zMin, band.zMax);
  }, [selectedPlan, building, g, ring]);

  // Clicking the tower: tune mode emits a stacks-config snippet; otherwise
  // filter the table to the clicked floor.
  const onBuildingClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const z = e.point.y; // three y == height
    const floor = Math.floor((z - g.groundFloorOffsetM) / g.floorHeightM) + 1;
    if (onTuneClick) {
      const fp = facadeParam(ring, [e.point.x, -e.point.z]);
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

  // Floor bands wrap the tower just outside its walls, which are opaque.
  const bandRing = useMemo(
    () =>
      ring.map(([x, y]): Vec2 => {
        const dx = x - center[0];
        const dy = y - center[1];
        const len = Math.hypot(dx, dy) || 1;
        return [x + (dx / len) * 0.6, y + (dy / len) * 0.6];
      }),
    [ring, center],
  );

  const slabGeometry = useDisposable(
    () =>
      placement?.floorSlab
        ? extrudeRing(bandRing, placement.floorSlab.zMin, placement.floorSlab.zMax)
        : null,
    [placement, bandRing],
  );

  const filterSlabGeometry = useDisposable(() => {
    if (floorMin === null && floorMax === null) return null;
    if (placement) return null; // selected-unit slab wins
    const lo = floorMin ?? 1;
    const hi = floorMax ?? g.floors;
    return extrudeRing(
      bandRing,
      g.groundFloorOffsetM + (lo - 1) * g.floorHeightM,
      g.groundFloorOffsetM + hi * g.floorHeightM,
    );
  }, [floorMin, floorMax, placement, bandRing, g]);

  return (
    <>
      <fog attach="fog" color={atmosphere.horizon} near={FOG_NEAR} far={FOG_FAR} />
      <primitive object={city.group} />
      <primitive object={city.hero} onClick={onBuildingClick} />

      {railGeometry && (
        <lineSegments geometry={railGeometry}>
          <lineBasicMaterial color={theme.rail} />
        </lineSegments>
      )}

      {/* station markers, landmark and street labels */}
      {skyline && (
        <Landmarks
          skyline={skyline}
          center={center}
          theme={theme}
          excludeOsmIds={site.trackedOsmIds}
        />
      )}

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

      {/* every listed unit, on the tower; in tune mode the facade keeps all the clicks */}
      <UnitMarks
        states={marks}
        ring={ring}
        interactive={!onTuneClick}
        labelLayer={labelLayer}
      />

      {/* unit marker beacon: sits just inside the facade, so it is drawn over everything */}
      {placement?.marker && (
        <group position={planToThree(...placement.marker)}>
          <mesh renderOrder={10}>
            <sphereGeometry args={[2.4, 20, 20]} />
            {/* `transparent` only queues it with the other overlays, so that renderOrder puts it after the unit marks */}
            <meshBasicMaterial
              color={theme.marker}
              depthTest={false}
              toneMapped={false}
              transparent
            />
          </mesh>
          <mesh renderOrder={10}>
            <sphereGeometry args={[4.2, 20, 20]} />
            <meshBasicMaterial
              color={theme.marker}
              transparent
              opacity={0.25}
              depthTest={false}
              toneMapped={false}
            />
          </mesh>
        </group>
      )}

      <CameraRig
        placement={placement}
        city={city}
        sunAzDeg={atmosphere.azDeg}
        night={atmosphere.night}
      />
    </>
  );
}

export default function Scene3D({
  building,
  allBuildings,
  history,
  units,
}: {
  building: BuildingConfig;
  allBuildings: BuildingConfig[];
  history: BuildingHistory;
  /**
   * The rows the table shows now. Every listed unit is drawn on the tower;
   * the ones missing from this list are drawn as "not in the current filter".
   * Omitted = nothing is filtered.
   */
  units?: UnitListing[];
}) {
  const [skyline, setSkyline] = useState<SkylineCollection | null | undefined>(undefined);
  const [unitMap, setUnitMap] = useState<UnitMapSidecar | null>(null);
  const [tuneClick, setTuneClick] = useState<TuneClick | null>(null);
  const discRef = useRef<HTMLDivElement | null>(null);
  const labelLayer = useRef<HTMLDivElement | null>(null);
  const theme = useTheme();
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const cameraMode = useStore((s) => s.cameraMode);
  const setCameraMode = useStore((s) => s.setCameraMode);
  // HashRouter reconciles this component across /b/:id routes — the query
  // must come from the router so ?tune=1 and ?t= apply without a full reload.
  const { search } = useLocation();
  const query = useMemo(() => new URLSearchParams(search), [search]);
  const tuneMode = query.has("tune");
  const hours = parseHourOfDay(query.get("t")) ?? theme.defaultHour;

  useEffect(() => {
    void loadSkyline().then(setSkyline);
  }, []);
  useEffect(() => {
    setUnitMap(null);
    void loadUnitMap(building.id).then(setUnitMap);
  }, [building.id]);

  // undefined while the skyline loads; a null skyline (none generated) still
  // gives a site: the tower alone, on its fallback box.
  const site = useMemo(
    () => (skyline === undefined ? null : resolveSite(building, allBuildings, skyline)),
    [building, allBuildings, skyline],
  );

  // The scene is lit for today at `hours` on Chicago's clocks.
  const litAt = useMemo(
    () => wallClockInstant(chicagoDate(new Date()), hours, CHICAGO_TZ),
    [hours],
  );
  const atmosphere = useMemo(() => {
    const sun = sunPosition(litAt, building.lat, building.lon);
    return atmosphereAt(sun.altitudeDeg, sun.azimuthDeg);
  }, [litAt, building.lat, building.lon]);

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
      site && selectedUnit
        ? placeUnit(
            selectedUnit,
            building.unitMapping,
            building.geometry,
            site.ring,
            exactFor(selectedUnit),
          )
        : null,
    [site, selectedUnit, building, exactFor],
  );

  useEffect(() => {
    // Leaving unit-view when the selection loses its viewpoint.
    if (cameraMode === "unit-view" && !placement?.viewCamera) setCameraMode("orbit");
  }, [cameraMode, placement, setCameraMode]);

  // Every listing as a mark on the tower. The page swaps `building` a moment
  // before the matching history arrives: another building's units are never
  // laid out on this tower.
  const listings = history.buildingId === building.id ? history : null;
  const markStates = useMemo(() => {
    const latest = listings?.latest;
    if (!site || !listings || !latest) return [];
    return buildMarkStates({
      building,
      ring: site.ring,
      listed: latest.units,
      alsoListed: listings.alsoListed ?? [],
      shown: units,
      asOf: latest.timestamp,
      exactFor: (unit) => {
        const p = exactFor(unit);
        return p ? [p.x, p.y] : undefined;
      },
    });
  }, [site, building, listings, units, exactFor]);
  const legend = useMemo(() => buildLegend(markStates), [markStates]);

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

  if (!site || skyline === undefined) {
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
        frameloop="demand"
        shadows={SHADOWS}
        gl={RENDERER}
        camera={CAMERA}
        // isolate: the labels drawn inside the canvas stay under the overlays below
        style={{ background: theme.background, isolation: "isolate" }}
      >
        <SceneContent
          site={site}
          skyline={skyline}
          theme={theme}
          atmosphere={atmosphere}
          placement={placement}
          marks={markStates}
          labelLayer={labelLayer}
          {...(tuneMode ? { onTuneClick: setTuneClick } : {})}
        />
        <AzimuthBridge discRef={discRef} />
      </Canvas>
      <CompassHud building={building} facing={facing} discRef={discRef} at={litAt} />
      {/* the tune overlay takes the same corner */}
      {!tuneMode && markStates.length > 0 && <MarksLegend model={legend} />}
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
      {/* last, so on top: the label of the hovered unit mark is drawn in here */}
      <div ref={labelLayer} className="scene-labels" />
    </div>
  );
}
