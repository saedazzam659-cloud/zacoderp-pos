import * as React from "react"

import { cn } from "@/lib/utils"
import { useTranslation } from "react-i18next"
import { localizeUiText } from "@/lib/localizedUiText"

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, placeholder, title, "aria-label": ariaLabel, ...props }, ref) => {
  useTranslation()
  return (
    <textarea
      className={cn(
        "flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className
      )}
      ref={ref}
      {...props}
      placeholder={placeholder ? localizeUiText(placeholder) : placeholder}
      title={title ? localizeUiText(title) : title}
      aria-label={ariaLabel ? localizeUiText(ariaLabel) : ariaLabel}
    />
  )
})
Textarea.displayName = "Textarea"

export { Textarea }
