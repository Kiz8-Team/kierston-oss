import { cn } from "@/lib/utils";

/**
 * The console's furniture: a panel and the small-caps label.
 *
 * A panel is a bordered surface and nothing else — square corners, one
 * hairline, no shadow, no tone. Regions are told apart by the rule between
 * them.
 */

export function Panel({
  flush = false,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  /** No padding — for a panel whose child owns its own scroll box. */
  flush?: boolean;
}) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "flex min-h-0 min-w-0 flex-col overflow-hidden",
        "border border-border bg-card",
        !flush && "p-3",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** A small uppercase label — a section title, a field name, a column head. */
export function Micro({
  className,
  children,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span className={cn("micro", className)} {...props}>
      {children}
    </span>
  );
}
