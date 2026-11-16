import { useEffect, useRef, useState } from "react";
import { money } from "../lib/format";
import { useStore } from "../state/store";
import { MARK_COLORS, type LegendModel, type LegendRowKind } from "./unitMarks";

/** Below this panel width the legend starts folded: the tower needs the room. */
const NARROW_PANEL_PX = 440;

/** The same shapes the scene draws, small. Neutral ink: colour means size, and that is the rows above. */
function Glyph({ kind }: { kind: LegendRowKind }) {
  const frame = { x: 5.8, y: 2.3, width: 10.4, height: 7.4, fill: "none", strokeWidth: 1.6 };
  let shape;
  switch (kind) {
    case "now":
      shape = <rect x={5} y={1.5} width={12} height={9} fill="currentColor" />;
      break;
    case "later":
      shape = <rect {...frame} stroke="currentColor" fill="currentColor" fillOpacity={0.16} />;
      break;
    case "approx":
      shape = (
        <>
          <rect x={7} y={2} width={8} height={8} fill="currentColor" />
          <path d="M1.5 6H7M15 6h5.5M1.5 3.5v5M20.5 3.5v5" stroke="currentColor" strokeWidth={1.3} />
        </>
      );
      break;
    case "belt":
      shape = (
        <path d="M0.5 6h5M8.5 6h5M16.5 6h5" stroke="currentColor" strokeWidth={3.2} />
      );
      break;
    case "riser":
      shape = <rect x={9} y={0} width={4} height={12} fill="currentColor" />;
      break;
    case "hatch":
      shape = (
        <>
          <path
            d="M6 9.5l4-7M9.6 9.5l4-7M13.2 9.5l2.6-4.6"
            stroke="currentColor"
            strokeWidth={1.5}
          />
          <rect {...frame} stroke="currentColor" />
        </>
      );
      break;
    case "muted":
      shape = (
        <rect {...frame} stroke={MARK_COLORS.muted} strokeWidth={1.4} fill="#fff" fillOpacity={0.3} />
      );
      break;
    case "ghost":
      shape = <rect x={5} y={1.5} width={12} height={9} fill="currentColor" fillOpacity={0.24} />;
      break;
  }
  return (
    <svg className="scene-legend-glyph" width={22} height={12} viewBox="0 0 22 12" aria-hidden="true">
      {shape}
    </svg>
  );
}

/**
 * What the marks on the tower mean, for THIS building: a row per size with
 * its count and lowest rent, then only the kinds of mark that occur. An HTML
 * overlay in the scene panel's top-left corner (the compass keeps the right).
 */
export default function MarksLegend({ model }: { model: LegendModel }) {
  const legendOpen = useStore((s) => s.legendOpen);
  const setLegendOpen = useStore((s) => s.setLegendOpen);
  const root = useRef<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);

  // Folded by default on a narrow panel (a phone); the reader's own choice wins from then on.
  useEffect(() => {
    const panel = root.current?.parentElement;
    if (!panel) return;
    const measure = () => setNarrow(panel.clientWidth < NARROW_PANEL_PX);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  const open = legendOpen ?? !narrow;
  return (
    <div ref={root} className={`scene-legend${open ? " open" : ""}`}>
      <button
        type="button"
        className="scene-legend-head"
        aria-expanded={open}
        title={open ? "Hide the legend" : "What the marks on the tower mean"}
        onClick={() => setLegendOpen(!open)}
      >
        <span className="scene-legend-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        Listed units
        <span className="scene-legend-n">{model.listed}</span>
      </button>
      {open && (
        <div className="scene-legend-body">
          <ul className="scene-legend-sizes">
            {model.sizes.map((s) => (
              <li
                key={s.bucket}
                className={s.shown === 0 ? "off" : undefined}
                title={
                  s.shown === s.count
                    ? `${s.count} listed, lowest advertised rent ${money(s.from)}`
                    : `${s.count} listed, lowest advertised rent ${money(s.from)} — ${s.shown} in the current filter, the rest are drawn grey`
                }
              >
                <span className="scene-legend-chip" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="scene-legend-n">{s.count}</span>
                <span className="scene-legend-from">from {money(s.from)}</span>
              </li>
            ))}
          </ul>
          {model.rows.length > 0 && (
            <ul className="scene-legend-kinds">
              {model.rows.map((r) => (
                <li key={r.kind} title={r.title}>
                  <Glyph kind={r.kind} />
                  <span>{r.text}</span>
                  {r.count !== null && <span className="scene-legend-n">{r.count}</span>}
                </li>
              ))}
            </ul>
          )}
          {model.unplaced && (
            <div className="scene-legend-note">
              {model.unplaced.count} not shown on the tower
              {model.unplaced.reasons.length > 0 ? `: ${model.unplaced.reasons.join("; ")}` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
