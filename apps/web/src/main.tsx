import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./app.css";
import { bootLanguage } from "./lib/appInfo";

const queryClient = new QueryClient();

// Language first, then the app: `App` is imported only afterwards, so texts that modules translate
// while loading (`t()` in constants) already use the chosen language.
async function start(): Promise<void> {
  await bootLanguage();
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
