import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import "./i18n";

// A full-agent update swaps the built frontend while users may still have the
// previous shell open. If that shell requests a lazy chunk after the swap,
// reload once so Vite resolves the screen from the new index instead of
// leaving the user on a blank page. A repeated failure is allowed to reach the
// global ErrorBoundary, avoiding an infinite reload loop.
window.addEventListener("vite:preloadError", (event) => {
  const key = "zacod_chunk_recovery_at";
  const lastRecovery = Number(sessionStorage.getItem(key) ?? "0");
  if (Date.now() - lastRecovery < 30_000) return;
  event.preventDefault();
  sessionStorage.setItem(key, String(Date.now()));
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <HelmetProvider>
      <App />
    </HelmetProvider>
  </ErrorBoundary>,
);
