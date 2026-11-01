import { cn } from "@/lib/utils";

/**
 * A row of headline figures, drawn as a bank of cells.
 *
 * Six figures separated by whitespace read as one long sentence of numbers.
 * Boxing them in a single frame with shared hairlines makes each one an
 * addressable cell instead: the eye can land on the third figure without
 * counting the first two. Cells share their edges, so a wrapped row leaves no
 * double rule anywhere.
 *
 * The label sits above the figure. On an instrument you read the value, and
 * the caption is what you check afterwards to be sure of what it was — over
 * six cells that order is what stops the row becoming a paragraph.
 *
 * `compact` drops the frame and shrinks the figures, for the 23rem detail
 * panel, where a bank of cells inside a panel would be a box in a box.
 */
export function Tiles({
  children,
  compact = false,
  className,
}: {
  children: React.ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap",
        compact
          ? "mb-4 gap-x-6 gap-y-3"
          : "border-t border-l border-border bg-background "
            + "[&>[data-slot=tile]]:min-w-[8.5rem] [&>[data-slot=tile]]:flex-1 "
            + "[&>[data-slot=tile]]:border-r [&>[data-slot=tile]]:border-b "
            + "[&>[data-slot=tile]]:border-border [&>[data-slot=tile]]:px-3 "
            + "[&>[data-slot=tile]]:py-2",
        compact && "[&_[data-slot=tile]>strong]:text-[1.02rem]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One figure and what it counts. */
export function Tile({
  value,
  children,
  className,
}: {
  value: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="tile" className={className}>
      <span className="micro block max-w-[12rem] truncate">{children}</span>
      <strong className="mt-1.5 block text-[1.3rem] leading-none font-semibold tracking-[-0.01em] tabular-nums">
        {value}
      </strong>
    </div>
  );
}
