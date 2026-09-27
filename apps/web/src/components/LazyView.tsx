// Hülle für nachgeladene Ansichten (Finder, Gehirn – `lazy()` in `App.tsx`).
// Während des Ladens eine ruhige Platzhalter-Fläche; scheitert das Laden (z. B. altes Bundle nach einem Deploy,
// Netz weg), steht ein Hinweis mit „Neu laden“ da – statt dass die ganze App weiß wird.
import { t } from "@nyxos/shared";
import { Component, Suspense, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";

class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("View could not be loaded", error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mx-auto grid max-w-md place-items-center gap-3 px-4 py-16 text-center">
        <p className="text-headline text-a-ink">{t("Diese Ansicht konnte nicht geladen werden.")}</p>
        <p className="text-callout text-a-mut">{t("Meist hilft neu laden – zum Beispiel nach einer neuen Version von NyxOS.")}</p>
        <Button onClick={() => window.location.reload()}>{t("Neu laden")}</Button>
      </div>
    );
  }
}

function Loading() {
  return (
    <div aria-busy="true" aria-label={t("Lädt …")} className="grid gap-3 p-4 sm:p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function LazyView({ children }: { children: ReactNode }) {
  return (
    <LoadBoundary>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </LoadBoundary>
  );
}
