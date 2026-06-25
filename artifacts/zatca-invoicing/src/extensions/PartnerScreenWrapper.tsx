import { useMemo } from "react";
import { buildScreenUrl } from "./registry";

// ─────────────────────────────────────────────────────────────────────────
// PartnerScreenWrapper — the ONLY surface through which partner UI renders.
//
// Hard isolation guarantees:
//   • A `sandbox` attribute WITHOUT `allow-same-origin` → the iframe gets an
//     opaque origin. It cannot read the host DOM, cookies, or localStorage,
//     and the host cannot read its internals. Partner code never sees the
//     core source.
//   • Only `allow-scripts` is granted (forms optional) — no top-navigation,
//     no popups, no same-origin escape hatch.
//   • The bearer token rides in the URL (the backend shims it back into auth)
//     so the iframe can call its own gated /api/ext/<id>/api/* namespace.
// ─────────────────────────────────────────────────────────────────────────
export default function PartnerScreenWrapper({
  extensionId,
  screenKey,
  title,
  className,
}: {
  extensionId: string;
  screenKey: string;
  title?: string;
  className?: string;
}) {
  const src = useMemo(() => buildScreenUrl(extensionId, screenKey), [extensionId, screenKey]);
  return (
    <iframe
      key={src}
      src={src}
      title={title ?? `${extensionId}:${screenKey}`}
      // No `allow-same-origin` — keeps the iframe on an opaque origin (full
      // isolation). `allow-scripts` + `allow-forms` is all a partner screen
      // needs; everything else stays denied.
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      className={className ?? "w-full h-full min-h-[70vh] border-0 bg-white"}
      data-testid={`ext-iframe-${extensionId}-${screenKey}`}
    />
  );
}
