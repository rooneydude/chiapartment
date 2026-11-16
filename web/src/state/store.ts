import { create } from "zustand";

export type ChartMode = "floorplans" | "units";
export type CameraMode = "orbit" | "unit-view";
/** null = any move-in date; 0 = available now; N = within N days. */
export type MoveInWithin = number | null;

interface AppState {
  selectedUnit: string | null;
  /** Selected floorplan-as-stack (buildings where plans map to risers). */
  selectedPlan: string | null;
  hoveredUnit: string | null;
  chartMode: ChartMode;
  cameraMode: CameraMode;
  bedsFilter: number[] | null; // null = all; 3 means "3+"
  /** Move-in filter. Defaults to null (no restriction) on every building. */
  moveInWithin: MoveInWithin;
  /**
   * Lease length to price the table at, where a site publishes a lease-term
   * table. null = the price and term the site itself advertises.
   */
  leaseTerm: number | null;
  floorMin: number | null;
  floorMax: number | null;
  /**
   * The 3D scene's legend: open or folded once the reader has chosen; null =
   * not chosen yet (open, except on a narrow panel). Kept across buildings.
   */
  legendOpen: boolean | null;
  selectUnit(unit: string | null): void;
  selectPlan(plan: string | null): void;
  hoverUnit(unit: string | null): void;
  setChartMode(mode: ChartMode): void;
  setCameraMode(mode: CameraMode): void;
  toggleBeds(beds: number): void;
  setBedsFilter(beds: number[] | null): void;
  setMoveInWithin(within: MoveInWithin): void;
  setLeaseTerm(months: number | null): void;
  setFloorRange(min: number | null, max: number | null): void;
  setLegendOpen(open: boolean): void;
  resetForBuilding(focusBeds?: number[] | null): void;
}

export const useStore = create<AppState>((set) => ({
  selectedUnit: null,
  selectedPlan: null,
  hoveredUnit: null,
  chartMode: "floorplans",
  cameraMode: "orbit",
  bedsFilter: null,
  moveInWithin: null,
  leaseTerm: null,
  floorMin: null,
  floorMax: null,
  legendOpen: null,
  selectUnit: (unit) =>
    set((s) => ({
      selectedUnit: unit,
      selectedPlan: null,
      chartMode: unit ? "units" : s.chartMode,
      cameraMode: unit ? s.cameraMode : "orbit",
    })),
  selectPlan: (plan) =>
    set({ selectedPlan: plan, selectedUnit: null, cameraMode: "orbit" }),
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
  setBedsFilter: (beds) => set({ bedsFilter: beds && beds.length > 0 ? beds : null }),
  setMoveInWithin: (moveInWithin) => set({ moveInWithin }),
  setLeaseTerm: (leaseTerm) => set({ leaseTerm }),
  setFloorRange: (floorMin, floorMax) => set({ floorMin, floorMax }),
  setLegendOpen: (legendOpen) => set({ legendOpen }),
  resetForBuilding: (focusBeds) =>
    set({
      selectedUnit: null,
      selectedPlan: null,
      hoveredUnit: null,
      cameraMode: "orbit",
      // Buildings open pre-filtered to the beds the user shops for.
      bedsFilter: focusBeds && focusBeds.length > 0 ? focusBeds : null,
      // Never restrict by move-in date or lease length unless asked to.
      moveInWithin: null,
      leaseTerm: null,
      floorMin: null,
      floorMax: null,
    }),
}));
