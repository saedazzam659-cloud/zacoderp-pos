import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SUPPORTED_LANGUAGES, setAppLanguage, normalizeLang } from "@/i18n";

interface LanguageSwitcherProps {
  variant?: "icon" | "compact";
}

export function LanguageSwitcher({ variant = "icon" }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation();
  const currentCode = normalizeLang(i18n.language);
  const current = SUPPORTED_LANGUAGES.find(l => l.code === currentCode) ?? SUPPORTED_LANGUAGES[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={variant === "icon" ? "icon" : "sm"}
          className={variant === "icon" ? "h-9 w-9" : "h-9 gap-2 px-2"}
          aria-label={t("common.language")}
        >
          <Languages className="h-4 w-4" />
          {variant === "compact" && (
            <span className="text-xs font-medium uppercase">{current.code}</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuLabel>{t("common.language")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {SUPPORTED_LANGUAGES.map(lang => (
          <DropdownMenuItem
            key={lang.code}
            onClick={() => setAppLanguage(lang.code)}
            className="flex items-center justify-between gap-3 cursor-pointer"
          >
            <span>{lang.label}</span>
            {currentCode === lang.code && (
              <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
