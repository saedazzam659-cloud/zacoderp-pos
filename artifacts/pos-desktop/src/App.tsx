import { useState, useEffect } from "react";
import Activation from "./pages/Activation";
import PosShell from "./pages/PosShell";

export default function App() {
  const [activated, setActivated] = useState<boolean | null>(null);

  useEffect(() => {
    // TODO Step 8: read deviceToken from Tauri store / keyring and call /validate
    const t = localStorage.getItem("device_token_dev_stub");
    setActivated(!!t);
  }, []);

  if (activated === null) return <div style={{ padding: 40 }}>جاري التحقق...</div>;
  return activated ? <PosShell /> : <Activation onActivated={() => setActivated(true)} />;
}
