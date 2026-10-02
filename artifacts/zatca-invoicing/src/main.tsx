import { createRoot } from "react-dom/client";
import { HelmetProvider } from "react-helmet-async";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";
import i18n, { normalizeLang } from "./i18n";
// Load public host branding on every entry route, including unauthenticated and
// deep-linked pages that never mount the logged-in Layout.
import "./lib/agentBranding";

const originalFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  let url: URL;
  try {
    url = new URL(requestUrl, window.location.href);
  } catch {
    return originalFetch(input, init);
  }

  if (
    url.origin !== window.location.origin ||
    !/\/api(?:\/|$)/.test(url.pathname)
  ) {
    return originalFetch(input, init);
  }

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  headers.set("X-App-Language", normalizeLang(i18n.language));
  return originalFetch(input, { ...init, headers });
};

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
