import React from "react";

type Props = { children: React.ReactNode };
type State = { hasError: boolean; message: string };

/**
 * Root error boundary. Guarantees the user NEVER sees a blank white screen on a
 * render-time error: instead of an empty page they get a clear Arabic message
 * and a reload button. Logs the error to the console for debugging.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  componentDidCatch(err: unknown, info: unknown) {
    console.error("[pos-desktop] render error caught by ErrorBoundary:", err, info);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div
        dir="rtl"
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          padding: 24,
          textAlign: "center",
          fontFamily: "system-ui, 'Segoe UI', Tahoma, sans-serif",
          background: "#0f172a",
          color: "#e2e8f0",
        }}
      >
        <div style={{ fontSize: 48 }}>⚠️</div>
        <h1 style={{ fontSize: 22, margin: 0, fontWeight: 700 }}>
          حدث خطأ غير متوقع
        </h1>
        <p style={{ margin: 0, color: "#94a3b8", maxWidth: 480, lineHeight: 1.7 }}>
          واجه التطبيق مشكلة أثناء العرض. بياناتك المحفوظة محلياً آمنة. جرّب
          إعادة التحميل — وإن استمرت المشكلة أعد تشغيل التطبيق.
        </p>
        <button
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: "10px 28px",
            fontSize: 16,
            fontWeight: 600,
            color: "#fff",
            background: "#2563eb",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          إعادة تحميل
        </button>
        {this.state.message ? (
          <pre
            style={{
              marginTop: 12,
              maxWidth: 560,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              color: "#64748b",
              direction: "ltr",
            }}
          >
            {this.state.message}
          </pre>
        ) : null}
      </div>
    );
  }
}
