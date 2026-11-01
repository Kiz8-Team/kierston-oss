/**
 * The terminal, as a frame buffer and a key stream.
 *
 * Small enough to read in one sitting and deliberately dependency-free: the
 * CLI draws whole frames of plain lines, and the screen writes them into
 * the alternate buffer with the cursor parked at home, so a redraw costs one
 * write and never scrolls the user's scrollback away.
 */

export interface Key {
  /** `up`, `down`, `enter`, `escape`, `backspace`, `tab`, `char`, ... */
  name: string;
  /** The character, when the key was one. */
  ch?: string;
  ctrl?: boolean;
}

const SEQUENCES: Record<string, string> = {
  "\x1b[Z": "shift-tab",
  "\x1b[A": "up",
  "\x1b[B": "down",
  "\x1b[C": "right",
  "\x1b[D": "left",
  "\x1b[H": "home",
  "\x1b[F": "end",
  "\x1b[5~": "pageup",
  "\x1b[6~": "pagedown",
  "\x1b[3~": "delete",
  "\x1bOA": "up",
  "\x1bOB": "down",
  "\x1bOC": "right",
  "\x1bOD": "left",
};

/** The end of a CSI sequence: its first byte in the 0x40–0x7e range. */
function csiEnd(rest: string): number {
  for (let i = 2; i < rest.length; i++) {
    const code = rest.charCodeAt(i);
    if (code >= 0x40 && code <= 0x7e) return i + 1;
  }
  return -1;
}

export function decode(input: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    const sequence = Object.keys(SEQUENCES).find((candidate) => rest.startsWith(candidate));
    if (sequence) {
      keys.push({ name: SEQUENCES[sequence]! });
      index += sequence.length;
      continue;
    }
    // An escape sequence we do not use — a function key, shift-tab, a mouse
    // report — is swallowed whole. Decoding it as ESC plus its letters would
    // read as "go back" followed by whatever those letters happen to mean.
    if (rest.startsWith("\x1b[") || rest.startsWith("\x1bO")) {
      const end = csiEnd(rest);
      if (end !== -1) {
        index += end;
        continue;
      }
    }
    const ch = input[index]!;
    index += 1;
    if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
    else if (ch === "\x1b") keys.push({ name: "escape" });
    else if (ch === "\x03") keys.push({ name: "c", ctrl: true });
    else if (ch === "\x04") keys.push({ name: "d", ctrl: true });
    else if (ch < " ") keys.push({ name: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true });
    else keys.push({ name: "char", ch });
  }
  return keys;
}

export class Screen {
  private started = false;
  private previous: string[] = [];
  private keyHandler: (key: Key) => void | Promise<void> = () => {};
  /** Preserve input order when a key starts asynchronous navigation. */
  private keyQueue = Promise.resolve();
  private resizeHandler: () => void = () => {};
  private readonly onData = (chunk: Buffer | string) => {
    for (const key of decode(chunk.toString())) {
      this.keyQueue = this.keyQueue.then(() => this.keyHandler(key)).catch(() => {});
    }
  };
  private readonly onResize = () => {
    this.previous = [];
    this.resizeHandler();
  };

  get rows(): number {
    return process.stdout.rows ?? 24;
  }

  get columns(): number {
    return process.stdout.columns ?? 80;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", this.onResize);
    // Alternate buffer, cursor hidden.
    process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    process.stdin.off("data", this.onData);
    process.stdout.off("resize", this.onResize);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }

  onKey(handler: (key: Key) => void | Promise<void>): void {
    this.keyHandler = handler;
  }

  onResizeTo(handler: () => void): void {
    this.resizeHandler = handler;
  }

  /** Draw a frame: only the lines that changed are rewritten. */
  render(lines: readonly string[]): void {
    if (!this.started) return;
    const height = this.rows;
    const frame = lines.slice(0, height);
    let out = "";
    for (let row = 0; row < height; row++) {
      const line = frame[row] ?? "";
      if (this.previous[row] === line) continue;
      out += `\x1b[${row + 1};1H\x1b[2K${line}`;
    }
    this.previous = [...frame];
    if (out !== "") process.stdout.write(out + "\x1b[H");
  }
}
