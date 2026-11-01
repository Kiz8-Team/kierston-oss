"use client";

import { useMemo, useState } from "react";
import { BarList, Track } from "@/components/Charts";
import { OutlineButton } from "@/components/browse/BrowseTable";
import { DetailActions, DetailHeading } from "@/components/browse/detail";
import { PERSON_LINK, PersonLink } from "@/components/PersonLink";
import { GROUP_COLOR, EgoGraph } from "@/components/social/EgoGraph";
import { Tile, Tiles } from "@/components/Tiles";
import { humanise, num, percent } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import type { Population } from "@/lib/population";
import {
  FOCUS_LABEL, TIER_LABEL, groupOf, relationLabel, type Tie, type TieGraph,
} from "@/lib/ties";
import { cn } from "@/lib/utils";

/**
 * One person's circle: counts, the ego graph, where the ties come from,
 * friends of friends, and everyone they know.
 *
 * Shared by the social page's drawer and the record page's circle dialog, so
 * a reader on somebody's record sees the same thing without leaving it.
 * Key it by person: the "show the rest" state belongs to one circle.
 */
export function SocialCircle({ ties, identity, population, person, onOpen, wide = false }: {
  ties: TieGraph;
  identity: Identity;
  population: Population;
  person: number;
  onOpen: (next: number) => void;
  /** Two columns — the graph and its breakdown beside the lists — for a
   *  landscape dialog rather than a drawer. */
  wide?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  const list = useMemo(() => ties.tiesOf(person), [ties, person]);
  const stats = useMemo(() => ties.statsOf(person, list), [ties, person, list]);
  const nameOf = (id: number) => (ties.isStub(id) ? ties.stubLabel(id) : identity.shortName(id));
  const ageOf = (id: number) => (ties.isStub(id) ? null : population.resident(id).age);

  const overview = (
    <>
      <Tiles compact>
        <Tile value={num(stats.ties)}>Ties</Tile>
        <Tile value={num(stats.byTier.get("close_friend") ?? 0)}>Close friends</Tile>
        <Tile value={num(stats.byTier.get("friend") ?? 0)}>Friends</Tile>
        <Tile value={percent(stats.meanExposure, 0)}>Mean exposure</Tile>
        {stats.negative ? <Tile value={num(stats.negative)}>Estranged</Tile> : null}
        {stats.outside ? <Tile value={num(stats.outside)}>Outside the city</Tile> : null}
      </Tiles>

      {list.length ? (
        <EgoGraph
          ties={list}
          graph={ties}
          person={person}
          ageOf={ageOf}
          nameOf={nameOf}
          onOpen={onOpen}
        />
      ) : null}

      {stats.byKind.length ? (
        <>
          <DetailHeading>Tie kinds</DetailHeading>
          <BarList
            bands={stats.byKind.slice(0, 8).map((entry) => ({
              label: humanise(entry.kind),
              value: entry.count,
            }))}
            total={stats.ties}
          />
        </>
      ) : null}

    </>
  );
  const lists = (
    <>
      <Mutuals graph={ties} person={person} nameOf={nameOf} onOpen={onOpen} />

      <DetailHeading>
        All ties
        <small className="text-muted-foreground tabular-nums">{num(list.length)}</small>
      </DetailHeading>
      <TieList
        ties={list}
        graph={ties}
        identity={identity}
        egoAge={population.resident(person).age}
        ageOf={ageOf}
        limit={showAll ? list.length : LIST_LIMIT}
      />
      {!showAll && list.length > LIST_LIMIT ? (
        <DetailActions>
          <OutlineButton type="button" onClick={() => setShowAll(true)}>
            Show {num(list.length - LIST_LIMIT)} more
          </OutlineButton>
        </DetailActions>
      ) : null}
    </>
  );

  if (!wide) return <>{overview}{lists}</>;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 max-[56rem]:grid-cols-1">
      <div className="min-w-0">{overview}</div>
      <div className="min-w-0 [&>h3:first-child]:mt-0">{lists}</div>
    </div>
  );
}

/** How many ties the list shows before it asks to be told to show the rest. */
const LIST_LIMIT = 60;

const TIE_LIST = "[&_h3]:mt-[0.9rem] [&_h3]:mb-[0.2rem] [&_h3]:text-[0.68rem] "
  + "[&_h3]:font-bold [&_h3]:tracking-[0.05em] [&_h3]:text-foreground [&_h3]:uppercase";

/**
 * One alter: who they are on the first line, how you know them on the second,
 * and the two bars spanning both rows in a fixed column on the right so they
 * line up down the list however long the names are.
 */
const TIE_ROW = "grid grid-cols-[minmax(0,1fr)_4.4rem] gap-x-[0.6rem] gap-y-[0.1rem] "
  + "border-t border-muted py-[0.34rem] text-[0.76rem]";

const TIE_WHO = "flex min-w-0 items-center gap-[0.35rem] "
  + "[&>i]:size-[0.5rem] [&>i]:flex-none [&>i]:rounded-full";

const TIE_WHAT = "col-start-1 text-[0.72rem] text-muted-foreground first-letter:uppercase";

const TIE_BARS = "relative col-start-2 row-span-2 row-start-1 grid content-center gap-[0.18rem]";

const TIE_KEY = "mt-[0.7rem] flex flex-wrap gap-x-[0.9rem] gap-y-[0.2rem] "
  + "[&>span]:inline-flex [&>span]:items-center [&>span]:gap-[0.3rem] "
  + "[&_i]:h-[0.3rem] [&_i]:w-[0.55rem] [&_i]:rounded-[2px]";

/**
 * Friends of friends this person does not already know.
 *
 * The closure pass in ties.py is what turns a pile of pairwise ties into
 * actual friend groups, and this is the view where you can see whether it
 * worked: a graph without closure gives everybody a long list of strangers
 * sharing exactly one friend, and a graph with it gives a short list sharing
 * four or five.
 */
function Mutuals({ graph, person, nameOf, onOpen }: {
  graph: TieGraph;
  person: number;
  nameOf: (id: number) => string;
  onOpen: (id: number) => void;
}) {
  const mutuals = useMemo(() => graph.mutuals(person), [graph, person]);
  if (!mutuals.length) return null;

  return (
    <>
      <DetailHeading>Friends of friends</DetailHeading>
      <div className="grid grid-cols-3 gap-x-4 gap-y-2.5">
        {mutuals.map((entry) => (
          <div key={entry.id} className="grid min-w-0 gap-0.5">
            <button
              type="button"
              className={cn(PERSON_LINK, "truncate text-left")}
              onClick={() => onOpen(entry.id)}
              title={nameOf(entry.id)}
            >
              {nameOf(entry.id)}
            </button>
            <span className="text-[0.72rem] text-muted-foreground tabular-nums">
              {entry.shared} shared
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The ties in words, banded by the generator's own affinity tiers.
 *
 * This is the table view the diagram is the picture of: everything the dots
 * encode is stated here in text, in the same order, reachable by keyboard. The
 * two bars on each row are the two numbers kept apart — a row with a full
 * exposure bar and an empty affinity bar is a colleague, and there are a great
 * many of them.
 */
function TieList({ ties, graph, identity, egoAge, ageOf, limit }: {
  ties: Tie[];
  graph: TieGraph;
  identity: Identity;
  egoAge: number;
  ageOf: (id: number) => number | null;
  limit: number;
}) {
  const shown = ties.slice(0, limit);
  const bands: { key: string; label: string; rows: Tie[] }[] = [];

  for (const tie of shown) {
    const key = tie.valence < 0 ? "estranged" : tie.tier;
    const last = bands[bands.length - 1];
    if (last && last.key === key) last.rows.push(tie);
    else {
      bands.push({
        key,
        label: key === "estranged"
          ? "Estranged"
          : TIER_LABEL[key] ?? humanise(key),
        rows: [tie],
      });
    }
  }

  return (
    <div className={TIE_LIST}>
      {bands.map((band, index) => (
        <div key={`${band.key}${index}`}>
          <h3>
            {band.label}
            <small className="text-muted-foreground tabular-nums"> · {num(band.rows.length)}</small>
          </h3>
          {band.rows.map((tie) => {
            const foci = graph.fociOf(tie.focus)
              .map((name) => FOCUS_LABEL[name] ?? name);
            return (
              <div className={TIE_ROW} key={tie.edge}>
                <span className={TIE_WHO}>
                  <i style={{ background: GROUP_COLOR[groupOf(tie.kind)] }} />
                  {graph.isStub(tie.other) ? (
                    <span className="text-muted-foreground">{graph.stubLabel(tie.other)}</span>
                  ) : (
                    <PersonLink names={identity} person={tie.other} />
                  )}
                </span>
                <span className={TIE_WHAT}>
                  {relationLabel(tie.kind, egoAge, ageOf(tie.other))}
                  {/* Multiplexity is the strongest single predictor the model
                      has of a real friendship, so a tie that came from two
                      places says both. */}
                  {foci.length > 1 ? ` · ${foci.join(", ")}` : ""}
                  {tie.since ? (
                    <span className="text-muted-foreground tabular-nums"> · since {tie.since}</span>
                  ) : null}
                </span>
                <span className={TIE_BARS} title={
                  `Exposure ${percent(tie.exposure, 0)}, `
                  + `affinity ${percent(tie.affinity, 0)}`
                }>
                  <Track share={tie.exposure} color="var(--tie-exposure)" className="h-[0.34rem]" />
                  <Track share={tie.affinity} color="var(--tie-affinity)" className="h-[0.34rem]" />
                  <span className="sr-only">
                    Exposure {percent(tie.exposure, 0)}, affinity{" "}
                    {percent(tie.affinity, 0)}.
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ))}
      <div className={TIE_KEY}>
        <span><i style={{ background: "var(--tie-exposure)" }} /> Exposure</span>
        <span><i style={{ background: "var(--tie-affinity)" }} /> Affinity</span>
      </div>
    </div>
  );
}

