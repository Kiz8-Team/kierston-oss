"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { Section } from "@/components/console/Section";
import { EmptyState } from "@/components/browse/EmptyState";
import { Micro } from "@/components/console/Panel";
import {
  ConsoleButton,
  ConsoleLinkStyle,
  Field,
  Fields,
  Placeholder,
} from "@/components/console/Record";
import { AddressChip, ButtonChip, Chip, CopyChip, mapHref } from "@/components/console/Chip";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SocialCircle } from "@/components/social/SocialCircle";
import { PersonLink } from "@/components/PersonLink";
import { ValueCell, isBlank } from "@/components/records/Value";
import { EgoGraph } from "@/components/social/EgoGraph";
import { cn } from "@/lib/utils";
import { useDossierData } from "@/components/useRecords";
import { useTieGraph } from "@/components/useTies";
import { buildDossier, type DossierGroup, type DossierSection } from "@/lib/dossier";
import { clock, siteLabel } from "@/lib/employment";
import { BAND_LABEL, schoolLabel } from "@/lib/enrollment";
import { humanise, num, percent, usd } from "@/lib/format";
import type { Identity } from "@/lib/identity";
import {
  BASIS_NOTE, PARENT_LABEL, TIE_LABEL, externalLabel,
  type Kinship, type ParentEdge,
} from "@/lib/kinship";
import type { Population } from "@/lib/population";
import { rememberPerson } from "@/lib/recent";
import { TIER_LABEL, relationLabel, type TieGraph } from "@/lib/ties";
import type { RecordTable } from "@/lib/records";

/** The measure every band's content is set to, matched by the header. */
const MEASURE = "mx-auto max-w-[78rem] px-7 max-[51.25rem]:px-4";

/** A heading inside a section — Parents, Siblings, Estranged. */
const SUBHEAD = "mt-4 mb-1.5 first:mt-0";

/**
 * One label column and one column measure for the whole page.
 *
 * Every value on the record starts at the same distance from its label, in
 * every section, so the eye can run down the page instead of re-finding the
 * column each time a heading goes by. Sizing each list to its own longest
 * label is what turns a document into a salad.
 *
 * Facts are one per line at every width. They used to reflow into columns of
 * `COLUMNS` once there was room, which read as a grid of boxes rather than a
 * document and put the next fact to the right of the last one instead of
 * under it. `COLUMNS` still measures the people rosters, where a column of
 * names *is* the thing being read.
 */
const LABELS = "9rem";
const COLUMNS = "21rem";

/**
 * A list of people, which is not a list of facts.
 *
 * A relative or a housemate is a relation and a person, not a key and a value,
 * and forcing them through the field grid left a column of names ragging
 * against a column of ages. They are set as lines: what they are, who they
 * are, and how old — read as a phrase, the way you would say it.
 */
function People({ children }: { children: React.ReactNode }) {
  return (
    <ul
      className="m-0 grid list-none gap-x-8 gap-y-1 p-0"
      style={{ gridTemplateColumns: `repeat(auto-fill,minmax(${COLUMNS},1fr))` }}
    >
      {children}
    </ul>
  );
}

function Person({ relation, hint, children, detail }: {
  relation: React.ReactNode;
  /** Why the relation is what it is — which parent makes them a half sibling. */
  hint?: string;
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    // The relation sits at the right end of the line. Down a roster of a dozen
    // people the names are what you are reading, and a leading "Householder"
    // pushed every one of them to a different place on the line.
    <li className="flex items-baseline gap-2 text-[0.85rem]">
      <span className="min-w-0 truncate">
        {children}
        {detail ? <span className="text-muted-foreground">, {detail}</span> : null}
      </span>
      <span className="ml-auto shrink-0 text-[0.8rem] text-muted-foreground" title={hint}>
        {relation}
      </span>
    </li>
  );
}

/**
 * Everything about one person, across every dataset.
 *
 * The record browsers answer "what do the mortgages look like"; this answers
 * "who is this". It is the view that shows the generators agreeing with each
 * other — the licence suspension that names a docket, the auto loan secured
 * against a VIN that is also in the vehicle table, the firearms bar that comes
 * from a conviction three sections further up — and the fastest way to spot it
 * when they do not.
 *
 * It is set as one document rather than a stack of panels: the identity bar
 * holds still at the top, an index says what is below it, and every section
 * after that is a rule across the page with its name in the left margin.
 * Sections a person has no rows for are absent rather than empty, so the length
 * of the page is itself information — most residents are two screens, and the
 * ones that run long are the ones worth reading.
 */
export function PersonRecord() {
  const { population, identity, employment, enrollment, kinship, labels, sets, error, elapsed } =
    useDossierData();
  // The social graph is 55 MB and most of this page is readable without it, so
  // it loads behind everything else and the circle appears when it lands.
  const ties = useTieGraph();
  const params = useSearchParams();
  const router = useRouter();

  const requested = Number(params.get("person"));
  const person = Number.isFinite(requested) && requested >= 0 ? Math.floor(requested) : 0;

  const dossier = useMemo(
    () => (identity && identity.knows(person) ? buildDossier(person, identity, sets) : null),
    [identity, person, sets],
  );

  const open = (next: number) => {
    router.replace(`/record?person=${next}`, { scroll: true });
  };

  // Reading a record is what makes someone worth coming back to, so this is
  // where the command palette's recent list is fed. It waits for identity so a
  // resident id that turns out not to exist never lands in it.
  const known = identity?.knows(person) ?? false;
  useEffect(() => {
    if (known) rememberPerson(person);
  }, [known, person]);

  if (error) {
    return (
      <Shell>
        <Placeholder title="No records">
          {error}
          <br />
          <Cmd>python kierston/init/personal_records/pack_records.py</Cmd>
        </Placeholder>
      </Shell>
    );
  }

  if (!population || !identity || !labels || !dossier) {
    return (
      <Shell>
        <Placeholder title="Loading record" />
      </Shell>
    );
  }

  const resident = population.resident(person);
  const home = population.building(population.residentBuilding(person));
  const household = population.residentHousehold(person);
  const job = employment?.forPerson(person) ?? null;
  const study = enrollment?.forPerson(person) ?? null;
  const workplace = employment?.siteOf(job) ?? null;
  // Population carries the respondent's occupation even when no simulated
  // workplace assignment was produced. Prefer the assignment when it exists,
  // but do not make occupation disappear just because the work join is absent.
  const occupationCode = job?.occupation || resident.occupation;
  const occupationName = labels.occupationLabel(occupationCode);
  const occupationGroup = labels.occupationGroupLabel(occupationCode);
  const industryCode = job?.industry || resident.industry;
  const school = enrollment?.schoolOf(study) ?? null;
  const housemates = household >= 0
    ? population.household(household).members.filter((member) => member.index !== person)
    : [];

  return (
    <main id="content" className="relative h-full overflow-auto">
      {/* Who this is stays on screen: the page is long, and by the third
          section it is otherwise easy to forget whose record you are reading. */}
      <header className="sticky top-0 z-20 border-b border-border bg-[var(--canvas)]/92 backdrop-blur-sm">
        <div className={cn(MEASURE, "flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5")}>
          <h1 className="min-w-0 flex-1 truncate text-[1.15rem] leading-tight font-semibold tracking-[-0.01em]">
            {identity.name(person)}
          </h1>

          <PersonPicker identity={identity} person={person} onOpen={open} />

          <Link className={ConsoleLinkStyle()} href={`/days?person=${person}`}>
            Daily movement
          </Link>
          {/* Previous and next walk the resident numbering, which is household
              order — the neighbours of a record are usually the rest of its
              household. */}
          <span className="inline-flex shrink-0 overflow-hidden rounded-md border border-border">
            <ConsoleButton
              className="rounded-none border-0 border-r border-border px-1.5 disabled:opacity-40"
              onClick={() => open(person > 0 ? person - 1 : 0)}
              disabled={person === 0}
              aria-label="Previous resident id"
              title="Previous resident id"
            >
              <ChevronLeft className="size-3.5" aria-hidden />
            </ConsoleButton>
            <ConsoleButton
              className="rounded-none border-0 px-1.5"
              onClick={() => open(person + 1)}
              aria-label="Next resident id"
              title="Next resident id"
            >
              <ChevronRight className="size-3.5" aria-hidden />
            </ConsoleButton>
          </span>
        </div>
      </header>

      <div className={cn(MEASURE, "pt-4 pb-16")}>
        <Section title="Person" meta={elapsed ? `loaded in ${(elapsed / 1000).toFixed(1)}s` : undefined}>
          <Fields labels={LABELS}>
            <Field label="Age">{resident.age}</Field>
            <Field label="Sex">{resident.sex}</Field>
            {identity.birthDate(person) ? (
              <Field label="Born">{identity.birthDate(person)}</Field>
            ) : null}
            <Field label="Address">
              {/* AddressChip is already a place chip — wrapping it in another
                  one nested a link inside a link and drew the pin twice. */}
              {home.address
                ? <AddressChip address={home.address} lat={home.lat} lon={home.lon} />
                : <Chip kind="place" href={mapHref(home.lat, home.lon)}>No address</Chip>}
            </Field>
            <Field label="Household">
              {household >= 0
                ? `${num(population.household(household).size)} people`
                : "Group quarters"}
            </Field>
            <Field label="Resident id">
              <CopyChip value={String(person)} />
            </Field>
          </Fields>
        </Section>

        {resident.age >= 16 || job || occupationCode ? (
          <Section title="Work">
            <Fields labels={LABELS}>
              <Field label="Occupation">
                {occupationName
                  || (resident.age < 16 ? "Under 16" : "None")}
              </Field>
              {occupationGroup ? (
                <Field label="Occupation group">{occupationGroup}</Field>
              ) : null}
              <Field label="Status">{humanise(resident.employment)}</Field>
              {industryCode ? (
                <Field label="Industry">{labels.industryLabel(industryCode)}</Field>
              ) : null}
              {job ? (
                <Field label="Workplace">
                  {workplace ? (
                    <Chip kind="building" href={mapHref(workplace.lat, workplace.lon)}>
                      {siteLabel(workplace)}
                    </Chip>
                  ) : siteLabel(workplace)}
                </Field>
              ) : null}
              {job?.role ? <Field label="Role">{humanise(job.role)}</Field> : null}
              {job && job.hours !== null ? (
                <Field label="Hours a week">{num(job.hours)}</Field>
              ) : null}
              {job ? <Field label="Departure">{clock(job.depart)}</Field> : null}
              {job ? <Field label="Arrival">{clock(job.arrive)}</Field> : null}
              {job && job.travel !== null ? (
                <Field label="Commute">{num(job.travel)} min</Field>
              ) : null}
              {resident.income ? (
                <Field label="Personal income">{usd(resident.income)}</Field>
              ) : null}
              {occupationCode ? (
                <Field label={resident.soc ? "OCCP, SOC" : "OCCP"}>
                  <span className="inline-flex flex-wrap gap-1">
                    <CopyChip value={String(occupationCode)} />
                    {resident.soc ? <CopyChip value={String(resident.soc)} /> : null}
                  </span>
                </Field>
              ) : null}
            </Fields>
          </Section>
        ) : null}

        {study ? (
          <Section title="School">
            <Fields labels={LABELS}>
              <Field label="School">
                {school ? (
                  <Chip kind="building" href={mapHref(school.lat, school.lon)}>
                    {schoolLabel(school)}
                  </Chip>
                ) : schoolLabel(null)}
              </Field>
              <Field label="Band">{BAND_LABEL[study.band]}</Field>
            </Fields>
          </Section>
        ) : null}

        {/* The household is the one edge the population already holds, and a
            record that named it by number and stopped was asking the reader to
            go and look it up by hand. */}
        {housemates.length ? (
          <Section title="Housemates" meta={num(housemates.length)}>
            <People>
              {housemates.map((member) => (
                <Person
                  key={member.index}
                  relation={humanise(member.relationship)}
                  detail={`${member.age}, ${member.sex}`}
                >
                  <PersonLink names={identity} person={member.index} />
                </Person>
              ))}
            </People>
          </Section>
        ) : null}

        {kinship && kinship.hasFamily(person) ? (
          <Family
            kinship={kinship}
            identity={identity}
            population={population}
            person={person}
          />
        ) : null}

        {ties && ties.degreeOf(person) > 0 ? (
          <Circle
            ties={ties}
            identity={identity}
            population={population}
            person={person}
            onOpen={open}
          />
        ) : null}

        {dossier.records > 0 ? <RecordGroups groups={dossier.groups} /> : null}

        {dossier.records === 0 ? (
          <EmptyState title="No records" />
        ) : null}
      </div>
    </main>
  );
}

/** The page before it has anything to say — an error, or the first load. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className={cn(MEASURE, "py-16")}>{children}</div>
    </main>
  );
}

/** A path or a command in the body face, set apart by its surface. */
function Cmd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-[0.25rem] bg-[var(--panel-sunken)] px-1 py-0.5 text-[0.95em] text-foreground">
      {children}
    </span>
  );
}

/**
 * The family, which is the one part of a record that is nearly all links.
 *
 * "Lives with" above it is the household roster and stops at the front door.
 * This is the graph kinship.py built across the whole city: the mother two
 * neighbourhoods away, the half sibling in another household who shares her,
 * the grandparent three generations into the same extract. Each row is somebody
 * with a record of their own, so the section is also the way to walk the
 * population by family rather than by resident id.
 *
 * Relatives who are not in the population — a parent who died or moved away —
 * are shown rather than dropped. They are the reason a person has one parent
 * listed instead of two, and a section that silently omitted them would look
 * like a generator that had failed to fill the slot.
 */
function Family({ kinship, identity, population, person }: {
  kinship: Kinship;
  identity: Identity;
  population: Population;
  person: number;
}) {
  const parents = kinship.parentsOf(person);
  const grandparents = kinship.grandparentsOf(person);
  const siblings = kinship.siblingsOf(person);
  const partner = kinship.partnerOf(person);
  // Oldest first, which is how anybody would write a family down, and which the
  // id order the graph is stored in has nothing to do with.
  const byAge = (a: number, b: number) =>
    population.resident(b).age - population.resident(a).age;
  const children = [...kinship.childrenOf(person)]
    .filter((id) => !kinship.isExternal(id))
    .sort(byAge);

  const total = parents.length + grandparents.length + siblings.length
    + children.length + (partner ? 1 : 0);

  /** One relative: what they are to this person, then who they are. */
  const row = (key: string, label: string, id: number, hint?: string) => (
    <Person
      key={key}
      relation={label}
      hint={hint}
      detail={kinship.isExternal(id)
        ? undefined
        : `${population.resident(id).age}, ${population.resident(id).sex}`}
    >
      {kinship.isExternal(id) ? (
        <span className="text-muted-foreground">
          No record · {externalLabel(kinship.external(id))}
        </span>
      ) : (
        <PersonLink names={identity} person={id} />
      )}
    </Person>
  );

  const parentRow = (edge: ParentEdge, key: string, label?: string) =>
    row(key, label ?? PARENT_LABEL[edge.kind][edge.role], edge.id, BASIS_NOTE[edge.basis]);

  const group = (title: string, rows: React.ReactNode) => (
    <>
      <Micro className={cn("block", SUBHEAD)}>{title}</Micro>
      <People>{rows}</People>
    </>
  );

  return (
    <Section title="Family" meta={num(total)}>
      {parents.length
        ? group("Parents", parents.map((edge) => parentRow(edge, `p${edge.id}${edge.role}`)))
        : null}

      {grandparents.length
        ? group("Grandparents", grandparents.map(({ edge, via }) => parentRow(
          edge,
          `g${edge.id}`,
          `${via.role === "mother" ? "Maternal" : "Paternal"} `
            + `grand${edge.role === "mother" ? "mother" : "father"}`,
        )))
        : null}

      {partner
        ? group("Partner", row("partner", partner.kind === "spouse" ? "Spouse" : "Partner", partner.id))
        : null}

      {siblings.length
        ? group("Siblings", siblings.map((sibling) => row(
          `s${sibling.id}`,
          TIE_LABEL[sibling.tie],
          sibling.id,
          // Which parent makes them a sibling is the whole content of a half
          // tie, and there is no room for it in the label.
          `Shared ${sibling.shared
            .map((edge) => PARENT_LABEL[edge.kind][edge.role].toLowerCase())
            .join(" and ")}`,
        )))
        : null}

      {children.length
        ? group("Children", children.map((id) => row(
          `c${id}`,
          population.resident(id).sex === "female" ? "Daughter" : "Son",
          id,
        )))
        : null}
    </Section>
  );
}

/**
 * The circle: the people this person actually knows, drawn full-bleed.
 *
 * Family above it is the graph the registry can prove. This is the one it
 * cannot — colleagues, congregants, the man two streets over — and it is much
 * the largest thing in the record. It is set in the same band as everything
 * else: a section that breaks the measure and changes surface reads as another
 * page pasted into this one.
 */
function Circle({ ties, identity, population, person, onOpen }: {
  ties: TieGraph;
  identity: Identity;
  population: Population;
  person: number;
  onOpen: (next: number) => void;
}) {
  const list = useMemo(() => ties.tiesOf(person), [ties, person]);
  const stats = useMemo(() => ties.statsOf(person, list), [ties, person, list]);
  const egoAge = population.resident(person).age;
  const estranged = list.filter((tie) => tie.valence < 0);

  const ageOf = (id: number) => (ties.isStub(id) ? null : population.resident(id).age);
  const nameOf = (id: number) => (ties.isStub(id) ? ties.stubLabel(id) : identity.shortName(id));

  return (
    <Section title="Circle" meta={`${num(stats.ties)} known`}>
      <div>
        <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <p className="m-0 text-[0.82rem] text-muted-foreground">
            <Count n={stats.byTier.get("close_friend") ?? 0} of="close friends" />
            {" · "}
            <Count n={stats.byTier.get("friend") ?? 0} of="friends" />
            {" · "}
            <Count n={stats.ties} of="people known" />
            {stats.negative ? <> · <Count n={stats.negative} of="estranged" /></> : null}
          </p>
          <CircleDialog
            ties={ties}
            identity={identity}
            population={population}
            person={person}
          />
        </header>

        <div className="mx-auto mt-4 max-w-[34rem]">
          <EgoGraph
            ties={list}
            graph={ties}
            person={person}
            ageOf={ageOf}
            nameOf={nameOf}
            onOpen={onOpen}
          />
        </div>

        {estranged.length ? (
          <div className="mt-6">
            <Micro className={cn("block", SUBHEAD)}>Estranged</Micro>
            <People>
              {estranged.map((tie) => (
                <Person
                  key={tie.edge}
                  relation={relationLabel(
                    tie.kind, egoAge,
                    ties.isStub(tie.other) ? null : population.resident(tie.other).age,
                  )}
                >
                  {ties.isStub(tie.other) ? (
                    <span className="text-muted-foreground">{ties.stubLabel(tie.other)}</span>
                  ) : (
                    <PersonLink names={identity} person={tie.other} />
                  )}
                </Person>
              ))}
            </People>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * The whole circle — counts, graph, where the ties come from, friends of
 * friends, everyone they know — over the record rather than on another page.
 * A name inside walks the dialog to that person's circle; their chip goes to
 * their record.
 */
function CircleDialog({ ties, identity, population, person }: {
  ties: TieGraph;
  identity: Identity;
  population: Population;
  person: number;
}) {
  const [focus, setFocus] = useState(person);
  return (
    <Dialog onOpenChange={(open) => { if (open) setFocus(person); }}>
      <DialogTrigger asChild>
        <ConsoleButton className="ml-auto">Social circle</ConsoleButton>
      </DialogTrigger>
      <DialogContent
        className="flex h-[min(46rem,88vh)] w-[min(76rem,calc(100vw-3rem))] flex-col gap-0 border-border p-0 sm:max-w-none"
        overlayClassName="bg-black/20 backdrop-blur-[3px]"
      >
        <DialogHeader className="flex-row items-center gap-3 border-b border-border px-5 py-3 pr-12">
          <DialogTitle className="text-[0.92rem]">Social circle</DialogTitle>
          <PersonLink names={identity} person={focus} />
          {focus !== person ? (
            <ButtonChip kind="person" onClick={() => setFocus(person)}>
              {identity.shortName(person)}
            </ButtonChip>
          ) : null}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6 text-[0.8rem]">
          <SocialCircle
            key={focus}
            ties={ties}
            identity={identity}
            population={population}
            person={focus}
            onOpen={setFocus}
            wide
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Count({ n, of }: { n: number; of: string }) {
  return (
    <>
      <strong className="font-semibold text-foreground tabular-nums">{num(n)}</strong> {of}
    </>
  );
}

/** Every field of one packed row, in as many columns as the band has room for. */
function RecordFields({ table, index, skip = [], formats }: {
  table: RecordTable;
  index: number;
  skip?: string[];
  formats?: Record<string, "money" | "exact" | "share">;
}) {
  return (
    <Fields labels={LABELS}>
      {table.fieldNames.map((field) => {
        if (skip.includes(field)) return null;
        const value = table.value(field, index);
        if (isBlank(value)) return null;
        return (
          <Field key={field} label={humanise(field)}>
            <ValueCell
              kind={table.kindOf(field)!}
              value={value}
              field={field}
              format={formats?.[field]}
              rich
            />
          </Field>
        );
      })}
    </Fields>
  );
}

/** The fields that make a record's line in the directory. */
function summaryFields(section: DossierSection): string[] {
  return (section.def.summary ?? section.table.fieldNames.slice(0, 3))
    .filter((field) => section.table.has(field));
}

/** One record's line: what it is on top, what distinguishes it underneath. */
function ItemLabel({ section, row }: { section: DossierSection; row: number }) {
  const fields = summaryFields(section).filter(
    (field) => !isBlank(section.table.value(field, row)),
  );
  const cell = (field: string) => (
    <ValueCell
      kind={section.table.kindOf(field)!}
      value={section.table.value(field, row)}
      format={section.def.formats?.[field]}
    />
  );

  return (
    <>
      <span className="block truncate">
        {fields.length ? cell(fields[0]) : `${section.def.label} record`}
      </span>
      {fields.length > 1 ? (
        <span className="block truncate text-[0.76rem] font-normal text-muted-foreground">
          {fields.slice(1, 3).map((field, index) => (
            <span key={field}>
              {index > 0 ? " · " : ""}
              {cell(field)}
            </span>
          ))}
        </span>
      ) : null}
    </>
  );
}

/**
 * One kind of record, as a directory beside a reader.
 *
 * A dossier is dozens of small documents — an account, a docket, a licence, a
 * prescription — and the shape that fits a set of documents is the one a file
 * browser has, not a list that folds away. Each kind gets its own frame: the
 * accounts are listed against the accounts, the charges against the charges,
 * and picking one changes only what is inside that frame. Nothing above or
 * below it moves, so working down eleven charges is eleven clicks in the same
 * place rather than eleven scroll positions to find again.
 *
 * A section holding one record keeps its directory too. A frame that changed
 * shape with its contents made a licence and a set of accounts look like two
 * different kinds of thing, and the single line still says which record is
 * open.
 */
function SectionFrame({ section }: { section: DossierSection }) {
  const { def, table, rows, skip } = section;
  const [row, setRow] = useState(rows[0]);
  // The person can change under this frame, which leaves the row pointing into
  // a table that no longer holds it.
  const current = rows.includes(row) ? row : rows[0];
  const list = useRef<HTMLDivElement>(null);

  const walk = (step: number) => {
    const at = rows.indexOf(current);
    const next = rows[(at + step + rows.length) % rows.length];
    setRow(next);
    list.current
      ?.querySelector<HTMLElement>(`[data-row="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const body = (
    <div className="min-h-0 overflow-y-auto px-3.5 py-3">
      <RecordFields table={table} index={current} skip={skip} formats={def.formats} />
      {table.childNames.map((child) => {
        const slice = table.children(child, current);
        if (!slice || slice.from === slice.to) return null;
        const kids: number[] = [];
        for (let i = slice.from; i < slice.to; i += 1) kids.push(i);
        return (
          <div key={child} className="mt-3.5">
            <Micro className="block">{humanise(child)}</Micro>
            {kids.map((kid) => (
              // Several charges on one docket ran together as one wall of
              // labels. Each is its own document, so each gets its own edge.
              <div
                key={kid}
                className="mt-2 rounded-md border border-border bg-background px-3 py-2"
              >
                <RecordFields table={slice.table} index={kid} />
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );

  return (
    <section className="flex max-h-[24rem] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-card">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <h3 className="text-[0.85rem] font-semibold">{def.label}</h3>
        <span className="text-[0.76rem] text-muted-foreground tabular-nums">
          {num(rows.length)}
        </span>
      </header>

      <div className="grid min-h-0 grid-cols-[13rem_minmax(0,1fr)]">
        <div
          ref={list}
          className="min-h-0 overflow-y-auto border-r border-border bg-background p-1"
          aria-label={def.label}
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            walk(event.key === "ArrowDown" ? 1 : -1);
          }}
        >
          {rows.map((candidate) => {
            const on = candidate === current;
            return (
              <button
                key={candidate}
                type="button"
                data-row={candidate}
                aria-current={on ? "true" : undefined}
                className={cn(
                  "block w-full cursor-pointer rounded-[0.25rem] px-2 py-1 text-left",
                  "text-[0.8rem] leading-tight",
                  on
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onClick={() => setRow(candidate)}
              >
                <ItemLabel section={section} row={candidate} />
              </button>
            );
          })}
        </div>
        {body}
      </div>
    </section>
  );
}

/**
 * Every record the person holds, by kind, under the subject it belongs to.
 *
 * One frame per line, whatever the measure. They used to run two or three
 * across on a wide screen, which saved height but broke the reading order —
 * the record after a licence was beside it rather than below it, and the eye
 * had to find the column again at every heading.
 */
function RecordGroups({ groups }: { groups: DossierGroup[] }) {
  return (
    <>
      {groups.map((group) => (
        <Section key={group.label} title={group.label} meta={num(group.records)}>
          <div className="grid grid-cols-1 gap-3">
            {group.sections.map((section) => (
              <SectionFrame key={section.def.table} section={section} />
            ))}
          </div>
        </Section>
      ))}
    </>
  );
}

/** How many matches the list offers before it asks for a better query. */
const MATCH_LIMIT = 10;

/**
 * Find a person by name or resident id.
 *
 * Matching runs over the flattened name list the Identity keeps, so typing
 * stays responsive across 121,060 people. Only the first handful of matches are
 * offered — this is a way to reach someone, not a second browse page.
 *
 * The results are a combobox listbox rather than a row of buttons: they float
 * over the record instead of pushing it down the page, arrow keys and Enter
 * reach them without leaving the field, and each match is one full-width row
 * with the name on the left and the resident id on the right, so a list of ten
 * Rodriguezes reads as a column and not as wrapped prose.
 */
function PersonPicker({ identity, person, onOpen }: {
  identity: Identity;
  person: number;
  onOpen: (person: number) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // Clearing the box when the caller moves to another person keeps a stale
  // result list from sitting under a record it no longer matches.
  useEffect(() => { setQuery(""); setOpen(false); }, [person]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const asId = Number(needle);
    if (Number.isInteger(asId) && String(asId) === needle && identity.knows(asId)) {
      return [asId];
    }
    const names = identity.searchNames;
    const out: number[] = [];
    for (let i = 0; i < names.length && out.length < MATCH_LIMIT; i += 1) {
      if (names[i].includes(needle)) out.push(i);
    }
    return out;
  }, [query, identity]);

  // A new query is a new list, so the highlight goes back to the top rather
  // than staying on whichever row happened to be fourth a keystroke ago.
  useEffect(() => { setActive(0); }, [query]);

  // Pointer-down rather than click, so the list is gone before the record
  // underneath it reacts, and pointer-down rather than blur, so moving focus to
  // the scrollbar does not dismiss it.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const listed = open && query.trim().length > 0;
  // The reset above lands a render late, so the highlight is clamped rather
  // than trusted: a query that goes from ten matches to two must not point at a
  // row that is no longer there.
  const cursor = matches.length ? Math.min(active, matches.length - 1) : 0;
  const choose = (match: number) => { setOpen(false); onOpen(match); };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // The arrows belong to the list, not to the caret.
      event.preventDefault();
      setOpen(true);
      if (!matches.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((cursor + step + matches.length) % matches.length);
      return;
    }
    // Enter opens the highlighted match, which for a single hit — the common
    // case when the query is a resident id — is the only one.
    if (event.key === "Enter" && listed && matches.length) {
      event.preventDefault();
      choose(matches[cursor]);
    }
  };

  return (
    <div className="relative w-[17rem] shrink-0 max-[51.25rem]:w-full" ref={box}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        id="dossier-find-input"
        className={cn(
          "h-7 w-full border border-border bg-[var(--panel-sunken)] pr-2.5 pl-8",
          "text-[0.78rem] text-foreground outline-none placeholder:text-muted-foreground/70",
          "focus-visible:border-primary/50 [&::-webkit-search-cancel-button]:hidden",
        )}
        type="search"
        role="combobox"
        autoComplete="off"
        aria-label="Find person"
        // Expanded means there is a listbox to point at, so a no-matches message
        // is announced by its own status line rather than described as a list
        // with nothing in it.
        aria-expanded={listed && matches.length > 0}
        aria-controls="dossier-matches"
        aria-autocomplete="list"
        aria-activedescendant={
          listed && matches.length ? `dossier-match-${matches[cursor]}` : undefined
        }
        placeholder="Name or resident id"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {listed ? (
        matches.length ? (
          <ul className={cn(MATCHES, "max-h-[17rem] overflow-y-auto p-1")} id="dossier-matches" role="listbox">
            {matches.map((match, index) => (
              <li
                key={match}
                className={MATCH_ITEM}
                id={`dossier-match-${match}`}
                role="option"
                aria-selected={index === cursor}
                data-active={index === cursor}
                // Keeping the caret in the field means the highlight and the
                // focus ring never disagree about where the keyboard is.
                onPointerDown={(event) => event.preventDefault()}
                onPointerEnter={() => setActive(index)}
                onClick={() => choose(match)}
              >
                <span className="truncate">{identity.name(match)}</span>
                <span className="text-muted-foreground tabular-nums">{match}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className={cn(MATCHES, "m-0 px-2.5 py-2 text-[0.8rem] text-muted-foreground")} role="status">
            No matches
          </p>
        )
      ) : null}
    </div>
  );
}

/** The list under the find field, shared by the matches and the no-match line. */
const MATCHES = "absolute top-[calc(100%+0.25rem)] right-0 left-0 z-30 m-0 list-none "
  + "rounded-md border border-border bg-popover shadow-[var(--shadow-float)]";

/** One option in that list. */
const MATCH_ITEM = "flex cursor-pointer items-baseline justify-between gap-4 rounded-[0.25rem] "
  + "px-2 py-1 text-[0.82rem] text-foreground "
  + "data-[active=true]:bg-[var(--accent)] data-[active=true]:text-[var(--accent-foreground)] "
  + "[&>span:first-child]:min-w-0 [&>span:last-child]:flex-none "
  + "[&>span:last-child]:text-[0.76rem]";
