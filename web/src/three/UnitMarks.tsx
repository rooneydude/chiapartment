import { Html } from "@react-three/drei";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import * as THREE from "three";
import type { Vec2 } from "../../../shared/src/placement";
import { useStore } from "../state/store";
import { beltAnchor, buildMarkBuffers, resolvePick } from "./markGeometry";
import { makeMarkMaterial } from "./markMaterial";
import { findMark, markLabelParts, type MarkState } from "./unitMarks";
import { useDisposable } from "./useDisposable";

/** A press that travelled further than this before release was an orbit drag, not a click. */
const CLICK_SLOP_PX = 5;
/** Drawn after the floor bands (0), before the selected-unit beacon (10). */
const RENDER_ORDER = { ghost: 5, solid: 6 };

type Point3 = [number, number, number];

/**
 * Every listed unit, drawn on the tracked tower (see unitMarks.ts for what a
 * mark means). Two draw calls for all of them; the geometry is rebuilt only
 * when the listings or the filter change — hover and selection are two
 * uniforms. Mounted inside the canvas, next to the tower.
 */
export default function UnitMarks({
  states,
  ring,
  interactive,
  labelLayer,
}: {
  states: readonly MarkState[];
  /** The tower's footprint in plan metres. */
  ring: Vec2[];
  /** false: the marks are drawn but ignore the pointer (tune mode needs every click on the facade). */
  interactive: boolean;
  /**
   * The element the label of the hovered mark is put in: one that covers the
   * canvas and lies above the scene's other overlays, so the label is never
   * tucked under the legend.
   */
  labelLayer: MutableRefObject<HTMLElement | null>;
}) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const invalidate = useThree((s) => s.invalidate);
  const dpr = useThree((s) => s.viewport.dpr);
  const hoveredUnit = useStore((s) => s.hoveredUnit);
  const selectedUnit = useStore((s) => s.selectedUnit);
  const selectedPlan = useStore((s) => s.selectedPlan);
  const leaseTerm = useStore((s) => s.leaseTerm);
  const hoverUnit = useStore((s) => s.hoverUnit);

  const buffers = useMemo(() => buildMarkBuffers(states, ring), [states, ring]);
  const geometry = useDisposable(() => {
    if (buffers.index.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buffers.position, 3));
    g.setAttribute("aLocal", new THREE.BufferAttribute(buffers.local, 2));
    g.setAttribute("aShape", new THREE.BufferAttribute(buffers.shape, 4));
    g.setAttribute("aStyle", new THREE.BufferAttribute(buffers.style, 4));
    g.setAttribute("aColor", new THREE.BufferAttribute(buffers.color, 3));
    g.setIndex(new THREE.BufferAttribute(buffers.index, 1));
    return g;
  }, [buffers]);
  const pickGeometry = useDisposable(() => {
    if (buffers.pick.index.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(buffers.pick.position, 3));
    g.setIndex(new THREE.BufferAttribute(buffers.pick.index, 1));
    return g;
  }, [buffers]);

  const materials = useMemo(
    () => ({
      ghost: makeMarkMaterial("ghost"),
      solid: makeMarkMaterial("solid"),
      // Never rendered (the pointer mesh is invisible): only its `side` matters, to the raycaster.
      pick: new THREE.MeshBasicMaterial(),
    }),
    [],
  );
  useEffect(
    () => () => {
      materials.ghost.dispose();
      materials.solid.dispose();
      materials.pick.dispose();
    },
    [materials],
  );

  /** The mark under the pointer, and where its label goes. */
  const [pointed, setPointed] = useState<{ index: number; anchor: Point3 } | null>(null);
  /** A mark with no table row to select: a click keeps its label up (touch screens cannot hover). */
  const [pinned, setPinned] = useState<number | null>(null);
  const pointedRef = useRef(-1);

  const leave = () => {
    if (pointedRef.current < 0) return;
    pointedRef.current = -1;
    setPointed(null);
    hoverUnit(null);
    gl.domElement.style.cursor = "";
  };
  // New listings or a new filter: indices mean something else now.
  useEffect(() => {
    pointedRef.current = -1;
    setPointed(null);
    setPinned(null);
  }, [states]);
  // Gone while hovered: leave no hover or cursor behind.
  useEffect(
    () => () => {
      if (pointedRef.current >= 0) useStore.getState().hoverUnit(null);
      gl.domElement.style.cursor = "";
    },
    [gl],
  );
  useEffect(() => {
    if (!interactive) leave();
  }, [interactive]);

  const tableHover = hoveredUnit ? findMark(states, { unit: hoveredUnit }) : -1;
  const hoverIndex = pointed?.index ?? pinned ?? tableHover;
  const selectedIndex = findMark(states, { unit: selectedUnit, plan: selectedPlan });

  // Imperative: nothing redraws by itself on a demand-driven canvas.
  useLayoutEffect(() => {
    for (const material of [materials.ghost, materials.solid]) {
      material.uniforms.uHover.value = hoverIndex;
      material.uniforms.uSelected.value = selectedIndex;
      material.uniforms.uDpr.value = dpr;
    }
    invalidate();
  }, [materials, hoverIndex, selectedIndex, dpr, invalidate]);

  /** The listing a pointer event means, or -1 when something nearer (the tower) is in the way. */
  const markAt = (e: ThreeEvent<MouseEvent>): number => {
    if (e.intersections[0]?.object !== e.object || e.faceIndex == null) return -1;
    const target = buffers.pick.targets[e.faceIndex >> 1];
    return target ? resolvePick(target, e.point) : -1;
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const index = markAt(e);
    if (index < 0) {
      leave();
      return;
    }
    if (index === pointedRef.current) return;
    const state = states[index];
    if (!state) return;
    pointedRef.current = index;
    // Plates carry their label on top; a band or a strip takes it where the pointer met it.
    const fixed = buffers.anchors[index];
    const anchor: Point3 =
      state.mark.kind === "plate" && fixed
        ? fixed
        : [e.point.x, state.mark.kind === "belt" ? (state.mark.zMax ?? e.point.y) : e.point.y, e.point.z];
    setPointed({ index, anchor });
    hoverUnit(state.mark.unitNumber);
    gl.domElement.style.cursor = "pointer";
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const index = markAt(e);
    if (index < 0) return; // not ours: the tower behind takes the click
    e.stopPropagation();
    if (e.delta > CLICK_SLOP_PX) return;
    const select = states[index]?.select;
    const store = useStore.getState();
    if (!select) setPinned((current) => (current === index ? null : index));
    else if (select.kind === "unit") {
      store.selectUnit(store.selectedUnit === select.unit ? null : select.unit);
    } else {
      store.selectPlan(store.selectedPlan === select.plan ? null : select.plan);
    }
  };

  // ---- the label of the hovered mark ----
  const labelIndex = hoverIndex;
  const labelState = labelIndex >= 0 ? states[labelIndex] : undefined;
  let labelAnchor: Point3 | null = null;
  if (labelState) {
    labelAnchor =
      (pointed?.index === labelIndex ? pointed.anchor : null) ??
      buffers.anchors[labelIndex] ??
      beltAnchor(ring, labelState.mark, [camera.position.x, -camera.position.z]);
  }
  // Near the left or right edge of the view the label grows inwards instead of being cut off.
  const lean = useMemo(() => {
    if (!labelAnchor) return 0;
    const x = new THREE.Vector3(...labelAnchor).project(camera).x;
    return x < -0.3 ? -1 : x > 0.3 ? 1 : 0;
  }, [labelAnchor?.[0], labelAnchor?.[1], labelAnchor?.[2], camera]);

  if (!geometry) return null;
  return (
    <>
      <mesh geometry={geometry} material={materials.ghost} renderOrder={RENDER_ORDER.ghost} />
      <mesh geometry={geometry} material={materials.solid} renderOrder={RENDER_ORDER.solid} />
      {interactive && pickGeometry && (
        <mesh
          geometry={pickGeometry}
          material={materials.pick}
          visible={false}
          onPointerMove={onPointerMove}
          onPointerOut={leave}
          onClick={onClick}
          onPointerMissed={() => setPinned(null)}
        />
      )}
      {labelState && labelAnchor && (
        <Html
          position={labelAnchor}
          portal={labelLayer as MutableRefObject<HTMLElement>}
          className={`mark-label${labelState.look === "muted" ? " muted" : ""}`}
          style={{
            pointerEvents: "none",
            transform: `translate(${lean < 0 ? -12 : lean > 0 ? -88 : -50}%, calc(-100% - 12px))`,
          }}
        >
          <span className="mark-label-chip" style={{ background: labelState.color }} />
          {/* each piece stays whole; a long label breaks between pieces */}
          {markLabelParts(labelState, leaseTerm).map((part, i, parts) => (
            <span key={i}>{i < parts.length - 1 ? `${part} · ` : part}</span>
          ))}
        </Html>
      )}
    </>
  );
}
