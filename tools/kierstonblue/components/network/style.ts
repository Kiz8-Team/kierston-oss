/**
 * The tower map's own chrome.
 *
 * Same reason components/map/panel.ts exists: these dress markup the map hands
 * to Leaflet as HTML strings, or structural elements the panel styles in
 * place. A class that only ever appears interpolated into a template literal
 * is a class Tailwind never emits, so every one of them is written out whole
 * here and referenced by name.
 */

/**
 * The tracking-area caption dropped at the centre of each area's hull.
 *
 * Absolutely positioned and `w-max`: a divIcon sized [0, 0] gives its contents
 * no width to lay out in, so a block child would wrap every word onto its own
 * line. Sizing to the content and then pulling back by half of it is what puts
 * the caption on the point rather than beside it.
 */
export const AREA_LABEL = "absolute w-max -translate-x-1/2 -translate-y-1/2 rounded-[3px] border "
  + "border-black/10 bg-white/85 px-[0.3rem] py-[0.05rem] text-center font-sans "
  + "text-[10.5px] leading-[1.3] font-semibold whitespace-nowrap text-[#20303f] "
  + "shadow-[0_1px_4px_rgb(20_30_40/25%)]";

/** A row in the selected structure's cell list. */
export const CELL_ROW = "grid w-full cursor-pointer grid-cols-[0.5rem_1fr_auto] "
  + "items-center gap-[0.4rem] -mx-[0.35rem] rounded-[3px] border-0 bg-transparent "
  + "px-[0.35rem] py-[0.15rem] text-start text-[0.72rem] "
  + "hover:bg-[var(--accent-tint)] focus-visible:bg-[var(--accent-tint)] "
  + "aria-[current=true]:bg-[var(--accent-tint)]";

export const CELL_DOT = "size-[0.5rem] rounded-[2px]";

/** The identifier column — a CGI is reference data and reads as such. */
export const CELL_META = "font-sans text-[11px] text-muted-foreground tabular-nums";

/** Facts about the selected thing: label left, value right. */
export const SELECTED_FACTS = "mt-[0.35rem] grid gap-[0.2rem] "
  + "[&>div]:flex [&>div]:justify-between [&>div]:gap-3 [&>div]:text-[0.73rem] "
  + "[&>div>span:first-child]:shrink-0 [&>div>span:first-child]:text-muted-foreground "
  + "[&>div>span:last-child]:min-w-0 [&>div>span:last-child]:text-end "
  + "[&>div>span:last-child]:[overflow-wrap:anywhere]";

/** The heading over the selection, with its close button on the same line. */
export const SELECTED_HEAD = "flex items-baseline justify-between gap-2";

export const SELECTED_TITLE = "text-[0.82rem] font-semibold";

export const SELECTED_KIND = "text-[0.68rem] tracking-[0.04em] text-muted-foreground uppercase";

/** A tracking-area row: checkbox, colour, name, counts. */
export const AREA_ROW = "grid min-h-[1.6rem] grid-cols-[auto_0.75rem_1fr_auto_auto] "
  + "items-center gap-[0.45rem] text-[0.75rem] hover:bg-[var(--accent-tint)] "
  + "[&>label]:contents [&>label]:cursor-pointer [&_input]:m-0";

/** The little "go here" button on a tracking-area row. */
export const AREA_GO = "grid size-5 cursor-pointer place-items-center rounded-[3px] "
  + "border-0 bg-transparent text-[0.7rem] leading-none text-muted-foreground "
  + "hover:bg-[var(--accent-tint)] hover:text-foreground";
