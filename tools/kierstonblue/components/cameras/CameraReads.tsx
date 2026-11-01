"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ChevronDown, MapPin } from "lucide-react";

import { DataBrowser } from "@/components/browse/DataBrowser";
import { DetailActions, type BrowseColumn } from "@/components/browse/BrowseTable";
import { DetailHeading, DetailLead, Drawer, Fact, Facts } from "@/components/browse/detail";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import type { FilterField } from "@/components/browse/FilterBar";
import { BarList, Columns, Swatch } from "@/components/Charts";
import { Block, Grid } from "@/components/console/Section";
import { Chip, CopyChip, VehicleChip, mapHref } from "@/components/console/Chip";
import { useDay } from "@/components/Scope";
import { PersonLink, personName } from "@/components/PersonLink";
import { Tile, Tiles } from "@/components/Tiles";
import {
  Collapsible, CollapsibleContent, CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useCameras } from "@/components/useCameras";
import { useNames } from "@/components/useNames";
import {
  LIGHTING_LABEL, NO_FILTERS, OUTCOME_LABEL, OUTCOME_ORDER, OUTCOME_TONE,
  SOURCE_LABEL, accuracy, byHour, hms, matches, misreadMask, plateHref,
  vanityCount, type ReadFilters,
} from "@/lib/alpr";
import { cameraLabel, ROLE_LABEL, type Role } from "@/lib/cameras";
import { num, percent } from "@/lib/format";
import type { CameraDay, CameraRead } from "@/lib/server/alpr";

/**
 * One plate reader's day: what drove past, and what it said drove past.
 *
 * The camera map answers where the fleet is. It cannot answer the question a
 * fleet is bought to answer — what came out of it — because the siting file
 * holds no reads. This page is the other half: one camera, one exported date,
 * every passage over its edge with the sensor's version of that passage on the
 * same line.
 *
 * What a reader can check here
 * ----------------------------
 * That the plate the camera reported is the plate that went past; that its
 * failures fall where the model says they should — at close headway, at short
 * dwell, in twilight rather than under the illuminator; and that a plate it
 * did report leads somewhere. That last one is the point of the two chips in
 * the detail panel. A resident passage joins to the driver and to the registry
 * entry for the plate. A passage from outside joins to neither, because
 * nothing on the city's register describes it — and rather than say so and
 * stop, the panel shows what the day file itself knows about that lorry.
 */

const HOUR_LABEL = (index: number) => `${String(index).padStart(2, "0")}:00`;

export function CameraReads({ id, date: initial }: { id: string; date: string }) {
  const { fleet } = useCameras();
  const names = useNames();
  const router = useRouter();

  // The server resolved a day before the header had loaded its list; once it
  // has, the header's day is the one to read.
  const { day: chosen, days } = useDay();
  const date = days?.some((item) => item.date === chosen) ? chosen : initial;
  const [day, setDay] = useState<CameraDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReadFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<number | null>(null);
  // Open by default: the shape of the day is the first thing worth seeing.
  // Foldable because the table under it is the thing worth staying in.
  const [shape, setShape] = useState(true);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setDay(null);
    setSelected(null);
    fetch(`/api/cameras/${encodeURIComponent(date)}/${encodeURIComponent(id)}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (cancelled) return;
        setDay(payload as CameraDay);
        setError(null);
      })
      .catch((reason) => {
        if (cancelled) return;
        setDay(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    router.replace(`/cameras/${encodeURIComponent(id)}?date=${encodeURIComponent(date)}`, { scroll: false });
    return () => { cancelled = true; };
  }, [date, id, router]);

  // Whatever cameras.json knows that the day file does not: the street, the
  // aim, the mount it hangs on. The page works without it — a day file names
  // its own cameras — but reads far better with it.
  const sited = useMemo(
    () => fleet?.cameras.find((camera) => camera.id === id) ?? null,
    [fleet, id],
  );

  const reads = day?.reads ?? [];
  const indices = useMemo(() => {
    const kept: number[] = [];
    reads.forEach((read, at) => { if (matches(read, filters)) kept.push(at); });
    return Int32Array.from(kept);
  }, [reads, filters]);

  const hours = useMemo(() => byHour(reads), [reads]);
  const vanity = useMemo(() => vanityCount(reads), [reads]);
  const camera = day?.camera ?? null;
  const right = camera ? accuracy(camera) : null;

  const columns: BrowseColumn[] = [
    {
      id: "second",
      header: "Time",
      width: "6rem",
      sortable: false,
      cell: (index) => <span className="tabular-nums">{hms(reads[index]!.second)}</span>,
    },
    {
      id: "plate",
      header: "Plate",
      width: "10rem",
      cell: (index) => {
        const read = reads[index]!;
        if (!read.plate) return <span className="text-muted-foreground">no plate</span>;
        return (
          <span className="tabular-nums">
            {read.plate}
            {/* A chosen plate is worth marking here rather than only in the
                filter: it is the one property of a plate that a reader
                scanning a column of them would otherwise have to know. */}
            {read.personalized ? (
              <i className="ml-1.5 align-[0.05em] text-[0.66rem] font-medium text-[var(--accent-ink)] not-italic">
                vanity
              </i>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "detected",
      header: "Detected plate",
      width: "10rem",
      cell: (index) => <ReadText read={reads[index]!} />,
    },
    {
      id: "outcome",
      header: "Outcome",
      width: "11rem",
      cell: (index) => {
        const read = reads[index]!;
        return (
          <span>
            <Swatch color={OUTCOME_TONE[read.outcome]} />
            {OUTCOME_LABEL[read.outcome] ?? read.outcome}
          </span>
        );
      },
    },
    {
      id: "confidence",
      header: "Confidence",
      width: "6rem",
      align: "right",
      cell: (index) => {
        const read = reads[index]!;
        return read.detected === null
          ? <span className="text-muted-foreground">—</span>
          : <span>{read.confidence.toFixed(2)}</span>;
      },
    },
    {
      id: "source",
      header: "Vehicle",
      width: "9rem",
      cell: (index) => {
        const read = reads[index]!;
        if (read.source === "external") {
          return <span className="text-muted-foreground">{read.vehicle?.state ?? "outside"}</span>;
        }
        return read.person === null
          ? <span className="text-muted-foreground">resident</span>
          : <span className="truncate">{personName(names, read.person)}</span>;
      },
    },
    {
      id: "lighting",
      header: "Light",
      width: "6.5rem",
      cell: (index) => LIGHTING_LABEL[reads[index]!.lighting] ?? reads[index]!.lighting,
    },
    {
      id: "headway",
      header: "Headway",
      width: "6rem",
      align: "right",
      cell: (index) => {
        const value = reads[index]!.headway;
        return value === null
          ? <span className="text-muted-foreground">—</span>
          : <span>{value.toFixed(1)}s</span>;
      },
    },
    {
      id: "dwell",
      header: "Dwell",
      width: "5.5rem",
      align: "right",
      cell: (index) => <span>{reads[index]!.dwell.toFixed(2)}s</span>,
    },
  ];

  const filterFields: FilterField[] = [
    {
      type: "search",
      key: "query",
      label: "Search",
      placeholder: "Plate or correlation ID",
      grow: true,
    },
    {
      type: "select",
      key: "outcome",
      label: "Outcome",
      options: [
        { value: "any", label: "Any outcome" },
        ...OUTCOME_ORDER.filter((name) => (camera?.outcomes[name] ?? 0) > 0).map((name) => ({
          value: name,
          label: `${OUTCOME_LABEL[name]} · ${num(camera!.outcomes[name] ?? 0)}`,
        })),
      ],
    },
    {
      type: "select",
      key: "plate",
      label: "Plate",
      options: [
        { value: "any", label: "Any plate" },
        { value: "personalized", label: `Personalized · ${num(vanity)}` },
        { value: "standard", label: "Sequential" },
      ],
    },
    {
      type: "select",
      key: "source",
      label: "Vehicle",
      options: [
        { value: "any", label: "Any vehicle" },
        { value: "resident", label: `Resident · ${num(camera?.resident ?? 0)}` },
        { value: "external", label: `External · ${num(camera?.external ?? 0)}` },
      ],
    },
  ];

  const lead = camera
    ? `${ROLE_LABEL[(sited?.role ?? camera.role) as Role] ?? camera.role} reader`
      + `${sited ? ` · ${cameraLabel(sited)}` : ""}`
      + ` · ${camera.side} plate · ${date}`
    : error
      ? <StatusText state="error">{error}</StatusText>
      : "Loading…";

  return (
    <DataBrowser
      title={
        <span className="flex items-baseline gap-2.5">
          <Link
            href="/cameras"
            className="text-[0.78rem] font-normal text-muted-foreground no-underline hover:text-foreground"
          >
            <ArrowLeft className="mb-px inline size-3.5" /> Fleet
          </Link>
          {id}
          {camera ? (
            <Link
              href={mapHref(camera.lat, camera.lon)}
              className="text-[0.78rem] font-normal text-muted-foreground no-underline hover:text-foreground"
            >
              <MapPin className="mb-px inline size-3.5" /> Map
            </Link>
          ) : null}
        </span>
      }
      lead={lead}
      beforeFilters={camera ? (
        <div className="px-1">
          <Tiles compact>
            <Tile value={num(camera.passes)}>Passes</Tile>
            <Tile value={num(camera.reads)}>Detections</Tile>
            <Tile value={right === null ? "—" : percent(right, 1)}>Accuracy</Tile>
            <Tile value={num(camera.outcomes.misread ?? 0)}>Misreads</Tile>
            <Tile value={num(camera.external)}>External vehicles</Tile>
            <Tile value={num(vanity)}>Personalized plates</Tile>
          </Tiles>

          <Collapsible open={shape} onOpenChange={setShape}>
            <CollapsibleTrigger className="mb-3 flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-[0.75rem] text-muted-foreground hover:text-foreground">
              <ChevronDown className={`size-3.5 transition-transform ${shape ? "" : "-rotate-90"}`} />
              Daily distribution
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Grid min="20rem" className="mb-3">
                <Block title="Passes by hour" meta={`${num(camera.passes)} vehicles`}>
                  <Columns
                    bars={hours.passes.map((value, hour) => ({
                      label: HOUR_LABEL(hour),
                      value,
                      title: `${HOUR_LABEL(hour)} · ${num(value)} passes · ${num(hours.read[hour]!)} detections`,
                    }))}
                    label={HOUR_LABEL}
                  />
                </Block>
                <Block title="Outcomes" meta={`${num(camera.passes)} passes`}>
                  <BarList
                    total={camera.passes}
                    bands={OUTCOME_ORDER
                      .filter((name) => (camera.outcomes[name] ?? 0) > 0)
                      .map((name) => ({
                        label: OUTCOME_LABEL[name] ?? name,
                        value: camera.outcomes[name] ?? 0,
                      }))}
                  />
                </Block>
              </Grid>
            </CollapsibleContent>
          </Collapsible>
        </div>
      ) : null}
      filters={camera ? filterFields : undefined}
      filterValues={{ ...filters }}
      onFilterChange={(key, value) => {
        setFilters((current) => ({ ...current, [key]: String(value) }));
      }}
      table={camera ? {
        indices,
        columns,
        selected,
        onSelect: setSelected,
        empty: {
          title: camera.passes ? "No matching records" : "No passes",
          body: null,
          onClear: camera.passes ? () => setFilters(NO_FILTERS) : undefined,
        },
      } : null}
      loading={
        error
          ? <EmptyState title="No detection records">{error}</EmptyState>
          : <EmptyState>Loading detection records…</EmptyState>
      }
      detail={
        selected !== null && reads[selected]
          ? <ReadDetail read={reads[selected]!} date={date} names={names} onClose={() => setSelected(null)} />
          : null
      }
    />
  );
}

/** The detected text, with the characters it got wrong marked. */
function ReadText({ read }: { read: CameraRead }) {
  if (read.detected === null) {
    return <span className="text-muted-foreground">none</span>;
  }
  const mask = misreadMask(read.plate, read.detected);
  if (!mask) {
    return (
      <span className="tabular-nums" style={{ color: read.outcome === "correct" ? undefined : "var(--destructive)" }}>
        {read.detected}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {[...read.detected].map((character, at) => (
        <span
          key={at}
          style={mask[at] ? { color: "var(--destructive)", fontWeight: 600 } : undefined}
        >
          {character}
        </span>
      ))}
    </span>
  );
}

/**
 * One passage, twice: what was there, and what the camera said.
 *
 * The two halves are separate sections rather than one merged fact list on
 * purpose. Merging them would let a reader take the plate out of the panel
 * without noticing which of the two columns it came from, and the difference
 * between those columns is the only thing this page exists to show.
 */
function ReadDetail({ read, date, names, onClose }: {
  read: CameraRead;
  date: string;
  names: ReturnType<typeof useNames>;
  onClose: () => void;
}) {
  const external = read.source === "external";
  return (
    <Drawer onClose={onClose}>
      <DetailLead
        sub={
          <>
            <Swatch color={OUTCOME_TONE[read.outcome]} />
            {OUTCOME_LABEL[read.outcome] ?? read.outcome}
            {" · "}
            {SOURCE_LABEL[read.source] ?? read.source} vehicle
          </>
        }
      >
        {hms(read.second)}
      </DetailLead>

      <DetailActions>
        {external ? null : read.person === null ? null : (
          <PersonLink names={names} person={read.person} />
        )}
        {read.plate && !external ? (
          <Chip kind="vehicle" href={plateHref(read.plate)} title="Registry entry">
            {read.plate}
          </Chip>
        ) : null}
        {/* The plate reaches the register; the VIN reaches the day this pass
            was one minute of. */}
        {read.vin ? <VehicleChip vin={read.vin} date={date}>Movements</VehicleChip> : null}
        <CopyChip value={read.correlation}>Audit id</CopyChip>
      </DetailActions>

      <DetailHeading>Pass</DetailHeading>
      <Facts cols={3}>
        <Fact label="Day"><Link href={`/days?date=${date}`}>{date}</Link></Fact>
        <Fact label="Plate">
          {read.plate ?? <span className="text-muted-foreground">none</span>}
        </Fact>
        <Fact label="Issued by">{read.jurisdiction ?? "—"}</Fact>
        <Fact label="Plate type">
          {read.source === "external"
            ? <span className="text-muted-foreground">unregistered</span>
            : read.personalized ? "personalized" : "sequential"}
        </Fact>
        <Fact label="Side read">{read.side}</Fact>
        <Fact label="Vehicle">{SOURCE_LABEL[read.source] ?? read.source}</Fact>
        <Fact label={external ? "Trip" : "Leg"}>{read.movement}</Fact>
      </Facts>

      <DetailHeading>Detection</DetailHeading>
      <Facts cols={3}>
        <Fact label="Detected">
          {read.detected ?? <span className="text-muted-foreground">none</span>}
        </Fact>
        <Fact label="Normalised">{read.canonical ?? "—"}</Fact>
        <Fact label="Confidence">
          {read.detected === null ? "—" : read.confidence.toFixed(3)}
        </Fact>
        <Fact label="Lighting">{LIGHTING_LABEL[read.lighting] ?? read.lighting}</Fact>
        <Fact label="Headway">
          {read.headway === null ? "—" : `${read.headway.toFixed(2)} s`}
        </Fact>
        <Fact label="Dwell">{read.dwell.toFixed(3)} s</Fact>
      </Facts>

      {external ? (
        <>
          <DetailHeading>External vehicle</DetailHeading>
          {read.vehicle ? (
            <Facts>
              <Fact label="Plate">{read.vehicle.plate}</Fact>
              <Fact label="Registered">{read.vehicle.state}</Fact>
              <Fact label="Vehicle">
                {[read.vehicle.modelYear || null, read.vehicle.make, read.vehicle.model]
                  .filter(Boolean).join(" ") || "—"}
              </Fact>
              <Fact label="Body">{read.vehicle.body ?? "—"}</Fact>
              <Fact label="Colour">{read.vehicle.colour ?? "—"}</Fact>
              <Fact label="Kind">{read.vehicle.kind}</Fact>
              {read.trip ? <Fact label="Trip kind">{read.trip.kind}</Fact> : null}
              {read.trip ? (
                <Fact label="Trip time">
                  {hms(read.trip.depart)} – {hms(read.trip.arrive)}
                </Fact>
              ) : null}
            </Facts>
          ) : null}
        </>
      ) : (
        <>
          <DetailHeading>Associations</DetailHeading>
          <Facts>
            <Fact label="Driver">
              {read.person === null
                ? <span className="text-muted-foreground">unresolved</span>
                : <PersonLink names={names} person={read.person} />}
            </Fact>
            <Fact label="Registry">
              {read.plate
                ? <Chip kind="vehicle" href={plateHref(read.plate)}>{read.plate}</Chip>
                : <span className="text-muted-foreground">no plate</span>}
            </Fact>
          </Facts>
        </>
      )}
    </Drawer>
  );
}
