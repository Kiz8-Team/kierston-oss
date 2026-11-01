/**
 * Paper figures from the KierstonOrg site data: the same day and the same series the site's charts
 * and ties graph draw, redrawn as static SVG with value axes.
 *
 *   bun run site-figures <site data dir> <figures out dir>
 *
 * Writes day_carrier.svg, day_bank.svg, day_visits.svg, day_traffic.svg, ties_sample.svg, and the
 * results scatter (results_cost.svg, results_time.svg) with its legends (results_legend[_key].svg).
 * LaTeX takes the PDFs; convert each with `cairosvg x.svg -o x.pdf`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: bun run site-figures <site data dir> <figures out dir>");
  process.exit(2);
}
const read = <T>(name: string) => JSON.parse(readFileSync(join(input, name), "utf8")) as T;

// The site's accents (activity.tsx, map-canvas.tsx).
const BLUE = "#256abf";
const ORANGE = "#c2410c";
const GREEN = "#177A4A";
const RED = "#B42318";
const MUTED = "#737373";
const FONT = `font-family="Helvetica, Arial, sans-serif"`;
const BINS = 144;

const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (value: number) => value.toLocaleString("en-US");
const dollars = (value: number) =>
  value >= 1e6 ? `$${(value / 1e6).toFixed(value % 1e6 === 0 ? 0 : 1)}M` : value >= 1e3 ? `$${Math.round(value / 1e3)}k` : `$${value}`;

/** Round ticks from zero past `peak`, about `count` of them. */
function ticks(peak: number, count = 4) {
  const raw = Math.max(1, peak) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
  const values: number[] = [];
  for (let v = 0; v < peak + step * 0.999; v += step) values.push(Math.round(v * 1e6) / 1e6);
  return values;
}

interface Series {
  label: string;
  color: string;
  values: number[];
  format?: (value: number) => string;
  /** Which value axis the line reads against. */
  axis?: "left" | "right";
}

interface Band {
  from: number;
  to: number;
  label: string;
}

interface Panel {
  series: Series[];
  bands?: Band[];
  height: number;
  /** Axis titles; a right title means the right-hand series have their own scale. */
  left: string;
  right?: string;
  leftFormat?: (value: number) => string;
  rightFormat?: (value: number) => string;
}

const WIDTH = 680;
const LEFT = 58;
const X_AXIS = 22;
const LEGEND = 28;

/** One or more stacked day panels sharing the clock; each panel has its own value axis. */
function dayChart(panels: Panel[], gap = 14) {
  const right = panels.some((panel) => panel.right) ? 58 : 14;
  const plotWidth = WIDTH - LEFT - right;
  const xOf = (bin: number) => LEFT + ((bin + 0.5) / BINS) * plotWidth;
  const xOfMinute = (minute: number) => LEFT + (minute / 1440) * plotWidth;
  const parts: string[] = [];
  let top = 0;
  panels.forEach((panel, position) => {
    const legendTop = top;
    const plotTop = top + LEGEND;
    const bottom = plotTop + panel.height;
    const scales = (["left", "right"] as const).map((side) => {
      const lines = panel.series.filter((entry) => (entry.axis ?? "left") === side);
      const values = ticks(Math.max(0, ...lines.flatMap((entry) => entry.values)), panel.height < 80 ? 2 : 4);
      return { side, lines, values, max: values[values.length - 1]! };
    });
    const yOf = (value: number, max: number) => bottom - (value / max) * panel.height;

    // Legend: the site's line swatch, label and peak, from the left edge as on the site.
    let x = 8;
    for (const entry of panel.series) {
      const peak = (entry.format ?? plain)(Math.max(...entry.values));
      parts.push(
        `<line x1="${x}" x2="${x + 16}" y1="${legendTop + 9}" y2="${legendTop + 9}" stroke="${entry.color}" stroke-width="2"/>`,
        `<text x="${x + 22}" y="${legendTop + 13}" font-size="12">${esc(entry.label)} <tspan fill="${MUTED}">peak ${esc(peak)}</tspan></text>`,
      );
      x += 22 + (entry.label.length + peak.length + 6) * 5.6 + 16;
    }

    for (const band of panel.bands ?? []) {
      parts.push(
        `<rect x="${xOfMinute(band.from)}" y="${plotTop}" width="${xOfMinute(band.to) - xOfMinute(band.from)}" height="${panel.height}" fill="#fef3c7"/>`,
        `<text x="${xOfMinute(band.from) + 4}" y="${bottom - 6}" font-size="11" fill="#92400e">${esc(band.label)}</text>`,
      );
    }
    for (const hour of [6, 12, 18]) {
      const hx = xOfMinute(hour * 60);
      parts.push(`<line x1="${hx}" x2="${hx}" y1="${plotTop}" y2="${bottom}" stroke="#e5e5e5"/>`);
    }

    for (const scale of scales) {
      if (scale.lines.length === 0) continue;
      const left = scale.side === "left";
      const axisX = left ? LEFT : LEFT + plotWidth;
      const format = (left ? panel.leftFormat : panel.rightFormat) ?? plain;
      // A dual-axis panel colours each axis by its line so the reader knows which scale is whose.
      const tint = panel.right ? scale.lines[0]!.color : "#404040";
      parts.push(`<line x1="${axisX}" x2="${axisX}" y1="${plotTop}" y2="${bottom}" stroke="${tint}"/>`);
      for (const value of scale.values) {
        const ty = yOf(value, scale.max);
        parts.push(
          `<line x1="${axisX}" x2="${axisX + (left ? -4 : 4)}" y1="${ty}" y2="${ty}" stroke="${tint}"/>`,
          `<text x="${axisX + (left ? -7 : 7)}" y="${ty + 4}" font-size="11" text-anchor="${left ? "end" : "start"}" fill="${tint}">${esc(format(value))}</text>`,
        );
      }
      const title = left ? panel.left : panel.right!;
      const titleX = left ? 12 : WIDTH - 10;
      const titleY = plotTop + panel.height / 2;
      parts.push(
        `<text x="${titleX}" y="${titleY}" font-size="11" text-anchor="middle" fill="${tint}" transform="rotate(${left ? -90 : 90} ${titleX} ${titleY})">${esc(title)}</text>`,
      );
      for (const entry of scale.lines) {
        const d = entry.values
          .map((value, bin) => `${bin === 0 ? "M" : "L"}${xOf(bin).toFixed(1)} ${yOf(value, scale.max).toFixed(1)}`)
          .join(" ");
        parts.push(`<path d="${d}" fill="none" stroke="${entry.color}" stroke-width="2" stroke-linejoin="round"/>`);
      }
    }
    parts.push(`<line x1="${LEFT}" x2="${LEFT + plotWidth}" y1="${bottom}" y2="${bottom}" stroke="#d4d4d4"/>`);
    top = bottom + (position === panels.length - 1 ? 0 : gap);
  });

  for (const hour of [0, 6, 12, 18, 24]) {
    const anchor = hour === 0 ? "start" : hour === 24 ? "end" : "middle";
    parts.push(
      `<text x="${xOfMinute(hour * 60)}" y="${top + 15}" font-size="11" text-anchor="${anchor}" fill="${MUTED}" font-variant-numeric="tabular-nums">${String(hour).padStart(2, "0")}:00</text>`,
    );
  }
  const height = top + X_AXIS;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" ${FONT}>\n<rect width="${WIDTH}" height="${height}" fill="#fff"/>\n${parts.join("\n")}\n</svg>\n`;
}

// ---- Carrier and bank activity (city.tsx) ----

interface CityData {
  date: string;
  activity: {
    calls: number[];
    texts: number[];
    tx: number[];
    txVolume: number[];
    payroll?: { from: number; to: number; deposits: number; amount: number };
  };
}
const city = read<CityData>("city.json");
const write = (name: string, svg: string) => {
  writeFileSync(join(output, name), svg);
  console.log(`${name}`);
};

write(
  "day_carrier.svg",
  dayChart([
    {
      series: [
        { label: "Calls", color: BLUE, values: city.activity.calls },
        { label: "Texts", color: ORANGE, values: city.activity.texts, axis: "right" },
      ],
      height: 130,
      left: "Calls / 10 min",
      right: "Texts / 10 min",
    },
  ]),
);

const payroll = city.activity.payroll;
write(
  "day_bank.svg",
  dayChart([
    {
      series: [
        { label: "Transactions", color: GREEN, values: city.activity.tx },
        { label: "Volume", color: BLUE, values: city.activity.txVolume, format: (v) => `$${plain(v)}`, axis: "right" },
      ],
      bands: payroll ? [{ from: payroll.from, to: payroll.to, label: "Payroll" }] : [],
      height: 130,
      left: "Transactions / 10 min",
      right: "Volume / 10 min",
      rightFormat: dollars,
    },
  ]),
);

// ---- Venue arrivals (places.tsx): the four groups the site charts, on one scale ----

interface PlacesData {
  groups: { id: string; label: string }[];
  activity: number[][];
}
const places = read<PlacesData>("places.json");
const PLACE_COLOR: Record<string, string> = { food: RED, retail: ORANGE, leisure: BLUE, civic: GREEN };
write(
  "day_visits.svg",
  dayChart([
    {
      series: ["food", "retail", "leisure", "civic"].map((id) => {
        const index = places.groups.findIndex((group) => group.id === id);
        return { label: places.groups[index]!.label, color: PLACE_COLOR[id]!, values: places.activity[index]! };
      }),
      height: 150,
      left: "Arrivals / 10 min",
    },
  ]),
);

// ---- Outside traffic (traffic.tsx): through traffic outnumbers deliveries a hundredfold, so each gets its own axis ----

interface TrafficData {
  enums: { tripKind: string[] };
  activity: Record<string, number[]>;
}
const traffic = read<TrafficData>("traffic.json");
const CATEGORIES = [
  { id: "through", label: "Through traffic", color: BLUE },
  { id: "visit", label: "Visitors", color: ORANGE },
  { id: "work", label: "Outside workers", color: GREEN },
  { id: "service", label: "Deliveries", color: "#8a6bb5" },
];
const categoryOf = (kind: string) => (kind === "through" ? "through" : kind.split("_")[0]!);
write(
  "day_traffic.svg",
  dayChart(
    CATEGORIES.map((category) => ({
      series: [
        {
          label: category.label,
          color: category.color,
          values: traffic.enums.tripKind
            .filter((kind) => categoryOf(kind) === category.id)
            .reduce((sum, kind) => sum.map((value, bin) => value + traffic.activity[kind]![bin]!), new Array<number>(BINS).fill(0)),
        },
      ],
      height: 58,
      left: "Trips",
    })),
    10,
  ),
);

// ---- One resident's ties (featured.tsx) ----

interface Alter {
  name: string;
  kind: string;
  group?: string;
  affinity: number;
  exposure: number;
  valence: number;
}
interface Resident {
  name: string;
  ties: { alters: Alter[]; links: number[][]; total: number };
}
const GROUP_COLOR: Record<string, string> = {
  "Family and household": "#C2410C",
  Work: "#1D4ED8",
  School: "#7C3AED",
  "Clubs and congregations": "#0F766E",
  Neighbours: "#A16207",
  Elsewhere: "#6B7280",
};
const GROUPS = Object.keys(GROUP_COLOR);
const groupOf = (alter: Alter) => alter.group ?? "Elsewhere";

/** The featured resident whose ties span the most groups and include an estranged one. */
const residents = read<{ residents: Resident[] }>("featured.json").residents;
const resident = process.env.RESIDENT
  ? residents.find((entry) => entry.name === process.env.RESIDENT)!
  : [...residents].sort(
      (a, b) =>
        new Set(b.ties.alters.map(groupOf)).size - new Set(a.ties.alters.map(groupOf)).size ||
        b.ties.links.length - a.ties.links.length,
    )[0]!;

function ties({ ties: { alters, links } }: Resident) {
  const size = 560;
  const centre = size / 2;
  const colour = (index: number) => GROUP_COLOR[groupOf(alters[index]!)]!;
  const order = alters
    .map((_, index) => index)
    .sort(
      (a, b) =>
        GROUPS.indexOf(groupOf(alters[a]!)) - GROUPS.indexOf(groupOf(alters[b]!)) ||
        alters[a]!.kind.localeCompare(alters[b]!.kind),
    );
  const place: { x: number; y: number }[] = [];
  order.forEach((index, slot) => {
    const angle = (slot / order.length) * Math.PI * 2 - Math.PI / 2;
    const radius = 90 + (1 - alters[index]!.affinity) * 160;
    place[index] = { x: centre + Math.cos(angle) * radius, y: centre + Math.sin(angle) * radius };
  });
  const parts: string[] = [];
  // Affinity rings, so the distance from the centre can be read.
  for (const affinity of [1, 0.75, 0.5, 0.25, 0]) {
    const radius = 90 + (1 - affinity) * 160;
    parts.push(
      `<circle cx="${centre}" cy="${centre}" r="${radius}" fill="none" stroke="#e5e5e5" stroke-dasharray="2 3"/>`,
      `<text x="${centre + 3}" y="${centre - radius - 3}" font-size="10" fill="${MUTED}">${affinity.toFixed(2)}</text>`,
    );
  }
  for (const [a, b] of links)
    parts.push(`<line x1="${place[a!]!.x}" y1="${place[a!]!.y}" x2="${place[b!]!.x}" y2="${place[b!]!.y}" stroke="#000" stroke-opacity="0.12"/>`);
  alters.forEach((alter, index) =>
    parts.push(
      `<line x1="${centre}" y1="${centre}" x2="${place[index]!.x}" y2="${place[index]!.y}" stroke="${colour(index)}" stroke-opacity="0.7" stroke-width="1"${alter.valence < 0 ? ` stroke-dasharray="4 3"` : ""}/>`,
    ),
  );
  alters.forEach((alter, index) =>
    parts.push(
      alter.valence < 0
        ? `<circle cx="${place[index]!.x}" cy="${place[index]!.y}" r="${Math.sqrt(9 + 112 * Math.max(0, alter.exposure))}" fill="#fff" stroke="${colour(index)}" stroke-width="2"/>`
        : `<circle cx="${place[index]!.x}" cy="${place[index]!.y}" r="${Math.sqrt(9 + 112 * Math.max(0, alter.exposure))}" fill="${colour(index)}" stroke="#fff" stroke-width="1.5"/>`,
    ),
  );
  parts.push(
    `<circle cx="${centre}" cy="${centre}" r="9" fill="#000" stroke="#fff" stroke-width="2"/>`,
  );

  // Legend under the square, as on the site.
  const present = GROUPS.filter((group) => alters.some((alter) => groupOf(alter) === group));
  const legend: [string, string, boolean][] = [
    ...present.map((group): [string, string, boolean] => [group, GROUP_COLOR[group]!, false]),
    ...(alters.some((alter) => alter.valence < 0) ? [["Estranged", MUTED, true] as [string, string, boolean]] : []),
  ];
  let x = 4;
  let y = size + 20;
  for (const [label, color, hollow] of legend) {
    const width = 20 + label.length * 6.6 + 14;
    if (x + width > size) {
      x = 4;
      y += 18;
    }
    parts.push(
      hollow
        ? `<circle cx="${x + 5}" cy="${y - 4}" r="4" fill="#fff" stroke="${color}" stroke-width="2"/>`
        : `<circle cx="${x + 5}" cy="${y - 4}" r="5" fill="${color}"/>`,
      `<text x="${x + 14}" y="${y}" font-size="12" fill="#525252">${esc(label)}</text>`,
    );
    x += width;
  }
  y += 30;
  parts.push(`<text x="4" y="${y}" font-size="12" fill="#525252">Exposure</text>`);
  for (const [x, exposure] of [[90, 0], [168, 0.5], [254, 1]]) {
    parts.push(
      `<circle cx="${x}" cy="${y - 4}" r="${Math.sqrt(9 + 112 * exposure!)}" fill="${MUTED}"/>`,
      `<text x="${x! + 17}" y="${y}" font-size="12" fill="#525252">${exposure!.toFixed(1)}</text>`,
    );
  }
  const height = y + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${height}" viewBox="0 0 ${size} ${height}" ${FONT}>\n<rect width="${size}" height="${height}" fill="#fff"/>\n<rect x="0.5" y="0.5" width="${size - 1}" height="${size - 1}" fill="none" stroke="#d4d4d4"/>\n${parts.join("\n")}\n</svg>\n`;
}
write("ties_sample.svg", ties(resident));

// ---- Results: score against cost and time (results.tsx `Frontier`), and the shared model legend ----

interface ResultTask {
  family: string;
  score: number | null;
  abstained: boolean;
  cost: number;
  durationMs?: number;
}
interface ResultIndex {
  groups: { families: string[] }[];
  runs: { slug: string; model?: string; startedAt?: string; tasks: ResultTask[] }[];
}
const results = read<ResultIndex>("index.json");
const MODEL_NAMES: Record<string, string> = {
  "claude-opus-5": "Claude Opus 5",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "gpt-6-astra": "GPT-6 Astra",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "minimax-m3": "MiniMax M3",
  "deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "glm-5.3": "GLM 5.3",
  "kimi-k3": "Kimi K3",
  "qwen3.8-max-0902": "Qwen 3.8 Max",
  "grok-4.7": "Grok 4.7",
};
const bare = (id: string) => id.replace(/^.*\//, "");
const PROVIDERS = [
  { match: /claude/i, hues: ["#B4552D", "#D9925E", "#8C3A1B", "#C08A1E"] },
  { match: /gpt|openai/i, hues: ["#2E5FA8", "#7BA3DF", "#1B3C6E", "#3E9BC4", "#1F8A8A"] },
  { match: /minimax/i, hues: ["#3D7A4F"] },
  { match: /deepseek/i, hues: ["#6B4FA0"] },
  { match: /gemini|google/i, hues: ["#A83E6B"] },
  { match: /glm|z-ai/i, hues: ["#2F7D6D"] },
  { match: /kimi|moonshot/i, hues: ["#5A5FC4"] },
  { match: /qwen/i, hues: ["#7A5A2E"] },
  { match: /grok|x-ai/i, hues: ["#9C2F2F"] },
  { match: /./, hues: ["#525252", "#8A8A8A", "#2A2A2A"] },
];
const TIERS: Record<string, number> = {
  "gpt-6-astra": 1,
  "claude-fable-5-1": 1,
  "claude-opus-5-5": 2,
  "gpt-6-sol": 2,
  "gpt-6.1-sol": 2,
  "claude-opus-5": 3,
  "gpt-5.6-sol": 3,
};
const average = (values: number[]) => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);

/** results.tsx `ModelMark`: the same shapes, sizes and area matching. */
function modelMark(id: string, x: number, y: number, size: number, fill: string, stroke?: string, strokeWidth = 0) {
  const paint = `fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""}`;
  const f = (value: number) => value.toFixed(2);
  switch (TIERS[bare(id)] ?? 4) {
    case 1: {
      const r = size * 1.3;
      return `<polygon points="${f(x)},${f(y - r)} ${f(x + r)},${f(y)} ${f(x)},${f(y + r)} ${f(x - r)},${f(y)}" ${paint}/>`;
    }
    case 2: {
      const r = size * 0.9;
      return `<rect x="${f(x - r)}" y="${f(y - r)}" width="${f(r * 2)}" height="${f(r * 2)}" ${paint}/>`;
    }
    case 3: {
      const r = size * 1.35;
      return `<polygon points="${f(x)},${f(y - r)} ${f(x + r * 0.866)},${f(y + r / 2)} ${f(x - r * 0.866)},${f(y + r / 2)}" ${paint}/>`;
    }
    default:
      return `<circle cx="${f(x)}" cy="${f(y)}" r="${f(size)}" ${paint}/>`;
  }
}

// Runs of one model are pooled, oldest first, as on the site.
const families = results.groups.flatMap((group) => group.families);
const pooled = new Map<string, ResultTask[]>();
for (const run of [...results.runs].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""))) {
  const id = run.model ?? run.slug;
  pooled.set(id, [...(pooled.get(id) ?? []), ...run.tasks.filter((task) => families.includes(task.family))]);
}
const models = [...pooled.entries()]
  .map(([id, tasks]) => ({
    id,
    all: average(tasks.map((task) => task.score ?? 0)),
    // The paper's answered mean also leaves out attempts without an answer file (the site counts them as zero).
    answered: average(tasks.flatMap((task) => (task.abstained || task.score === null ? [] : [task.score]))),
    cost: average(tasks.map((task) => task.cost)),
    minutes: average(tasks.flatMap((task) => task.durationMs ?? [])) / 60000,
    provider: PROVIDERS.findIndex((provider) => provider.match.test(id)),
  }))
  .sort((a, b) => a.provider - b.provider || b.all - a.all);
// The paper's \definecolor{model...} values. A model keeps its colour when a
// rerun changes its rank; models not listed take the next unused provider hue.
const PINNED: Record<string, string> = {
  "claude-fable-5-1": "#B4552D", "claude-opus-5-5": "#D9925E", "claude-opus-5": "#8C3A1B", "claude-sonnet-5-5": "#C08A1E",
  "gpt-6-sol": "#2E5FA8", "gpt-6-astra": "#7BA3DF", "gpt-6.1-sol": "#1B3C6E", "gpt-5.6-sol": "#3E9BC4", "gpt-6-luna": "#1F8A8A",
};
const colourOf = new Map<string, string>();
{
  const taken = new Set(models.flatMap((model) => PINNED[bare(model.id)] ?? []));
  const used = new Map<number, number>();
  for (const model of models) {
    const pinned = PINNED[bare(model.id)];
    if (pinned) { colourOf.set(model.id, pinned); continue; }
    const hues = PROVIDERS[model.provider]!.hues;
    let nth = used.get(model.provider) ?? 0;
    while (nth < hues.length && taken.has(hues[nth]!)) nth++;
    used.set(model.provider, nth + 1);
    colourOf.set(model.id, hues[nth % hues.length]!);
  }
}

/** results.tsx `ticks`: the last tick sits at or beyond `top`. */
function siteTicks(top: number, count = 4) {
  const raw = top / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let value = 0; value < top + step - 1e-9; value += step) out.push(value);
  return out;
}

/** The site's Frontier at paper scale: filled mark at the all-task score, hollow at the answered one. */
function frontier(axis: string, value: (model: (typeof models)[number]) => number, format: (value: number) => string) {
  const width = 340;
  const height = 250;
  const left = 36;
  const right = 20;
  const top = 10;
  const bottom = 38;
  const xTicks = siteTicks(Math.max(...models.map(value), 0.01) * 1.1, 5);
  const xMax = xTicks[xTicks.length - 1]!;
  const yMin = Math.floor(Math.min(0, ...models.flatMap((model) => [model.all, model.answered])) * 5) / 5;
  const yTicks: number[] = [];
  for (let tick = yMin; tick <= 1 + 1e-9; tick += 0.2) yTicks.push(tick);
  const px = (x: number) => left + (x / xMax) * (width - left - right);
  const py = (y: number) => top + (1 - (y - yMin) / (1 - yMin)) * (height - top - bottom);
  const parts: string[] = [];
  for (const tick of yTicks) {
    const zero = Math.abs(tick) < 1e-9;
    parts.push(
      `<line x1="${left}" x2="${width - right}" y1="${py(tick)}" y2="${py(tick)}" stroke="${zero ? "#000" : "#e5e5e5"}" stroke-width="${zero ? 0.75 : 0.5}"/>`,
      `<text x="${left - 6}" y="${py(tick) + 3.5}" text-anchor="end" font-size="10" fill="#525252">${tick.toFixed(1)}</text>`,
    );
  }
  for (const tick of xTicks) {
    parts.push(
      `<line x1="${px(tick)}" x2="${px(tick)}" y1="${py(yMin)}" y2="${py(yMin) + 4}" stroke="#000" stroke-width="0.75"/>`,
      `<text x="${px(tick)}" y="${py(yMin) + 15}" text-anchor="middle" font-size="10" fill="#525252">${esc(format(tick))}</text>`,
    );
  }
  parts.push(
    `<line x1="${left}" x2="${left}" y1="${py(1)}" y2="${py(yMin)}" stroke="#000" stroke-width="0.75"/>`,
    `<text x="${left + (width - left - right) / 2}" y="${height - 6}" text-anchor="middle" font-size="11">${esc(axis)}</text>`,
    `<text x="10" y="${top + (height - top - bottom) / 2}" text-anchor="middle" font-size="11" transform="rotate(-90 10 ${top + (height - top - bottom) / 2})">Score</text>`,
  );
  for (const model of models) {
    const x = px(value(model));
    const colour = colourOf.get(model.id)!;
    parts.push(
      `<line x1="${x}" x2="${x}" y1="${py(model.all)}" y2="${py(model.answered)}" stroke="${colour}" stroke-width="1.2"/>`,
      modelMark(model.id, x, py(model.answered), 4.6, "#fff", colour, 0.8),
      modelMark(model.id, x, py(model.all), 5, colour),
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${FONT}>\n<rect width="${width}" height="${height}" fill="#fff"/>\n${parts.join("\n")}\n</svg>\n`;
}

write("results_cost.svg", frontier("API cost per task, USD", (model) => model.cost, (value) => `$${value.toFixed(value < 1 ? 2 : 1)}`));
write("results_time.svg", frontier("Wall-clock per task, minutes", (model) => model.minutes, (value) => `${value.toFixed(value < 10 ? 1 : 0)} min`));

/** The model legend: one row, shape and colour, with the filled/hollow key when asked for. */
function modelLegend(withKey: boolean) {
  const parts: string[] = [];
  let x = 6;
  // Legends list models by tier, then in the colour order.
  const entries: [string, string][] = [...models]
    .sort((a, b) => (TIERS[bare(a.id)] ?? 4) - (TIERS[bare(b.id)] ?? 4))
    .map((model) => [model.id, MODEL_NAMES[bare(model.id)] ?? model.id]);
  for (const [id, name] of entries) {
    parts.push(modelMark(id, x + 5, 10, 4.6, colourOf.get(id)!), `<text x="${x + 14}" y="14" font-size="11">${esc(name)}</text>`);
    x += 14 + name.length * 5.9 + 14;
  }
  const width = Math.ceil(x);
  let height = 20;
  if (withKey) {
    const keyY = 32;
    parts.push(
      `<circle cx="11" cy="${keyY}" r="5" fill="#000"/>`,
      `<text x="20" y="${keyY + 4}" font-size="11" fill="#525252">all tasks</text>`,
      `<circle cx="81" cy="${keyY}" r="4.6" fill="#fff" stroke="#000" stroke-width="0.8"/>`,
      `<text x="90" y="${keyY + 4}" font-size="11" fill="#525252">answered only</text>`,
    );
    height = 42;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ${FONT}>\n<rect width="${width}" height="${height}" fill="#fff"/>\n${parts.join("\n")}\n</svg>\n`;
}
write("results_legend_key.svg", modelLegend(true));
write("results_legend.svg", modelLegend(false));
for (const model of models)
  console.log(`  ${bare(model.id)}: all ${model.all.toFixed(2)} answered ${model.answered.toFixed(2)} $${model.cost.toFixed(2)} ${model.minutes.toFixed(1)} min`);
