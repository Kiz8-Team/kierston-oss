"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import { PersonLink } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import type { AreaCell, Metric } from "@/lib/analysis";
import type { Building, BuildingData, Poi, PoiData } from "@/lib/datasets";
import { clock, siteLabel, type Assignment, type Employment, type Site } from "@/lib/employment";
import {
  BAND_LABEL, SECTOR_LABEL, schoolLabel, type Enrollment, type School,
} from "@/lib/enrollment";
import { coords, num, percent, title, usd } from "@/lib/format";
import type { Labels } from "@/lib/labels";
import { UNIT_SOURCES } from "@/lib/map-style";
import type { Selection } from "@/lib/map-render";
import { RACE_LABEL, type Population } from "@/lib/population";

/**
 * The bubble over whatever was last clicked, with the little diamond under it
 * pointing at the thing. `bg-inherit` on the diamond keeps it the same colour
 * as the body without naming the colour twice.
 */
const POPUP = "absolute z-[700] max-h-[min(24rem,72vh)] max-w-[15rem] "
  + "-translate-x-1/2 -translate-y-full overflow-auto overscroll-contain "
  + "rounded-sm border border-border bg-card px-[0.7rem] py-2 text-[0.78rem] "
  + "shadow-[0_2px_12px_rgb(20_30_40/28%)] "
  + "after:absolute after:bottom-[-0.3rem] after:left-1/2 after:size-[0.5rem] "
  + "after:-translate-x-1/2 after:rotate-45 after:bg-inherit after:content-['']";

/** The line under the title — what kind of thing this is. */
const SUB = "block text-[0.7rem] text-muted-foreground";

const TITLE = "block";

const ADDRESS = "mt-1 block text-[0.74rem] text-foreground";

/** A geocoded address is the nearest match, not a value the mapper recorded. */
const APPROXIMATE = "after:text-muted-foreground after:italic after:content-['_(nearest)']";

/** Coordinates and the OSM id: reference data, set small for reference. */
const META = "mt-[0.15rem] block font-sans text-[11.5px] text-muted-foreground "
  + "[&_a]:text-inherit";

const TAG_LIST = "mt-[0.4rem] grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] "
  + "gap-x-[0.55rem] gap-y-[0.12rem] border-t border-border pt-[0.35rem] "
  + "text-[0.68rem] leading-[1.35] "
  + "[&_dt]:m-0 [&_dt]:font-medium [&_dt]:break-words [&_dt]:text-muted-foreground "
  + "[&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:[overflow-wrap:anywhere]";

/** A titled group — who lives here, who works here. */
const GROUP = "mt-2 [&>b]:mb-[0.3rem] [&>b]:block [&>b]:text-[0.7rem] "
  + "[&>b]:tracking-[0.04em] [&>b]:text-muted-foreground [&>b]:uppercase";

const HOUSEHOLD = "mt-[0.4rem] border-t border-muted pt-[0.4rem] "
  + "first-of-type:mt-0 first-of-type:border-t-0 first-of-type:pt-0 "
  + "[&>span]:block [&>span]:text-[0.72rem] [&>span]:font-semibold "
  + "[&>span>em]:font-normal [&>span>em]:text-muted-foreground [&>span>em]:not-italic "
  + "[&>ul]:mt-[0.15rem] [&>ul]:pl-[0.8rem] "
  + "[&_li]:text-[0.72rem] [&_li]:text-muted-foreground";

/** Counts and their labels, the count in a fixed column so they stack. */
const ROSTER = "mt-[0.15rem] list-none pl-[0.1rem] "
  + "[&>li]:text-[0.72rem] [&>li]:text-muted-foreground "
  + "[&>li>b]:inline-block [&>li>b]:min-w-[1.4rem] [&>li>b]:font-semibold "
  + "[&>li>b]:text-foreground [&>li>b]:tabular-nums";

const SHIFTS = "mt-[0.3rem] block text-[0.7rem] text-muted-foreground";

const CELL_STATS = "mt-[0.45rem] grid gap-[0.18rem] "
  + "[&>div]:flex [&>div]:justify-between [&>div]:gap-4 [&>div]:text-[0.73rem] "
  + "[&>div>span:first-child]:text-muted-foreground "
  + "[&>div>span:last-child]:tabular-nums";

const HEADLINE = "mt-[0.35rem] text-[1.05rem] font-semibold tabular-nums";

/** The bubble over whatever was last clicked. */
export function MapPopup({
  selection, pois, buildings, population, employment, enrollment, labels, showResidents, metric,
}: {
  selection: Selection;
  pois: PoiData | null;
  buildings: BuildingData | null;
  population: Population | null;
  employment: Employment | null;
  enrollment: Enrollment | null;
  labels: Labels | null;
  showResidents: boolean;
  metric: Metric | null;
}) {
  if (selection.kind === "poi") {
    return <PoiBody poi={selection.poi} pois={pois} />;
  }
  if (selection.kind === "site") {
    return (
      <SiteBody site={selection.site} employment={employment} labels={labels} />
    );
  }
  if (selection.kind === "school") {
    return (
      <SchoolBody school={selection.school} enrollment={enrollment} labels={labels} />
    );
  }
  if (selection.kind === "building") {
    return (
      <BuildingBody
        building={selection.building}
        buildings={buildings}
        population={showResidents ? population : null}
        employment={employment}
        labels={labels}
      />
    );
  }
  return <CellBody cell={selection.cell} metric={metric} />;
}

export function popupClass(selection: Selection | null): string {
  if (!selection) return POPUP;
  const wide = selection.kind === "building" || selection.kind === "cell";
  return cn(POPUP, wide && "max-w-[19rem]", selection.kind === "site" && "max-w-[17rem]");
}

function Address({ text, approximate }: { text: string; approximate?: boolean }) {
  if (!text) return <span className={cn(ADDRESS, "text-muted-foreground")}>No address</span>;
  // A geocoded address is the nearest match to the point, not a value the
  // mapper recorded, so it is labelled as such.
  return <span className={cn(ADDRESS, approximate && [APPROXIMATE, "text-muted-foreground"])}>{text}</span>;
}

function PoiBody({ poi, pois }: { poi: Poi; pois: PoiData | null }) {
  const group = pois?.groups[poi[2]];
  return (
    <>
      <strong className={TITLE}>{poi[4] || "Unnamed"}</strong>
      <span className={SUB}>
        {pois?.typeLabel.get(poi[3]) ?? "point"}
        {group ? ` · ${group.label}` : ""}
      </span>
      <Address text={poi[5]} approximate={poi[6] === 1} />
      <span className={META}>{coords(poi[0], poi[1])}</span>
    </>
  );
}

function tagValue(key: string, value: string) {
  if (/^(https?:\/\/|www\.)/i.test(value) || key === "website" || key.endsWith(":website")) {
    const href = /^https?:\/\//i.test(value) ? value : `https://${value}`;
    return <a href={href} target="_blank" rel="noopener noreferrer">{value}</a>;
  }
  if (key === "email" || key.endsWith(":email")) return <a href={`mailto:${value}`}>{value}</a>;
  if (key === "phone" || key === "fax" || key.startsWith("contact:phone")
      || key.startsWith("contact:mobile")) {
    return <a href={`tel:${value.replace(/[^\d+]/g, "")}`}>{value}</a>;
  }
  return value;
}

function BuildingBody({
  building, buildings, population, employment, labels,
}: {
  building: Building;
  buildings: BuildingData | null;
  population: Population | null;
  employment: Employment | null;
  labels: Labels | null;
}) {
  const [lat, lon, category, kind, levels, flats, name, address, tags, osmId, , units, unitsSource]
    = building;
  const parts = [buildings?.categories[category]?.label, kind].filter(Boolean) as string[];
  if (levels) parts.push(`${levels} floor${levels === 1 ? "" : "s"}`);
  if (flats) parts.push(`${flats} flats`);
  const entries = tags
    ? Object.entries(tags).filter(([, value]) => value != null && value !== "")
        .sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <>
      <strong className={TITLE}>{name || title(kind)}</strong>
      <span className={SUB}>{parts.join(" · ")}</span>
      <Address text={address} />
      <dl className={TAG_LIST}>
        <dt>dwelling units</dt>
        <dd>
          {units ? (
            <>
              {units}
              <span className="text-muted-foreground"> — {UNIT_SOURCES[unitsSource] ?? unitsSource}</span>
            </>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </dd>
      </dl>
      {population ? <Residents osmId={osmId} population={population} /> : null}
      {employment && labels ? (
        <Workforce staff={employment.staffOfOsmId(osmId)} labels={labels} />
      ) : null}
      {entries.length ? (
        <dl className={TAG_LIST}>
          {entries.map(([key, value]) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>{key.replace(/_/g, " ")}</dt>
              <dd>{tagValue(key, String(value))}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {osmId ? (
        <span className={META}>
          <a href={`https://www.openstreetmap.org/${osmId}`} target="_blank" rel="noopener noreferrer">
            {osmId}
          </a>
        </span>
      ) : null}
      <span className={META}>{coords(lat, lon)}</span>
    </>
  );
}

function Residents({ osmId, population }: { osmId: string; population: Population }) {
  // Loaded here rather than by the map: it is the first popup over a house
  // that needs a name, and nothing else on this page does.
  const names = useNames();
  const buildingIndex = population.buildingByOsmId.get(osmId);
  if (buildingIndex === undefined) return null;
  const ids = population.householdsByBuilding.get(buildingIndex) ?? [];
  if (!ids.length) {
    return (
      <div className={GROUP}>
        <b>Residents</b>
        <span className="text-muted-foreground">Vacant</span>
      </div>
    );
  }

  const households = ids.map((id) => population.household(id));
  const people = households.reduce((sum, household) => sum + household.size, 0);
  return (
    <div className={GROUP}>
      <b>
        {households.length} household{households.length === 1 ? "" : "s"} · {people}{" "}
        resident{people === 1 ? "" : "s"}
      </b>
      {households.map((household) => (
        <div className={HOUSEHOLD} key={household.index}>
          <span>
            Unit {household.unit + 1} — {household.size}{" "}
            {household.size === 1 ? "person" : "people"}{" "}
            <em>{usd(household.income)} · {Math.round(household.area)} m²</em>
          </span>
          <ul>
            {household.members.map((member) => (
              <li key={member.index}>
                <PersonLink names={names} person={member.index} />
                {` — ${member.relationship}, ${member.age}, ${member.sex},`}
                {` ${RACE_LABEL[member.race] ?? member.race}`}
                {/* Children have no employment status worth printing. */}
                {member.age >= 16 ? `, ${member.employment}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function SiteBody({
  site, employment, labels,
}: {
  site: Site;
  employment: Employment | null;
  labels: Labels | null;
}) {
  const staff = employment ? site.staff.map((index) => employment.assignments[index]) : [];
  const parts = [
    title(site.klass.replace(/_/g, " ")),
    site.floor ? `${num(site.floor)} m² of floor` : null,
  ].filter(Boolean);

  return (
    <>
      <strong className={TITLE}>{siteLabel(site)}</strong>
      <span className={SUB}>{parts.join(" · ")}</span>
      <Address text={site.address} />
      <dl className={TAG_LIST}>
        <dt>staff</dt>
        <dd>{num(staff.length)}</dd>
        {site.capacity ? (
          <>
            <dt>seats</dt>
            <dd>
              {num(site.capacity)}
              <span className="text-muted-foreground">
                {" "}— {percent(Math.min(1, staff.length / site.capacity), 0)} filled
              </span>
            </dd>
          </>
        ) : null}
        {site.industries.length && labels ? (
          <>
            <dt>industry</dt>
            <dd>{site.industries.map((code) => labels.industryLabel(code)).join(", ")}</dd>
          </>
        ) : null}
        {site.role ? (<><dt>role</dt><dd>{title(site.role)}</dd></>) : null}
      </dl>
      {labels ? <Workforce staff={staff} labels={labels} /> : null}
      <span className={META}>
        <Link href={`/workplaces?site=${encodeURIComponent(site.id)}`}>Open in workplaces</Link>
      </span>
      <span className={META}>{coords(site.lat, site.lon)}</span>
    </>
  );
}

function SchoolBody({
  school, enrollment, labels,
}: {
  school: School;
  enrollment: Enrollment | null;
  labels: Labels | null;
}) {
  const roll = enrollment ? school.students.map((i) => enrollment.assignments[i]) : [];
  const parts = [
    school.bands.map((band) => BAND_LABEL[band]).join(" / "),
    SECTOR_LABEL[school.sector],
    school.floor ? `${num(school.floor)} m² of floor` : null,
  ].filter(Boolean);

  const grades = new Map<string, number>();
  for (const student of roll) {
    const label = labels?.gradeLabel(student.grade) || BAND_LABEL[student.band];
    grades.set(label, (grades.get(label) ?? 0) + 1);
  }
  const ranked = [...grades.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));

  const trips = roll
    .map((student) => student.travel)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return (
    <>
      <strong className={TITLE}>{schoolLabel(school)}</strong>
      <span className={SUB}>{parts.join(" · ")}</span>
      <dl className={TAG_LIST}>
        <dt>roll</dt>
        <dd>{num(roll.length)}</dd>
        {school.capacity ? (
          <>
            <dt>places</dt>
            <dd>
              {num(school.capacity)}
              <span className="text-muted-foreground">
                {" "}— {percent(roll.length / school.capacity, 0)} filled
              </span>
            </dd>
          </>
        ) : null}
        {trips.length ? (
          <>
            <dt>travel</dt>
            <dd>
              {trips[trips.length >> 1]} min median
              <span className="text-muted-foreground"> · {trips[trips.length - 1]} min farthest</span>
            </dd>
          </>
        ) : null}
        {school.banded ? null : (
          <>
            <dt>band</dt>
            <dd><span className="text-muted-foreground">inferred</span></dd>
          </>
        )}
      </dl>
      {ranked.length ? (
        <div className={GROUP}>
          <b>{num(roll.length)} student{roll.length === 1 ? "" : "s"}</b>
          <ul className={ROSTER}>
            {ranked.slice(0, WORKFORCE_LIMIT).map(([label, count]) => (
              <li key={label}><b>{count}</b> {label}</li>
            ))}
            {ranked.length > WORKFORCE_LIMIT ? (
              <li className="text-muted-foreground">+{ranked.length - WORKFORCE_LIMIT} other grades</li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <span className={META}>
        <Link href={`/schools?school=${encodeURIComponent(school.id)}`}>Open in schools</Link>
      </span>
      <span className={META}>{coords(school.lat, school.lon)}</span>
    </>
  );
}

const WORKFORCE_LIMIT = 12;

/** Who was assigned to a place, most common occupation first. */
function Workforce({ staff, labels }: { staff: Assignment[]; labels: Labels }) {
  if (!staff.length) return null;

  const counts = new Map<string, number>();
  for (const assignment of staff) {
    const label = labels.occupationLabel(assignment.occupation);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const shifts = staff
    .map((assignment) => assignment.depart)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  return (
    <div className={GROUP}>
      <b>{num(staff.length)} worker{staff.length === 1 ? "" : "s"}</b>
      <ul className={ROSTER}>
        {ranked.slice(0, WORKFORCE_LIMIT).map(([label, count]) => (
          <li key={label}>
            <b>{count}</b> {label}
          </li>
        ))}
        {ranked.length > WORKFORCE_LIMIT ? (
          <li className="text-muted-foreground">+{ranked.length - WORKFORCE_LIMIT} other occupations</li>
        ) : null}
      </ul>
      {shifts.length ? (
        <span className={SHIFTS}>
          Departures {clock(shifts[0])}–{clock(shifts[shifts.length - 1])}
        </span>
      ) : null}
    </div>
  );
}

function CellBody({ cell, metric }: { cell: AreaCell; metric: Metric | null }) {
  const value = metric ? metric.value(cell) : NaN;
  const residents = cell.people;
  const rows: [string, string][] = [
    ["Residents", num(residents)],
    ["Households", num(cell.households)],
    ["Average household", cell.households ? ((residents - cell.quarters) / cell.households).toFixed(2) : "—"],
    ["Average age", residents ? `${(cell.ageSum / residents).toFixed(1)} years` : "—"],
    ["Median income", cell.households ? usd(cell.medianIncome) : "—"],
    ["Under 18", residents ? `${((cell.under18 / residents) * 100).toFixed(1)}%` : "—"],
    ["Over 64", residents ? `${((cell.over64 / residents) * 100).toFixed(1)}%` : "—"],
    ["Employed, 16–64", cell.workingAge ? `${((cell.employed / cell.workingAge) * 100).toFixed(1)}%` : "—"],
  ];
  if (cell.quarters) rows.splice(2, 0, ["In group quarters", num(cell.quarters)]);

  return (
    <>
      <strong className={TITLE}>{metric?.label ?? "Area"}</strong>
      <span className={SUB}>
        {Math.round(Math.sqrt(cell.areaKm2) * 1000)} m cell · {coords(
          (cell.south + cell.north) / 2, (cell.west + cell.east) / 2)}
      </span>
      <p className={HEADLINE}>
        {metric && Number.isFinite(value) ? metric.format(value)
          : metric?.id === "rent" ? "Too few renters"
            : "Too few households"}
      </p>
      <div className={CELL_STATS}>
        {rows.map(([label, text]) => (
          <div key={label}>
            <span>{label}</span>
            <span>{text}</span>
          </div>
        ))}
      </div>
    </>
  );
}
