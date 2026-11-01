import { cn } from "@/lib/utils";

/**
 * A run of the page under a heading.
 *
 * Not a box — a page of a dozen sections drawn as boxes is a dozen frames to
 * read past. It is the site's heading instead: a semibold title with its count
 * pushed to the right margin, sitting on a black rule. The headings all land
 * on the same left edge down the page, which is what makes a long screen
 * scannable.
 */
export function Section({
  title,
  meta,
  children,
  className,
}: {
  title: React.ReactNode;
  /** The count that qualifies the heading — how many, how long, how recent. */
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-10 first:mt-0", className)}>
      <div className="flex items-baseline gap-3 border-b border-rule pb-1.5">
        <h2 className="m-0 text-[1.05rem] font-semibold">{title}</h2>
        {meta ? (
          <span className="ml-auto text-[0.76rem] text-muted-foreground tabular-nums">
            {meta}
          </span>
        ) : null}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/**
 * The columns a section's contents run in.
 *
 * Charts need a measure — a bar list across ninety rems is unreadable — and
 * that measure comes from the column width. The gutter is wide enough that
 * two charts side by side never read as one.
 */
export function Grid({
  min = "22rem",
  className,
  children,
}: {
  /** Narrowest a column may get before the grid drops to fewer of them. */
  min?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn("grid gap-x-10 gap-y-8", className)}
      style={{ gridTemplateColumns: `repeat(auto-fit,minmax(${min},1fr))` }}
    >
      {children}
    </div>
  );
}

/**
 * One figure, chart or table inside a section, under its own name.
 *
 * A block is not a panel: its chrome is a name and the hairline under it. That
 * hairline is what stops a grid of charts reading as one pile — every block in
 * a row starts on the same line, so the eye can see where each begins without
 * anything being boxed.
 *
 * The name is a small semibold heading, the site's `h3`: the figure below it
 * is the thing being read.
 */
export function Block({
  title,
  meta,
  className,
  children,
  /** Run across every column of the grid — for tiles and wide tables. */
  wide = false,
}: {
  title?: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("min-w-0", wide && "col-span-full", className)}>
      {title ? (
        <div className="mb-3 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-border pb-1">
          <h3 className="m-0 text-[0.85rem] font-semibold">{title}</h3>
          {meta ? (
            <span className="text-[0.74rem] leading-none text-muted-foreground tabular-nums">
              {meta}
            </span>
          ) : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}
