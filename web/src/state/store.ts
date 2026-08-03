import { create } from "zustand";

export type ChartMode = "floorplans" | "units";
export type CameraMode = "orbit" | "unit-view";

interface AppState {
  selectedUnit: string | null;
  hoveredUnit: string | null;
  chartMode: ChartMode;
  cameraMode: CameraMode;
  bedsFilter: number[] | null; // null = all; 3 means "3+"
  floorMin: number | null;
  floorMax: number | null;
  selectUnit(unit: string | null): void;
  hoverUnit(unit: string | null): void;
  setChartMode(mode: ChartMode): void;
  setCameraMode(mode: CameraMode): void;
  toggleBeds(beds: number): void;
  setFloorRange(min: number | null, max: number | null): void;
  resetForBuilding(): void;
}

export const useStore = create<AppState>((set) => ({
  selectedUnit: null,
  hoveredUnit: null,
  chartMode: "floorplans",
  cameraMode: "orbit",
  bedsFilter: null,
  floorMin: null,
  floorMax: null,
  selectUnit: (unit) =>
    set((s) => ({
      selectedUnit: unit,
      chartMode: unit ? "units" : s.chartMode,
      cameraMode: unit ? s.cameraMode : "orbit",
    })),
  hoverUnit: (unit) => set({ hoveredUnit: unit }),
  setChartMode: (chartMode) => set({ chartMode }),
  setCameraMode: (cameraMode) => set({ cameraMode }),
  toggleBeds: (beds) =>
    set((s) => {
      const current = s.bedsFilter ?? [];
      const next = current.includes(beds)
        ? current.filter((b) => b !== beds)
        : [...current, beds];
      return { bedsFilter: next.length === 0 ? null : next };
    }),
  setFloorRange: (floorMin, floorMax) => set({ floorMin, floorMax }),
  resetForBuilding: () =>
    set({
      selectedUnit: null,
      hoveredUnit: null,
      cameraMode: "orbit",
      bedsFilter: null,
      floorMin: null,
      floorMax: null,
    }),
}));
