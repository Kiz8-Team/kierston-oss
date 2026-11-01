/** Command-line options shared by the site exporters. */

/** The value after `name`, or `fallback` when the flag is absent. */
export function option(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] ?? fallback : fallback;
}

/** The value after `name`; prints `usage` and exits when the flag or its value is missing. */
export function required(name: string, usage: string): string {
  const at = process.argv.indexOf(name);
  const value = at >= 0 ? process.argv[at + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    console.error(`missing ${name}\nusage: ${usage}`);
    process.exit(2);
  }
  return value;
}
