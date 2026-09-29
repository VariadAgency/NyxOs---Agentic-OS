import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./app.css";
import { APP_INFO_KEY, bootLanguage } from "./lib/appInfo";
import { installErrorLog } from "./features/support/diagnostics";

const queryClient = new QueryClient();

// Language first, then the app: `App` is imported only afterwards, so texts that modules translate
// while loading (`t()` in constants) already use the chosen language.
async function start(): Promise<void> {
  // The last few browser errors, for "Diagnose anhängen" in a bug report (memory only, never sent by itself).
  installErrorLog();
  const info = await bootLanguage();
  // The first render already knows the run mode (local mode hides server-only settings without a flicker).
  if (info) queryClient.setQueryData(APP_INFO_KEY, info);
  const { App } = await import("./App");
  const root = document.getElementById("root");
  if (!root) return;
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
