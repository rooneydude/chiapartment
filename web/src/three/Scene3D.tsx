import type { BuildingConfig, BuildingHistory } from "../../../shared/src/types";

/** Placeholder — the real 3D scene lands with the skyline data. */
export default function Scene3D(_props: {
  building: BuildingConfig;
  history: BuildingHistory;
}) {
  return (
    <div className="scene-wrap">
      <div className="scene-empty">3D view loading…</div>
    </div>
  );
}
