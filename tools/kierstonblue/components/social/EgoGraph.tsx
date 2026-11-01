"use client";

import { useMemo, useState } from "react";
import { percent } from "@/lib/format";
import {
  GROUP_LABEL, TIE_GROUPS, groupOf, relationLabel,
  type Tie, type TieGraph, type TieGroup,
} from "@/lib/ties";

/**
 * One person's social world, drawn.
 *
 * The two numbers a tie carries are independent, so they get independent
 * channels and neither is blended into the other:
 *
 *     radius     affinity. The centre is the person; the closer a dot sits to
 *                them, the more they like each other. The dashed rings are the
 *                generator's own tier cuts, so "inside the second ring" means
 *                "friend" in exactly the sense ties.py means it.
 *     size       exposure. A big dot is somebody they are in a room with
 *                daily, whether or not they like them.
 *     angle      provenance, in six wedges sized by how many ties each holds.
 *     colour     the same six groups, so a wedge is legible once the eye has
 *                left the legend.
 *
 * Which puts the case the whole model exists to express on screen: a big dot
 * far out is the man on the next pick line, seen eight hours a day, whose
 * second name you would have to think about. A small dot near the middle is
 * the friend across town. A single strength would have drawn those two in the
 * same place.
 *
 * Colour is never the only cue — every group is a contiguous wedge, the legend
 * is always drawn, and the tie list beside this says each relation in words.
 * The diagram is a pointer affordance; the list is the keyboard and screen
 * reader path to the same people, which is why the dots are not focus targets.
 */

const SIZE = 460;
const CENTRE = SIZE / 2;

/**
 * A dot grows a little under the pointer, and takes a dark outline so the one
 * being read is distinguishable from the one merely next to it. `r` animates
 * rather than the whole dot, which keeps the spoke attached to its end.
 */
const DOT = "[transition:r_0.12s_ease] data-[lit=true]:[stroke:var(--foreground)] "
  + "data-[lit=true]:[stroke-width:1.6]";

const TIP = "pointer-events-none absolute z-[2] grid min-w-[9rem] gap-[0.05rem] "
  + "rounded-sm bg-card px-[0.55rem] py-[0.4rem] text-[0.72rem] "
  + "shadow-[var(--shadow-float)] "
  + "[&>strong]:text-[0.76rem] [&>span]:text-muted-foreground";

const LEGEND = "m-0 mt-2 flex list-none flex-wrap gap-x-[0.9rem] gap-y-[0.3rem] p-0 "
  + "text-[0.72rem] [&>li]:flex [&>li]:items-center [&>li]:gap-[0.32rem] "
  + "[&_i]:size-[0.55rem] [&_i]:rounded-full [&_span]:text-muted-foreground";
const R_MIN = 34;
const R_MAX = 198;
/** The gap between two wedges, in radians — enough to read as a break. */
const WEDGE_GAP = 0.055;

export const GROUP_COLOR: Record<TieGroup, string> = {
  family: "var(--tie-family)",
  work: "var(--tie-work)",
  school: "var(--tie-school)",
  community: "var(--tie-community)",
  neighbourhood: "var(--tie-neighbour)",
  elsewhere: "var(--tie-elsewhere)",
};

interface Placed {
  tie: Tie;
  group: TieGroup;
  x: number;
  y: number;
  r: number;
}

/** Affinity to distance from the centre — 1 at the middle, 0 at the rim. */
const radiusFor = (affinity: number) => R_MAX - affinity * (R_MAX - R_MIN);

export function EgoGraph({ ties, graph, person, ageOf, nameOf, onOpen, limit = 160 }: {
  ties: Tie[];
  graph: TieGraph;
  person: number;
  /** A resident's age, or null for a stub with no record. */
  ageOf: (id: number) => number | null;
  nameOf: (id: number) => string;
  onOpen: (id: number) => void;
  limit?: number;
}) {
  const [hover, setHover] = useState<Placed | null>(null);

  const { placed, shown } = useMemo(() => {
    // The strongest ties, by the two numbers together: a diagram of 479 people
    // is a smear, and the ones worth dropping are the ones that are neither
    // liked nor seen. Ranking is only for choosing which to draw — nothing is
    // positioned by this number.
    const ranked = [...ties].sort(
      (x, y) => (y.affinity + y.exposure) - (x.affinity + x.exposure),
    );
    const take = ranked.slice(0, limit);

    const buckets = new Map<TieGroup, Tie[]>();
    for (const tie of take) {
      const group = groupOf(tie.kind);
      const list = buckets.get(group);
      if (list) list.push(tie);
      else buckets.set(group, [tie]);
    }

    const groups = TIE_GROUPS.filter((group) => buckets.has(group));
    const out: Placed[] = [];
    // Start at the top and go clockwise, so the wedge order matches the legend
    // read top to bottom.
    let angle = -Math.PI / 2;
    for (const group of groups) {
      const list = buckets.get(group)!;
      list.sort((x, y) => y.affinity - x.affinity);
      const span = (list.length / take.length) * Math.PI * 2;
      const inner = Math.max(span - WEDGE_GAP, span * 0.5);
      list.forEach((tie, index) => {
        const theta = angle + (span - inner) / 2
          + ((index + 0.5) / list.length) * inner;
        const r = radiusFor(tie.affinity);
        out.push({
          tie,
          group,
          x: CENTRE + Math.cos(theta) * r,
          y: CENTRE + Math.sin(theta) * r,
          r: 2.4 + tie.exposure * 3.6,
        });
      });
      angle += span;
    }

    return { placed: out, shown: take.length, hidden: ties.length - take.length };
  }, [ties, limit]);

  const rings = graph.tiers
    .filter(([floor], index) => floor > 0 && index < graph.tiers.length - 1)
    .map(([floor, name]) => ({ floor, name, r: radiusFor(floor) }));

  const egoAge = ageOf(person);
  const summary = `Ego network · ${nameOf(person)} · ${shown} of ${ties.length} ties`;

  return (
    <div className="mb-4">
      <div className="relative [&>svg]:block [&>svg]:h-auto [&>svg]:w-full [&>svg]:overflow-visible">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label={summary}>
          {/* The tier cuts, drawn before anything sits on them. Labelled on the
              left where no wedge starts, so a ring is readable as a threshold
              rather than as decoration. */}
          {rings.map((ring) => (
            <g key={ring.name}>
              <circle
                fill="none"
                stroke="var(--border)"
                strokeDasharray="3 4"
                strokeWidth={1}
                cx={CENTRE}
                cy={CENTRE}
                r={ring.r}
              />
              <text
                className="font-sans"
                fill="var(--muted-foreground)"
                fontSize={8.5}
                textAnchor="start"
                x={CENTRE - ring.r + 3}
                y={CENTRE - 4}
              >
                {ring.name === "close_friend" ? "close" : ring.name}
              </text>
            </g>
          ))}

          {placed.map((dot) => (
            <line
              key={`s${dot.tie.edge}`}
              strokeWidth={1}
              x1={CENTRE}
              y1={CENTRE}
              x2={dot.x}
              y2={dot.y}
              stroke={GROUP_COLOR[dot.group]}
              strokeOpacity={0.1 + dot.tie.exposure * 0.42}
            />
          ))}

          {placed.map((dot) => (
            <g key={dot.tie.edge}>
              <circle
                className={DOT}
                strokeWidth={1.2}
                cx={dot.x}
                cy={dot.y}
                r={dot.r}
                // A negative tie is a relation that exists and has no contact
                // in it, so it is drawn as an outline: present, and empty.
                fill={dot.tie.valence < 0 ? "var(--surface-1)" : GROUP_COLOR[dot.group]}
                stroke={dot.tie.valence < 0 ? GROUP_COLOR[dot.group] : "var(--surface-1)"}
                strokeDasharray={dot.tie.valence < 0 ? "2 1.6" : undefined}
                data-lit={hover?.tie.edge === dot.tie.edge}
              />
              {/* The hit target, always comfortably bigger than the mark. */}
              <circle
                className="cursor-pointer fill-transparent"
                cx={dot.x}
                cy={dot.y}
                r={Math.max(dot.r + 4, 9)}
                onPointerEnter={() => setHover(dot)}
                onPointerLeave={() => setHover((current) =>
                  (current?.tie.edge === dot.tie.edge ? null : current))}
                onClick={() => {
                  if (!graph.isStub(dot.tie.other)) onOpen(dot.tie.other);
                }}
              />
            </g>
          ))}

          <circle
            fill="var(--foreground)"
            stroke="var(--card)"
            strokeWidth={2.5}
            cx={CENTRE}
            cy={CENTRE}
            r={7}
          />
        </svg>

        {hover ? (
          <div
            className={TIP}
            style={{
              left: `${(hover.x / SIZE) * 100}%`,
              top: `${(hover.y / SIZE) * 100}%`,
              // Flip above the point in the lower half, so the tip never
              // hangs off the bottom of the frame.
              transform: hover.y > SIZE * 0.6
                ? "translate(-50%, calc(-100% - .7rem))"
                : "translate(-50%, .7rem)",
            }}
            role="status"
          >
            <strong>
              {graph.isStub(hover.tie.other)
                ? graph.stubLabel(hover.tie.other)
                : nameOf(hover.tie.other)}
            </strong>
            <span>
              {relationLabel(hover.tie.kind, egoAge, ageOf(hover.tie.other))}
              {hover.tie.valence < 0 ? " · estranged" : ""}
            </span>
            <span className="tabular-nums">
              exposure {percent(hover.tie.exposure, 0)} · affinity{" "}
              {percent(hover.tie.affinity, 0)}
            </span>
          </div>
        ) : null}
      </div>

      <ul className={LEGEND}>
        {TIE_GROUPS.filter((group) => placed.some((dot) => dot.group === group))
          .map((group) => (
            <li key={group}>
              <i style={{ background: GROUP_COLOR[group] }} />
              {GROUP_LABEL[group]}
              <span className="tabular-nums">
                {placed.filter((dot) => dot.group === group).length}
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}
