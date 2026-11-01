/**
 * The chrome shared by the two map pages — the explorer and the pathfinder.
 *
 * These are class strings rather than components because most of what they
 * dress is structural markup the pages already own: a `<fieldset>` per layer
 * group, a `<dl>` of counts, a `<label>` wrapping a checkbox. Styling those in
 * place through the panel keeps one description of what a layer row looks like
 * without wrapping every element in a component that adds nothing else.
 */

export const MAP_SHELL = "absolute inset-0";

/** The map's own backdrop, showing while tiles are still coming in. */
export const MAP_SURFACE = "absolute inset-0 bg-[#dfe7e7]";

/**
 * Frosted rather than flat white: the panel sits on top of the map, and a hint
 * of what is behind it is what says so.
 *
 * Below 51.25rem it drops its right anchor and becomes a sheet across the
 * bottom, because 19.5rem beside a phone-width map leaves no map.
 */
export const MAP_PANEL = "absolute top-4 right-4 bottom-4 z-[900] flex w-[19.5rem] "
  + "flex-col overflow-hidden rounded-[var(--radius)] border border-border "
  + "bg-[color-mix(in_srgb,var(--card)_92%,transparent)] backdrop-blur-[8px] "
  + "shadow-[var(--shadow-float)] "
  + "max-[51.25rem]:top-auto max-[51.25rem]:left-4 max-[51.25rem]:w-auto "
  + "max-[51.25rem]:max-h-[60%] "
  // Header
  + "[&>header]:border-b [&>header]:border-border [&>header]:bg-secondary "
  + "[&>header]:px-4 [&>header]:pt-[0.8rem] [&>header]:pb-[0.55rem] "
  + "[&>header_h1]:text-[0.95rem] "
  + "[&>header_p]:mt-[0.15rem] [&>header_p]:text-[0.74rem] [&>header_p]:text-muted-foreground "
  // Each fieldset is a layer group, and the legends are the panel's table of
  // contents — set apart from the rows under them rather than reading as the
  // first of them.
  + "[&_fieldset]:mt-3 [&_fieldset]:border-0 [&_fieldset]:border-t "
  + "[&_fieldset]:border-border [&_fieldset]:pt-[0.7rem] "
  + "[&_fieldset:first-of-type]:mt-[0.4rem] [&_fieldset:first-of-type]:border-t-0 "
  + "[&_legend]:p-0 [&_legend]:text-[0.68rem] [&_legend]:font-bold "
  + "[&_legend]:tracking-[0.06em] [&_legend]:text-muted-foreground [&_legend]:uppercase "
  // Counts read as figures, with labels visually separated.
  + "[&_dt]:text-[0.68rem] [&_dt]:tracking-[0.04em] [&_dt]:text-muted-foreground "
  + "[&_dt]:uppercase [&_dd]:m-0 [&_dd]:font-sans [&_dd]:text-[12px]";

export const PANEL_SCROLL = "overflow-y-auto overscroll-contain px-4 pb-4";

export const PANEL_STATS = "mt-2 grid gap-[0.28rem] "
  + "[&>div]:flex [&>div]:justify-between [&>div]:gap-4";

export const PANEL_ACTIONS = "mt-[0.45rem] mb-[0.55rem] flex flex-wrap items-center gap-[0.4rem]";

export const PANEL_NOTE = "mt-[0.35rem] text-[0.7rem] text-muted-foreground "
  + "data-[state=error]:text-destructive";

export const PANEL_FIELD = "mt-[0.55rem] grid gap-[0.25rem] "
  + "[&>span]:text-[0.66rem] [&>span]:font-semibold [&>span]:tracking-[0.04em] "
  + "[&>span]:text-muted-foreground [&>span]:uppercase "
  + "[&_input[type=range]]:w-full";

/**
 * A layer toggle: a checkbox with a colour key and a count either side.
 *
 * A pointer over one should say which one it is about to toggle, hence the
 * wash — the row is the hit area, not just the box.
 */
export const LAYER_ROW = "grid min-h-[1.6rem] cursor-pointer grid-cols-[auto_1.1rem_1fr_auto] "
  + "items-center gap-[0.45rem] -mx-[0.35rem] rounded-[3px] px-[0.35rem] "
  + "text-[0.75rem] hover:bg-[var(--accent-tint)] [&_input]:m-0";

/** A layer that is switched on but currently below the zoom's detail cut. */
export const MUTED_ROW = "opacity-55";

export const SWATCH = "h-[0.4rem] rounded-[2px]";

export const COUNT = "font-sans text-[11.5px] text-muted-foreground";

export const POI_GROUP = "grid min-h-[1.5rem] grid-cols-[auto_0.75rem_1fr_auto_auto] "
  + "items-center gap-[0.45rem] text-[0.75rem] hover:bg-[var(--accent-tint)] "
  + "[&>label]:contents [&>label]:cursor-pointer";

export const POI_DOT = "size-[0.7rem] rounded-full border border-black/25";

export const POI_TYPE = "grid min-h-[1.5rem] cursor-pointer grid-cols-[auto_1fr_auto] "
  + "items-center gap-[0.45rem] -mx-[0.35rem] rounded-[3px] pe-[0.35rem] ps-[1.7rem] "
  + "text-[0.75rem] text-muted-foreground hover:bg-[var(--accent-tint)] [&_input]:m-0";

export const POI_TYPES = "mb-[0.25rem]";

export const CARET = "grid size-6 cursor-pointer place-items-center border-0 bg-transparent "
  + "text-[0.7rem] leading-none text-muted-foreground hover:text-foreground";

export const RAMP = "mt-2 flex h-[0.55rem] overflow-hidden rounded-[3px] [&>i]:flex-1";

export const RAMP_LABELS = "mt-[0.22rem] flex justify-between font-sans text-[11.5px] "
  + "text-muted-foreground";

export const ROUTE_FIELD = "mt-[0.45rem] grid grid-cols-[1.15rem_1fr_auto] items-center "
  + "gap-[0.4rem]";

/** The A/B badge beside a waypoint field. */
export const ROUTE_FIELD_PIN = "grid size-[1.15rem] place-items-center rounded-full "
  + "text-[0.62rem] font-bold text-white";

/**
 * The A/B marker on the map itself.
 *
 * Built as an HTML string for a Leaflet divIcon, so these classes have to sit
 * in a literal Tailwind can see — which is why this is a const and not an
 * interpolated string at the call site.
 */
export const ROUTE_PIN = "grid size-[1.4rem] -mt-[0.7rem] -ml-[0.7rem] place-items-center "
  + "rounded-full border-2 border-white font-sans text-[0.68rem] font-bold leading-none "
  + "text-white shadow-[0_1px_6px_rgb(20_30_40/45%)]";

export const ENDPOINTS = "mt-[0.6rem] text-[0.7rem] text-muted-foreground "
  + "[&>div]:mt-[0.2rem] [&_b]:font-semibold [&_b]:text-foreground";

export const STEPS = "mt-[0.55rem] list-none p-0 "
  + "[&>li]:border-t [&>li]:border-muted [&>li:first-child]:border-t-0";

/** A real button, so a step can be reached by Tab and fired by Enter. */
export const STEP_BUTTON = "grid min-h-[1.5rem] w-full cursor-pointer "
  + "grid-cols-[1.1rem_1fr_auto] gap-[0.45rem] border-0 bg-transparent py-[0.32rem] "
  + "text-start text-[0.74rem] hover:bg-[var(--accent-tint)] "
  + "focus-visible:bg-[var(--accent-tint)]";

export const STEP_GLYPH = "text-center text-[0.85rem] leading-[1.2] text-primary";

export const STEP_DISTANCE = "font-sans text-[11.5px] text-muted-foreground";
