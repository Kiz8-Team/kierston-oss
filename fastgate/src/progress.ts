export type ImportStage = "schema" | "read" | "extract" | "insert" | "complete" | "skipped";

export interface ImportProgress {
  stage: ImportStage;
  label: string;
  completed?: number;
  total?: number;
}

export type ProgressHandler = (progress: ImportProgress) => void;

function amount(value: number, bytes: boolean): string {
  if (!bytes) return value.toLocaleString("en-US");
  const units = ["B", "KB", "MB", "GB"];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function render(progress: ImportProgress): string {
  if (progress.completed === undefined || progress.total === undefined) return progress.label;
  const bytes = progress.stage === "read";
  const percent = progress.total === 0 ? 100 : Math.floor(progress.completed * 100 / progress.total);
  return `${progress.label}  ${amount(progress.completed, bytes)} / ${amount(progress.total, bytes)}  ${percent}%`;
}

/** A live terminal line in a TTY and sparse milestone lines in ordinary logs. */
export function progressLogger(prefix = ""): { report: ProgressHandler; finish(): void } {
  const tty = Boolean(process.stderr.isTTY);
  let active = false;
  let lastKey = "";
  let lastBucket = -1;
  let lastWrite = 0;

  const report: ProgressHandler = (progress) => {
    const now = Date.now();
    const key = `${progress.stage}\0${progress.label}`;
    const percent = progress.completed === undefined || progress.total === undefined
      ? 100
      : progress.total === 0 ? 100 : Math.floor(progress.completed * 100 / progress.total);
    const bucket = Math.floor(percent / 10);
    const changed = key !== lastKey;
    const done = progress.total !== undefined && progress.completed === progress.total;

    if (tty) {
      if (!changed && !done && now - lastWrite < 100) return;
      process.stderr.write(`\r\x1b[2K${prefix}${render(progress)}`);
      active = true;
    } else {
      if (!changed && !done && bucket === lastBucket) return;
      process.stderr.write(`${prefix}${render(progress)}\n`);
    }
    lastKey = key;
    lastBucket = bucket;
    lastWrite = now;
  };

  return {
    report,
    finish() {
      if (tty && active) process.stderr.write("\n");
      active = false;
    },
  };
}
