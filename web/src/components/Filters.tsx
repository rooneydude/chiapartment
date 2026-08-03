import { useStore } from "../state/store";

const BED_OPTIONS = [0, 1, 2, 3];

export default function Filters({ maxFloor }: { maxFloor: number }) {
  const bedsFilter = useStore((s) => s.bedsFilter);
  const toggleBeds = useStore((s) => s.toggleBeds);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);
  const setFloorRange = useStore((s) => s.setFloorRange);

  return (
    <div className="filters">
      {BED_OPTIONS.map((b) => (
        <button
          key={b}
          className={`chip${bedsFilter?.includes(b) ? " on" : ""}`}
          onClick={() => toggleBeds(b)}
        >
          {b === 0 ? "Studio" : b === 3 ? "3+ BR" : `${b} BR`}
        </button>
      ))}
      <span className="sep" />
      <label>
        Floor{" "}
        <input
          type="number"
          min={1}
          max={maxFloor}
          placeholder="1"
          value={floorMin ?? ""}
          onChange={(e) =>
            setFloorRange(e.target.value === "" ? null : Number(e.target.value), floorMax)
          }
        />
      </label>
      <label>
        to{" "}
        <input
          type="number"
          min={1}
          max={maxFloor}
          placeholder={String(maxFloor)}
          value={floorMax ?? ""}
          onChange={(e) =>
            setFloorRange(floorMin, e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </label>
      {(bedsFilter !== null || floorMin !== null || floorMax !== null) && (
        <button
          className="chip"
          onClick={() => {
            setFloorRange(null, null);
            for (const b of bedsFilter ?? []) toggleBeds(b);
          }}
        >
          ✕ clear
        </button>
      )}
    </div>
  );
}
