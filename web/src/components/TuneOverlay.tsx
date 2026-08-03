import { useState } from "react";
import type { UnitMapping } from "../../../shared/src/types";

export interface TuneClick {
  facing: string;
  u: number;
  floor: number | null;
}

/**
 * Dev tool (?tune=1): clicking the tower's facade prints a ready-to-paste
 * stacks entry for buildings.json, so refining unit positions takes seconds.
 */
export default function TuneOverlay({
  mapping,
  lastClick,
  selectedStack,
}: {
  mapping: UnitMapping | undefined;
  lastClick: TuneClick | null;
  selectedStack: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const stackKey = selectedStack ?? "??";
  const snippet = lastClick
    ? `"${stackKey}": { "facing": "${lastClick.facing}", "u": ${lastClick.u.toFixed(2)} }`
    : null;

  return (
    <div className="tune-overlay">
      <strong>Mapping tune mode</strong>
      <div style={{ opacity: 0.8, margin: "4px 0" }}>
        Select a unit row (its stack becomes the key), then click the facade
        where that stack lives.
      </div>
      {snippet ? (
        <>
          <pre>{snippet}</pre>
          <button
            onClick={() => {
              void navigator.clipboard.writeText(snippet).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
          {lastClick?.floor !== null && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>clicked floor {lastClick?.floor}</span>
          )}
        </>
      ) : (
        <div style={{ opacity: 0.6 }}>no facade click yet</div>
      )}
      <div style={{ marginTop: 8, opacity: 0.75 }}>
        {Object.keys(mapping?.stacks ?? {}).length} stacks currently mapped
      </div>
    </div>
  );
}
