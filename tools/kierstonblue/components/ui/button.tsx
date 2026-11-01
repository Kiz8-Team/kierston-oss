import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 text-[0.76rem] font-medium whitespace-nowrap no-underline transition-colors outline-none hover:no-underline focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border border-rule bg-primary text-primary-foreground hover:bg-primary/85",
        destructive:
          "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20",
        outline:
          "border border-rule bg-background hover:bg-primary hover:text-primary-foreground",
        secondary:
          "border border-[var(--border-strong)] bg-background hover:border-rule",
        ghost: "hover:bg-accent",
        link: "underline underline-offset-[3px]",
      },
      size: {
        default: "h-7 px-3 has-[>svg]:px-2.5",
        xs: "h-5 gap-1 px-1.5 text-[0.7rem] has-[>svg]:px-1 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-6 gap-1.5 px-2 has-[>svg]:px-1.5",
        lg: "h-8 px-5 has-[>svg]:px-3.5",
        icon: "size-7",
        "icon-xs": "size-5 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6",
        "icon-lg": "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
