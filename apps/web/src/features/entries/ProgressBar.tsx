interface ProgressBarProps {
  percent: number;
  color?: "acc" | "done";
  className?: string;
}

/** Fortschrittsbalken, Breite animiert sich (keine Layout-Sprünge, s. app.css `.cc-progress-fill`). */
export function ProgressBar({ percent, color = "acc", className }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={`h-1.5 flex-1 overflow-hidden rounded-full bg-a-p3 ${className ?? ""}`}>
      <div
        className={`cc-progress-fill h-full rounded-full ${color === "done" ? "bg-a-done" : "bg-a-acc"}`}
        style={{ width: `${clamped}%` }}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  );
}
