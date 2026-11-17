import * as THREE from "three";
import { normalizeRing, type Vec2 } from "../../../shared/src/placement";
import { isBuildingFeature } from "../../../shared/src/types";
import type { SkylineCollection, SkylineFeature } from "../../../shared/src/types";
import type { Atmosphere } from "./atmosphere";
import { buildContextGeometry, buildRoofBoxes } from "./context";
import { makeFacadeMaterial, makeFacadeUniforms } from "./facadeMaterial";
import { ringToShape } from "./geometry";
import {
  buildAreaGeometry,
  buildLightPoolGeometry,
  buildRoadStrips,
  buildTrees,
  makeGlowTexture,
  makeGroundAO,
  makeWaterMaterial,
  streetLightPositions,
} from "./ground";
import { buildHeroGeometry, makeHeroMaterial } from "./heroTower";
import { findHomeView, makeVisibility, type HomeView, type HomeViewOptions } from "./homeView";
import { configuredHeight, type Site } from "./site";
import { applyAtmosphereToSky, makeSkyDome, makeSkyUniforms } from "./sky";

/**
 * The static 3D city around one tracked tower, as ONE imperative module that
 * the React scene mounts with <primitive object={city.group} />. Everything
 * static is built once; time of day only touches uniforms and light
 * properties (no shader recompiles). React keeps owning the selection
 * overlays, labels, HUD and controls.
 */
export interface City {
  /** Sky, lights, ground, the surrounding buildings, the other tracked towers, trees. */
  readonly group: THREE.Group;
  /** The tracked tower. Not in `group`: the React layer mounts it itself, to attach its click handler. */
  readonly hero: THREE.Mesh;
  /** Push a new atmosphere into the lights and uniforms. The shadow map must then be re-rendered. */
  setAtmosphere(atmosphere: Atmosphere): void;
  /** Colour of the tracked tower's crown and of the halo around its base. */
  setAccent(color: THREE.ColorRepresentation): void;
  /** Where the orbit camera rests. */
  homeView(opts: HomeViewOptions): HomeView;
  /** Free every GPU resource. Call once nothing renders the city any more. */
  dispose(): void;
}

/** Linear fog range in metres; its colour is the atmosphere's horizon. */
export const FOG_NEAR = 650;
export const FOG_FAR = 3400;

/** Half-width of the area around the tower that receives the sun's shadows. */
const SHADOW_RADIUS_M = 520;
const SHADOW_MAP_SIZE = 2048;
const GROUND_COLOR = "#d9d5ca";
/** The curtain wall runs this far past the top floor, to form the parapet. */
const PARAPET_RISE_M = 1.2;
/** Side of the square the baked ambient occlusion covers, and its texture resolution. */
const AO_SIZE_M = 1500;
const AO_TEXTURE_PX = 1024;
/** Radius of the pool of light under a street lamp, and the height of its halo. */
const LIGHT_POOL_RADIUS_M = 19;
const LAMP_HEIGHT_M = 8.5;

interface GroundLayer {
  renderOrder: number;
  offsetUnits: number;
}

/**
 * The flat layers on the ground are coplanar at y = 0: they are ordered by
 * renderOrder and separated by a polygon offset instead of by height, and
 * write no depth -> no z-fighting, at any distance.
 */
const LAYER = {
  water: { renderOrder: -19, offsetUnits: 1 },
  park: { renderOrder: -18, offsetUnits: 2 },
  sidewalk: { renderOrder: -17, offsetUnits: 3 },
  road: { renderOrder: -16, offsetUnits: 4 },
  occlusion: { renderOrder: -12, offsetUnits: 12 },
  lightPools: { renderOrder: -10, offsetUnits: 10 },
  halo: { renderOrder: -9, offsetUnits: 14 },
} satisfies Record<string, GroundLayer>;
const GROUND_RENDER_ORDER = -20;

function asLayer<M extends THREE.Material>(
  mesh: THREE.Mesh<THREE.BufferGeometry, M>,
  layer: GroundLayer,
): THREE.Mesh<THREE.BufferGeometry, M> {
  mesh.renderOrder = layer.renderOrder;
  mesh.material.depthWrite = false;
  mesh.material.polygonOffset = true;
  mesh.material.polygonOffsetFactor = -1;
  mesh.material.polygonOffsetUnits = -layer.offsetUnits;
  return mesh;
}

function castAndReceive<T extends THREE.Object3D>(object: T): T {
  object.castShadow = true;
  object.receiveShadow = true;
  return object;
}

/** Frees the geometries, materials, textures and shadow maps of everything under `root`. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Points ||
      object instanceof THREE.Line
    ) {
      object.geometry.dispose();
      const materials: THREE.Material[] = Array.isArray(object.material)
        ? object.material
        : [object.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    }
    if (object instanceof THREE.InstancedMesh || object instanceof THREE.Light) object.dispose();
  });
}

/**
 * `skyline` null = the skyline file is unavailable: the tower then stands
 * alone on the bare ground.
 */
export function createCity(site: Site, skyline: SkylineCollection | null): City {
  const { building, ring, center, radius, height } = site;
  const g = building.geometry;
  const features = skyline?.features ?? [];
  const footprints = features.filter(isBuildingFeature);
  /** Height a footprint is drawn with: tracked towers use their configured height, not OSM's. */
  const heightOf = (f: SkylineFeature): number => {
    const tower = site.tracked.get(f.properties.osmId);
    return tower ? configuredHeight(tower.building) : f.properties.height;
  };
  const centre3 = new THREE.Vector3(center[0], 0, -center[1]);

  const group = new THREE.Group();
  group.name = "city";

  // ---- sky + shared uniforms ----
  const sky = makeSkyUniforms();
  sky.uClouds.value = 1;
  const groundReflection = { value: new THREE.Color(GROUND_COLOR) };
  group.add(makeSkyDome(sky));

  // ---- lights ----
  const hemi = new THREE.HemisphereLight();
  const key = new THREE.DirectionalLight();
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  key.shadow.bias = -0.0002;
  key.shadow.normalBias = ((2 * SHADOW_RADIUS_M) / SHADOW_MAP_SIZE) * 1.6;
  key.target.position.copy(centre3);
  const bounce = new THREE.DirectionalLight();
  bounce.target.position.copy(centre3);
  group.add(hemi, key, key.target, bounce, bounce.target);

  // ---- ground ----
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(4200, 64),
    new THREE.MeshLambertMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.copy(centre3);
  ground.receiveShadow = true;
  ground.renderOrder = GROUND_RENDER_ORDER;
  group.add(ground);

  const addLayer = <M extends THREE.Material>(
    geometry: THREE.BufferGeometry | null,
    material: M,
    layer: GroundLayer,
  ): THREE.Mesh<THREE.BufferGeometry, M> | null => {
    if (!geometry) return null;
    const mesh = asLayer(new THREE.Mesh(geometry, material), layer);
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };
  addLayer(buildAreaGeometry(features, "water"), makeWaterMaterial(sky), LAYER.water);
  addLayer(
    buildAreaGeometry(features, "park"),
    new THREE.MeshLambertMaterial({ color: "#a9c48e" }),
    LAYER.park,
  );
  addLayer(
    buildRoadStrips(features, 5.2),
    new THREE.MeshLambertMaterial({ color: "#e6e2d8" }),
    LAYER.sidewalk,
  );
  // The carriageways pick up a little sodium-lamp glow at night.
  const roads = addLayer(
    buildRoadStrips(features),
    new THREE.MeshLambertMaterial({ color: "#a3a5a6", emissive: "#ffb46a", emissiveIntensity: 0 }),
    LAYER.road,
  );

  const aoTexture =
    footprints.length > 0
      ? makeGroundAO(features, center, { sizeM: AO_SIZE_M, px: AO_TEXTURE_PX, heightOf })
      : null;
  if (aoTexture) {
    const ao = asLayer(
      new THREE.Mesh(
        new THREE.PlaneGeometry(AO_SIZE_M, AO_SIZE_M),
        new THREE.MeshBasicMaterial({
          map: aoTexture,
          blending: THREE.MultiplyBlending,
          toneMapped: false,
          fog: false,
        }),
      ),
      LAYER.occlusion,
    );
    ao.rotation.x = -Math.PI / 2;
    ao.position.copy(centre3);
    group.add(ao);
  }

  // ---- street lights (always built, faded in by `night`) ----
  const lamps = streetLightPositions(features);
  const glow = lamps.length > 0 ? makeGlowTexture() : null;
  let streetLights: {
    pools: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    halos: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  } | null = null;
  if (glow) {
    const pools = asLayer(
      new THREE.Mesh(
        buildLightPoolGeometry(lamps, LIGHT_POOL_RADIUS_M),
        new THREE.MeshBasicMaterial({
          map: glow,
          color: "#ffb872",
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
        }),
      ),
      LAYER.lightPools,
    );
    const lampGeometry = new THREE.BufferGeometry();
    lampGeometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        lamps.flatMap(([x, y]) => [x, LAMP_HEIGHT_M, -y]),
        3,
      ),
    );
    const halos = new THREE.Points(
      lampGeometry,
      new THREE.PointsMaterial({
        map: glow,
        color: "#ffe2b8",
        size: 15,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    group.add(pools, halos);
    streetLights = { pools, halos };
  }

  // ---- buildings ----
  const contextGeometry = buildContextGeometry(features, site.trackedOsmIds);
  if (contextGeometry) {
    const facadeUniforms = makeFacadeUniforms({ x: center[0], z: -center[1], radius, height });
    group.add(
      castAndReceive(new THREE.Mesh(contextGeometry, makeFacadeMaterial(sky, facadeUniforms))),
    );
  }
  const roofBoxes = buildRoofBoxes(features, site.trackedOsmIds, center);
  if (roofBoxes) group.add(roofBoxes);

  // The other tracked towers: the same curtain wall a shade darker, with lit rooms and no crown.
  for (const tower of site.tracked.values()) {
    if (tower.building.id === building.id) continue;
    const footprint = tower.feature.geometry.coordinates[0];
    if (!footprint || footprint.length < 3) continue;
    const tg = tower.building.geometry;
    const { material } = makeHeroMaterial(sky, {
      floors: tg.floors,
      floorHeightM: tg.floorHeightM,
      podiumHeightM: tg.groundFloorOffsetM,
      frame: "#d3d6d9",
      glass: "#93a3b1",
      litShare: 0.22,
      crown: false,
      groundReflection,
    });
    const geometry = buildHeroGeometry(
      normalizeRing(footprint),
      configuredHeight(tower.building) + PARAPET_RISE_M,
    );
    group.add(castAndReceive(new THREE.Mesh(geometry, material)));
  }
  // The tracked tower itself: no random lit rooms (the unit marks own that contrast), accent crown.
  const heroLook = makeHeroMaterial(sky, {
    floors: g.floors,
    floorHeightM: g.floorHeightM,
    podiumHeightM: g.groundFloorOffsetM,
    frame: "#e6e8ea",
    glass: "#9fb0bf",
    litShare: 0,
    crown: true,
    groundReflection,
  });
  const hero = castAndReceive(
    new THREE.Mesh(buildHeroGeometry(ring, height + PARAPET_RISE_M), heroLook.material),
  );
  hero.name = "hero";

  // An accent halo on the ground around its footprint.
  const haloShape = ringToShape(
    ring.map((p): Vec2 => {
      const dx = p[0] - center[0];
      const dy = p[1] - center[1];
      const l = Math.hypot(dx, dy) || 1;
      return [p[0] + (dx / l) * 5, p[1] + (dy / l) * 5];
    }),
  );
  haloShape.holes.push(new THREE.Path(ring.map((p) => new THREE.Vector2(p[0], p[1]))));
  const halo = asLayer(
    new THREE.Mesh(
      new THREE.ShapeGeometry(haloShape),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, toneMapped: false }),
    ),
    LAYER.halo,
  );
  halo.rotation.x = -Math.PI / 2;
  group.add(halo);

  // ---- trees ----
  const trees = buildTrees(features, center);
  if (trees) group.add(trees);

  // ---- camera fit ----
  const visibility = makeVisibility(
    ring,
    height,
    footprints
      .filter((f) => f !== site.feature)
      .map((f) => ({ ring: f.geometry.coordinates[0] ?? [], height: heightOf(f) })),
  );

  return {
    group,
    hero,
    setAtmosphere(atmosphere) {
      applyAtmosphereToSky(sky, atmosphere);
      hemi.color.copy(atmosphere.hemiSky);
      hemi.groundColor.copy(atmosphere.hemiGround);
      hemi.intensity = atmosphere.hemiIntensity * 1.25;
      key.color.copy(atmosphere.sunColor);
      key.intensity = atmosphere.sunIntensity;
      key.position.copy(centre3).addScaledVector(atmosphere.lightDir, 1600);
      // Shadow frustum: as wide as the shadowed area, and as tall as that area
      // (plus what stands on it) appears from the light's altitude.
      const sinA = Math.max(atmosphere.lightDir.y, 0.05);
      const cosA = Math.sqrt(1 - sinA * sinA);
      const halfY = SHADOW_RADIUS_M * sinA + 230 * cosA;
      const shadowCamera = key.shadow.camera;
      shadowCamera.left = -SHADOW_RADIUS_M;
      shadowCamera.right = SHADOW_RADIUS_M;
      shadowCamera.top = halfY;
      shadowCamera.bottom = -halfY;
      shadowCamera.near = 200;
      shadowCamera.far = 3400;
      shadowCamera.updateProjectionMatrix();
      key.shadow.intensity = atmosphere.shadowIntensity * 0.82;
      // A weak fill from opposite the key light, so the shaded faces keep some form.
      bounce.color.copy(atmosphere.hemiSky);
      bounce.intensity = atmosphere.sunIntensity * 0.2;
      bounce.position
        .set(-atmosphere.lightDir.x, 0.35, -atmosphere.lightDir.z)
        .multiplyScalar(1000)
        .add(centre3);
      // What tower glass reflects below the horizon: the ground colour, as brightly as it is lit.
      const groundLight =
        atmosphere.sunIntensity * Math.max(atmosphere.lightDir.y, 0) +
        atmosphere.hemiIntensity * 0.75;
      groundReflection.value.set(GROUND_COLOR).multiplyScalar(Math.min(1, groundLight / Math.PI));
      if (roads) roads.material.emissiveIntensity = 0.2 * atmosphere.night;
      if (streetLights) {
        streetLights.pools.material.opacity = 0.8 * atmosphere.night;
        streetLights.halos.material.opacity = atmosphere.night;
        streetLights.pools.visible = streetLights.halos.visible = atmosphere.night > 0.02;
      }
    },
    setAccent(color) {
      heroLook.uniforms.uAccent.value.set(color);
      halo.material.color.set(color);
    },
    homeView: (opts) => findHomeView({ center, radius, height }, visibility, opts),
    dispose() {
      disposeTree(group);
      disposeTree(hero);
    },
  };
}
