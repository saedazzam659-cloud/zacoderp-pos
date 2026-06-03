import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  info: ErrorInfo | null;
}

// Global error boundary. React error boundaries MUST be class components.
// Without this, a single render error anywhere in the tree unmounts the whole
// app and leaves a blank white page. Here we instead show a recoverable Arabic
// screen that surfaces the real error message so it can be diagnosed.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    // Surface to the console so it shows up in browser devtools / logs.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught a render error:", error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleGoHome = () => {
    window.location.href = "/";
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const { error, info } = this.state;
    const details = [
      error?.message ? `الخطأ: ${error.message}` : "",
      error?.stack ? `\n${error.stack}` : "",
      info?.componentStack ? `\nComponent stack:${info.componentStack}` : "",
    ]
      .filter(Boolean)
      .join("");

    return (
      <div
        dir="rtl"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
          background: "#f8fafc",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Tahoma, Arial, sans-serif",
        }}
      >
        <div
          style={{
            maxWidth: "640px",
            width: "100%",
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: "16px",
            boxShadow: "0 10px 30px rgba(0,0,0,0.06)",
            padding: "32px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "48px", lineHeight: 1, marginBottom: "12px" }}>
            ⚠️
          </div>
          <h1
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: "#0f172a",
              margin: "0 0 8px",
            }}
          >
            حدث خطأ غير متوقع
          </h1>
          <p style={{ color: "#475569", margin: "0 0 20px", lineHeight: 1.7 }}>
            نعتذر عن هذا الخلل. بياناتك آمنة. يمكنك إعادة تحميل الصفحة أو العودة
            للرئيسية. إن استمرّ الخطأ، صوّر التفاصيل بالأسفل وأرسلها للدعم.
          </p>
          <div
            style={{
              display: "flex",
              gap: "12px",
              justifyContent: "center",
              marginBottom: "20px",
              flexWrap: "wrap",
            }}
          >
            <button
              onClick={this.handleReload}
              style={{
                background: "#059669",
                color: "#fff",
                border: "none",
                borderRadius: "10px",
                padding: "10px 20px",
                fontSize: "15px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              إعادة تحميل الصفحة
            </button>
            <button
              onClick={this.handleGoHome}
              style={{
                background: "#fff",
                color: "#0f172a",
                border: "1px solid #cbd5e1",
                borderRadius: "10px",
                padding: "10px 20px",
                fontSize: "15px",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              العودة للرئيسية
            </button>
          </div>
          {details && (
            <pre
              dir="ltr"
              style={{
                textAlign: "left",
                background: "#0f172a",
                color: "#e2e8f0",
                borderRadius: "10px",
                padding: "16px",
                fontSize: "12px",
                lineHeight: 1.6,
                overflow: "auto",
                maxHeight: "240px",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                margin: 0,
              }}
            >
              {details}
            </pre>
          )}
        </div>
      </div>
    );
  }
}
