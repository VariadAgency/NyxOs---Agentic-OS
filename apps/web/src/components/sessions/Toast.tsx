export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastProps {
  message: string | null;
  /** Knopf im Toast, z. B. "Rückgängig" nach einer Korrektur. */
  action?: ToastAction | null;
}

export function Toast({ message, action }: ToastProps) {
  if (!message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="cc-toast cc-above-tabbar fixed bottom-[calc(var(--a-demo-bar-h)+20px)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-md border border-a-line bg-a-p3 px-4 py-2 text-caption text-a-ink shadow-lg"
    >
      <span>{message}</span>
      {action && (
        <button type="button" className="font-semibold text-a-acc underline" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}
