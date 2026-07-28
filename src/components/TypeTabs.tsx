import type { KeyboardEvent } from "react";

type ProgrammeType = "show" | "movie";

/**
 * Guide-style Shows/Movies tablist: hairline baseline, active tab underlined
 * in signal red, counts in mono. Roving tabindex with arrow/Home/End keys.
 */
export function TypeTabs({
  idPrefix,
  controls,
  ariaLabel,
  tab,
  counts,
  onSelect,
}: {
  idPrefix: string;
  controls: string;
  ariaLabel: string;
  tab: ProgrammeType;
  counts: Record<ProgrammeType, number>;
  onSelect: (next: ProgrammeType) => void;
}) {
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, current: ProgrammeType) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next: ProgrammeType = event.key === "Home" ? "show" : event.key === "End" ? "movie" : current === "show" ? "movie" : "show";
    onSelect(next);
    document.getElementById(`${idPrefix}-${next}`)?.focus();
  }

  return (
    <div className="flex gap-1 border-b" role="tablist" aria-label={ariaLabel}>
      {(["show", "movie"] as const).map((type) => (
        <button
          key={type}
          id={`${idPrefix}-${type}`}
          type="button"
          role="tab"
          tabIndex={tab === type ? 0 : -1}
          aria-selected={tab === type}
          aria-controls={controls}
          onKeyDown={(event) => keyDown(event, type)}
          onClick={() => onSelect(type)}
          className="relative -mb-px px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-transparent hover:text-foreground aria-selected:text-foreground aria-selected:after:bg-signal"
        >
          {type === "show" ? "Shows" : "Movies"}{" "}
          <span className="ml-1.5 rounded-[3px] bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] font-medium">{counts[type]}</span>
        </button>
      ))}
    </div>
  );
}
