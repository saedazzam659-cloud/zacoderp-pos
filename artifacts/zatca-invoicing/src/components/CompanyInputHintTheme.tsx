import { useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";

export default function CompanyInputHintTheme() {
  const { user } = useAuth();
  const company = user?.company;

  useEffect(() => {
    const color = String(company?.inputHintColor ?? "#64748b");
    if (company?.inputHintColorsEnabled === true && /^#[0-9a-fA-F]{6}$/.test(color)) {
      document.documentElement.style.setProperty("--company-input-hint-color", color);
    } else {
      document.documentElement.style.removeProperty("--company-input-hint-color");
    }
    return () => { document.documentElement.style.removeProperty("--company-input-hint-color"); };
  }, [company?.inputHintColorsEnabled, company?.inputHintColor]);

  return null;
}
