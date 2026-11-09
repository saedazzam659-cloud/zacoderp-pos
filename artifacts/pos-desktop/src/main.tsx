import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import LanguageControl from "./components/LanguageControl";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
    <LanguageControl hideInSystem />
  </>,
);
