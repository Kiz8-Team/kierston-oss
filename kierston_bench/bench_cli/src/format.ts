/**
 * Terminal presentation: colour that disappears when it should, durations a
 * person can read, and the bars the run list is drawn with.
 */

export const COLOUR = process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  grey: 90,
  /** Subtle 256-colour charcoal used behind prose panels. */
  panel: "48;5;236",
} as const;

export type Colour = keyof typeof CODES;

export function paint(text: string, ...styles: Colour[]): string {
  if (!COLOUR || styles.length === 0) return text;
  return `\x1b[${styles.map((style) => CODES[style]).join(";")}m${text}\x1b[0m`;
}

export function invert(text: string): string {
  return COLOUR ? `\x1b[7m${text}\x1b[0m` : `> ${text}`;
}

/** Printable width, ignoring the escape sequences paint() added. */
export function width(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad or clip to an exact printable width, escapes preserved. */
export function fit(text: string, columns: number): string {
  const printable = width(text);
  if (printable <= columns) return text + " ".repeat(columns - printable);
  if (!COLOUR) return columns <= 1 ? text.slice(0, columns) : text.slice(0, columns - 1) + "…";
  // Walk the string, counting only printable characters, so a clipped cell
  // never cuts an escape sequence in half.
  let out = "";
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\x1b") {
      const end = text.indexOf("m", i);
      if (end !== -1) {
        out += text.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (seen >= columns - 1) break;
    out += text[i];
    seen += 1;
  }
  return out + "…\x1b[0m";
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function since(at: string | number | null | undefined): string {
  if (at === null || at === undefined) return "";
  const stamp = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(stamp)) return "";
  const ms = Date.now() - stamp;
  if (ms < 60_000) return "just now";
  return `${duration(ms)} ago`;
}

export function stamp(at: string | null | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().replace("T", " ").slice(0, 16);
}

/** A proportion drawn as a bar: `████░░░░░░`. */
export function bar(fraction: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export function percent(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;
}

const STATUS_COLOURS: Record<string, Colour> = {
  answered: "green",
  scored: "green",
  running: "cyan",
  complete: "green",
  "no-answer": "yellow",
  "invalid-answer": "yellow",
  timeout: "magenta",
  error: "red",
  failed: "red",
  interrupted: "yellow",
  "not-run": "grey",
  skipped: "grey",
  pending: "grey",
};

export function status(text: string): string {
  return paint(text, STATUS_COLOURS[text] ?? "reset");
}
