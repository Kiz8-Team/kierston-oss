import type { Normalizer } from "./normalize";

/** Which physical store answers a query. Operators never see this. */
export type Store = "postgres" | "clickhouse";

/**
 * Who holds the records. KDI brings together federal, state, county and municipal
 * systems alongside commercial ones -- carrier subscriber data and the plate
 * reader network are bought, not governed -- and the interface says which is
 * which on every response.
 */
export type Custodian = "federal" | "state" | "county" | "municipal" | "private";

export interface Field {
  name: string;
  label: string;
  kind?: "text" | "date" | "select";
  /** Character columns the input is sized to, roughly the width of the value. */
  size?: number;
  placeholder?: string;
  normalize?: Normalizer;
  options?: readonly { value: string; label: string }[];
  hint?: string;
}

export type FilterOperator = "eq" | "contains" | "gte" | "gt" | "lte" | "lt" | "between" | "is_null";
export type FilterType = "text" | "number" | "boolean" | "date" | "datetime";

export interface PublicFilter {
  name: string;
  label: string;
  type: FilterType;
  operators: readonly FilterOperator[];
  repeatable: boolean;
  maxValues: number;
}

export interface FilterValue {
  field: string;
  operator: FilterOperator;
  values: string[];
}

export interface NearFilter {
  latitude: number;
  longitude: number;
  radiusMetres: number;
}

export interface QueryRequest {
  filters: FilterValue[];
  near?: NearFilter;
  select?: string[];
}

/** A named lookup that turns one identifier into the keys a table is indexed by. */
export type ResolverId =
  | "msisdn_to_imsi"
  | "ssn_to_imsi"
  | "ssn_to_account_numbers"
  | "docket_to_case_index"
  | "licence_to_record_index";

export interface Match {
  /** The form field this predicate reads. Blank fields drop out of the query. */
  field: string;
  /** One or more columns; several means the value may match any of them. */
  columns: readonly string[];
  op: "eq" | "contains" | "name" | "day" | "in" | "true";
  /** For `in`: the lookup that expands the typed value into a key list. */
  via?: ResolverId;
  /** For `in` against a non-text column: the array type the list is cast to. */
  cast?: string;
}

export interface Column {
  name: string;
  label: string;
  /** Catalog-controlled SQL replacing a bare column reference. */
  expr?: string;
  format?: "date" | "datetime" | "money" | "bool" | "code" | "list" | "seconds" | "year";
  align?: "right";
}

export interface QueryDef {
  id: string;
  label: string;
  /**
   * `record` queries return the state of a register: who holds what, right now.
   * `history` queries return dated events and always demand a date or a range,
   * because the dynamic store is written one observed day at a time.
   */
  kind: "record" | "history";
  store: Store;
  table: string;
  description: string;
  select: readonly Column[];
  fields: readonly Field[];
  match: readonly Match[];
  /** At least one field from at least one of these groups must be filled in. */
  requires: readonly (readonly string[])[];
  order?: string;
  /** Enables `--near`; event searches resolve through the named infrastructure. */
  spatial?: "coordinates" | "camera" | "cell";
  /**
   * Candidates for the subject header, tried in order; the first whose field
   * the operator actually filled in wins.
   */
  subjects?: readonly { field: string; via: "ssn" | "msisdn" | "imsi" | "imei" | "plate" | "vin" | "account" }[];
  note?: string;
  /**
   * Set by a task policy on history queries: rows whose clock column is
   * after this instant (ISO 8601, UTC) are not returned. The clock column
   * is the query's first datetime result column.
   */
  cutoff?: string;
  /**
   * How this table is read under a cutoff. Rows after the cutoff on `clock`
   * are dropped; `mask` replaces stored columns whose value depends on
   * something that happened after the cutoff (a call still running, a
   * message not yet delivered). The replacements apply to the stored row
   * before any filter or selection, so a filter on a masked column sees the
   * masked value. Without a rule the clock is the first datetime result.
   */
  cutoffRule?: CutoffRule;
}

export interface CutoffRule {
  clock: string;
  /**
   * `expr` is ClickHouse SQL over the stored row. `$name` reads the stored
   * value of column `name` (never another mask's result); `{cutoff}` stands
   * for the instant.
   */
  mask?: readonly { column: string; expr: string }[];
}

export interface DatabaseDef {
  id: string;
  /** The short code the response header prints, e.g. SSA, DOT, CARR. */
  code: string;
  name: string;
  custodian: Custodian;
  holder: string;
  description: string;
  queries: readonly QueryDef[];
}
