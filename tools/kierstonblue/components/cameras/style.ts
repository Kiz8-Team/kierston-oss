export const CAMERA_LABEL = "absolute w-max -translate-x-1/2 -translate-y-1/2 rounded-[3px] "
  + "border border-black/10 bg-white/85 px-[0.3rem] py-[0.05rem] text-center font-sans "
  + "text-[10.5px] leading-[1.3] font-semibold whitespace-nowrap text-[#20303f] "
  + "shadow-[0_1px_4px_rgb(20_30_40/25%)]";

export const CAMERA_ROW = "grid w-full cursor-pointer grid-cols-[0.5rem_1fr_auto] "
  + "items-center gap-[0.4rem] -mx-[0.35rem] rounded-[3px] border-0 bg-transparent "
  + "px-[0.35rem] py-[0.15rem] text-start text-[0.72rem] "
  + "hover:bg-[var(--accent-tint)] focus-visible:bg-[var(--accent-tint)] "
  + "aria-[current=true]:bg-[var(--accent-tint)]";

export const CAMERA_DOT = "size-[0.5rem] shrink-0 rounded-[2px]";

export const CAMERA_META = "font-sans text-[11px] text-muted-foreground tabular-nums";

export const LIST_ROW = "grid w-full cursor-pointer grid-cols-[0.5rem_1fr_auto] items-baseline "
  + "gap-x-[0.45rem] -mx-[0.35rem] rounded-[3px] border-0 bg-transparent px-[0.35rem] "
  + "py-[0.28rem] text-start hover:bg-[var(--accent-tint)] "
  + "focus-visible:bg-[var(--accent-tint)] aria-[current=true]:bg-[var(--accent-tint)]";

export const LIST_NAME = "truncate text-[0.75rem] leading-[1.25]";

export const LIST_SUB = "col-start-2 truncate font-sans text-[11px] leading-[1.3] "
  + "text-muted-foreground";

export const LIST_VALUE = "row-span-2 self-center text-end font-sans text-[11px] "
  + "tabular-nums text-muted-foreground";

export const LIST_SCROLL = "mt-[0.4rem] max-h-[24rem] overflow-y-auto overscroll-contain "
  + "border-t border-border pt-[0.2rem]";

export const SELECTED_FACTS = "mt-[0.35rem] grid gap-[0.2rem] "
  + "[&>div]:flex [&>div]:justify-between [&>div]:gap-3 [&>div]:text-[0.73rem] "
  + "[&>div>span:first-child]:shrink-0 [&>div>span:first-child]:text-muted-foreground "
  + "[&>div>span:last-child]:min-w-0 [&>div>span:last-child]:text-end "
  + "[&>div>span:last-child]:[overflow-wrap:anywhere]";

export const SELECTED_HEAD = "flex items-baseline justify-between gap-2";

export const SELECTED_TITLE = "text-[0.82rem] font-semibold";

export const SELECTED_KIND = "text-[0.68rem] tracking-[0.04em] text-muted-foreground uppercase";

export const SELECTED_NAV = "mt-[0.55rem] flex items-center justify-between gap-2";

export const STEP_LINK = "cursor-pointer rounded-[3px] border-0 bg-transparent px-[0.3rem] "
  + "py-[0.1rem] font-sans text-[11px] text-muted-foreground hover:bg-[var(--accent-tint)] "
  + "hover:text-foreground disabled:cursor-default disabled:opacity-40";

export const ROLE_ROW = "grid min-h-[1.6rem] grid-cols-[auto_0.75rem_1fr_auto] "
  + "items-center gap-[0.45rem] text-[0.75rem] hover:bg-[var(--accent-tint)] "
  + "[&>label]:contents [&>label]:cursor-pointer [&_input]:m-0";

export const CURVE = "mt-[0.5rem] block w-full overflow-visible";

export const CURVE_CAPTION = "mt-[0.3rem] flex justify-between font-sans text-[11px] "
  + "text-muted-foreground";

/**
 * The way out of the map and into one camera's reads.
 *
 * A button rather than a bare link: it is the only thing in this panel that
 * leaves the map, and everything around it is a filter that does not.
 */
export const READS_LINK = "mt-[0.5rem] flex w-full cursor-pointer items-center justify-between "
  + "gap-2 rounded-[3px] border border-border bg-transparent px-[0.45rem] py-[0.3rem] "
  + "text-[0.74rem] no-underline hover:bg-[var(--accent-tint)]";
