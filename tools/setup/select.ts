/**
 * Arrow-key single choice on a TTY, with no dependencies: setup runs before
 * `bun install`. Up/down or k/j move, Enter picks, Ctrl-C exits.
 */

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

export async function select<T>(title: string, options: { label: string; value: T }[], initial = 0): Promise<T> {
  const stdin = process.stdin;
  const out = process.stdout;
  let index = initial;

  const draw = (redraw: boolean) => {
    if (redraw) out.write(`\x1b[${options.length}A`);
    for (const [i, option] of options.entries()) {
      const line = i === index ? `${CYAN}❯ ${option.label}${RESET}` : `${DIM}  ${option.label}${RESET}`;
      out.write(`\x1b[2K${line}\n`);
    }
  };

  out.write(`${title}\n\x1b[?25l`);
  draw(false);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise(resolve => {
    const finish = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      out.write(`\x1b[${options.length}A\x1b[J${CYAN}❯ ${options[index]!.label}${RESET}\n\x1b[?25h`);
    };
    const onData = (data: Buffer) => {
      const key = data.toString();
      if (key === "\x03") { finish(); process.exit(130); }
      if (key === "\r" || key === "\n") { finish(); resolve(options[index]!.value); return; }
      if (key === "\x1b[A" || key === "k") index = (index + options.length - 1) % options.length;
      else if (key === "\x1b[B" || key === "j") index = (index + 1) % options.length;
      else return;
      draw(true);
    };
    stdin.on("data", onData);
  });
}
