import { useStore } from "../state/store";

const BED_OPTIONS = [0, 1, 2, 3];

const MOVE_IN_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Any move-in date" },
  { value: 0, label: "Available now" },
  { value: 30, label: "Within 30 days" },
  { value: 60, label: "Within 60 days" },
  { value: 90, label: "Within 90 days" },
];

export default function Filters({
  maxFloor,
  leaseTerms,
  focusBeds,
}: {
  maxFloor: number;
  /** Lease lengths any listed unit publishes a price for (empty = none do). */
  leaseTerms: number[];
  /** The bed counts the building opens pre-filtered to, if any. */
  focusBeds: number[] | null;
}) {
  const bedsFilter = useStore((s) => s.bedsFilter);
  const toggleBeds = useStore((s) => s.toggleBeds);
  const setBedsFilter = useStore((s) => s.setBedsFilter);
  const moveInWithin = useStore((s) => s.moveInWithin);
  const setMoveInWithin = useStore((s) => s.setMoveInWithin);
  const leaseTerm = useStore((s) => s.leaseTerm);
  const setLeaseTerm = useStore((s) => s.setLeaseTerm);
  const floorMin = useStore((s) => s.floorMin);
  const floorMax = useStore((s) => s.floorMax);
  const setFloorRange = useStore((s) => s.setFloorRange);

  // The lease-length choice hides nothing, but it re-prices the table: "show
  // everything" puts that back to the advertised rent too.
  const anyFilter =
    bedsFilter !== null ||
    moveInWithin !== null ||
    floorMin !== null ||
    floorMax !== null ||
    leaseTerm !== null;
  const focusBuckets = focusBeds ? [...new Set(focusBeds.map((b) => Math.min(b, 3)))] : null;

  return (
    <div className="filters">
      <button
        className={`chip${bedsFilter === null ? " on" : ""}`}
        onClick={() => setBedsFilter(null)}
        title="Show every bedroom count"
      >
        All beds
      </button>
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
        Move-in{" "}
        <select
          value={moveInWithin === null ? "any" : String(moveInWithin)}
          onChange={(e) =>
            setMoveInWithin(e.target.value === "any" ? null : Number(e.target.value))
          }
        >
          {MOVE_IN_OPTIONS.map((o) => (
            <option key={o.label} value={o.value === null ? "any" : String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {leaseTerms.length > 0 && (
        <label title="Price the table for a specific lease length (where the site publishes per-term prices)">
          Lease{" "}
          <select
            value={leaseTerm === null ? "site" : String(leaseTerm)}
            onChange={(e) => setLeaseTerm(e.target.value === "site" ? null : Number(e.target.value))}
          >
            <option value="site">As advertised</option>
            {leaseTerms.map((t) => (
              <option key={t} value={t}>
                {t} months
              </option>
            ))}
          </select>
        </label>
      )}
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
      {anyFilter && (
        <button
          className="chip"
          onClick={() => {
            setFloorRange(null, null);
            setBedsFilter(null);
            setMoveInWithin(null);
            setLeaseTerm(null);
          }}
        >
          ✕ show everything
        </button>
      )}
      {focusBuckets && bedsFilter === null && (
        <button className="chip" onClick={() => setBedsFilter(focusBuckets)}>
          ↺ my beds only
        </button>
      )}
    </div>
  );
}
