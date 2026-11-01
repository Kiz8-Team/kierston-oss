/**
 * Names for the PUMS codes the simulation stores.
 *
 * The population and the employment table both keep occupation, industry and
 * transport as the codes ACS uses, because the generators match on them. A
 * table of codes is unreadable, so every view goes through this: the code stays
 * available for the analyst who wants it, and the label is what gets shown.
 */

/**
 * The 17 INDP sector prefixes, spelled out. The prefix is part of the label
 * text itself — "MED-General Medical And Surgical Hospitals" — and is the rung
 * assign_work.py falls back to when no site in the exact industry has room, so
 * it is worth being able to filter and group by.
 */
export const SECTORS: Record<string, string> = {
  AGR: "Agriculture, forestry and fishing",
  EXT: "Mining and extraction",
  UTL: "Utilities",
  CON: "Construction",
  MFG: "Manufacturing",
  WHL: "Wholesale trade",
  RET: "Retail trade",
  TRN: "Transport and warehousing",
  INF: "Information",
  FIN: "Finance, insurance and real estate",
  PRF: "Professional and business services",
  EDU: "Education",
  MED: "Health care",
  SCA: "Social assistance",
  ENT: "Arts, entertainment, food and lodging",
  SRV: "Other services",
  ADM: "Public administration",
  MIL: "Armed forces",
};

const SECTOR_PREFIX = /^([A-Z]{3})-(.*)$/;

/** What /api/labels serves: the code books, reduced to code → label. */
export interface LabelPayload {
  /** OCCP → [label, major-group code]. */
  occupation: Record<string, [string, string]>;
  /** Major-group code → label, for grouping a table by broad occupation. */
  occupationGroups: Record<string, string>;
  /** INDP → label, still carrying the sector prefix the generators match on. */
  industry: Record<string, string>;
  /** JWTRNS → means of transport to work. */
  transport: Record<string, string>;
  /** SCHG → grade level attending. */
  grade: Record<string, string>;
}

export class Labels {
  private occupation: Map<string, [string, string]>;
  private groups: Map<string, string>;
  private industry: Map<string, { label: string; sector: string }>;
  private transport: Map<string, string>;
  private grade: Map<string, string>;

  constructor(payload: LabelPayload) {
    this.grade = new Map(Object.entries(payload.grade ?? {}));
    this.occupation = new Map();
    for (const [code, [label, group]] of Object.entries(payload.occupation)) {
      const match = SECTOR_PREFIX.exec(label);
      this.occupation.set(code, [match ? sentence(match[2]) : label, group]);
    }
    this.groups = new Map(Object.entries(payload.occupationGroups));
    this.transport = new Map(Object.entries(payload.transport));
    this.industry = new Map();
    for (const [code, raw] of Object.entries(payload.industry)) {
      const match = SECTOR_PREFIX.exec(raw);
      this.industry.set(code, match
        ? { label: sentence(match[2]), sector: match[1] }
        : { label: raw, sector: "" });
    }
  }

  /** Every occupation group in the population, for a filter. */
  get occupationGroups(): { code: string; label: string }[] {
    return [...this.groups.entries()].map(([code, label]) => ({ code, label }));
  }

  occupationLabel(code: string | null): string {
    if (!code) return "";
    return this.occupation.get(code)?.[0] ?? code;
  }

  occupationGroup(code: string | null): string {
    if (!code) return "";
    return this.occupation.get(code)?.[1] ?? "";
  }

  occupationGroupLabel(code: string | null): string {
    const group = this.occupationGroup(code);
    return group ? this.groups.get(group) ?? group : "";
  }

  industryLabel(code: string | null): string {
    if (!code) return "";
    return this.industry.get(code)?.label ?? code;
  }

  industrySector(code: string | null): string {
    if (!code) return "";
    return this.industry.get(code)?.sector ?? "";
  }

  sectorLabel(code: string | null): string {
    if (!code) return "";
    return SECTORS[code] ?? code;
  }

  /** "Car, truck, or van" from JWTRNS 01, which is stored unpadded as "1". */
  transportLabel(code: string | null): string {
    if (!code) return "";
    return this.transport.get(code.padStart(2, "0")) ?? this.transport.get(code) ?? code;
  }

  /**
   * "Grade 4" from SCHG 06.
   *
   * The codebook's own wording for the top two is a sentence rather than a
   * label — "College undergraduate years (freshman to senior)" — which is too
   * long for a table cell, so those two are shortened and the rest are the
   * Census text unaltered.
   */
  gradeLabel(code: string | null): string {
    if (!code) return "";
    const padded = code.padStart(2, "0");
    if (padded === "15") return "Undergraduate";
    if (padded === "16") return "Graduate school";
    return this.grade.get(padded) ?? this.grade.get(code) ?? code;
  }
}

/**
 * Census labels are Title Cased Throughout, which reads as a headline in the
 * middle of a sentence. Only the leading word keeps its capital; anything that
 * looks like an acronym or a proper noun the case cannot distinguish is left.
 */
function sentence(value: string): string {
  return value.replace(/\b[A-Z][a-z]+\b/g, (word, offset: number) =>
    (offset === 0 ? word : word.toLowerCase()));
}
