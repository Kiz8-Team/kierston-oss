/** Each dynamic table and the clock column that places a row in a day. */
export const DYNAMIC_DAY_COLUMNS = [
  ["alpr_reads", "observed_at"],
  ["network_events", "occurred_at"],
  ["sms_records", "submitted_at"],
  ["call_records", "setup_at"],
  ["call_handovers", "occurred_at"],
  ["bank_transactions", "occurred_at"],
] as const;

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`invalid ClickHouse identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

export function schemaSql(database: string): string[] {
  const db = quoteIdentifier(database);
  const create = [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    `CREATE TABLE IF NOT EXISTS ${db}.ingested_days (
      observation_date Date32,
      source_digest FixedString(64),
      status Enum8('importing' = 1, 'complete' = 2),
      imported_at DateTime64(3, 'UTC'),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    ORDER BY observation_date`,
    `CREATE TABLE IF NOT EXISTS ${db}.active_scenarios (
      observation_date Date32,
      base_digest FixedString(64),
      scenario_digest FixedString(64),
      status Enum8('importing' = 1, 'complete' = 2),
      applied_at DateTime64(3, 'UTC'),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    ORDER BY observation_date`,
    `CREATE TABLE IF NOT EXISTS ${db}.scenario_journal (
      observation_date Date32,
      base_digest FixedString(64),
      scenario_digest FixedString(64),
      table_name LowCardinality(String),
      change Enum8('deleted' = 1, 'inserted' = 2, 'applied' = 3),
      row_id String,
      row_json String,
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    ORDER BY (observation_date, base_digest, scenario_digest, table_name, change, row_id)`,
    `CREATE TABLE IF NOT EXISTS ${db}.alpr_reads (
      read_id UUID,
      camera_id String,
      observed_at DateTime64(3, 'UTC'),
      plate_text String,
      normalized_plate String,
      confidence Float32,
      lighting Nullable(String),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(observed_at)
    ORDER BY read_id`,
    `CREATE TABLE IF NOT EXISTS ${db}.network_events (
      event_id UUID,
      imsi String,
      imei Nullable(String),
      occurred_at DateTime64(3, 'UTC'),
      event_type LowCardinality(String),
      cell_cgi Nullable(String),
      previous_cell_cgi Nullable(String),
      tracking_area Nullable(UInt64),
      timing_advance Nullable(UInt16),
      secondary_cell_cgi Nullable(String),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY event_id`,
    `CREATE TABLE IF NOT EXISTS ${db}.sms_records (
      sms_record_id UUID,
      originating_imsi String,
      originating_imei Nullable(String),
      destination_imsi Nullable(String),
      destination_imei Nullable(String),
      submitted_at DateTime64(3, 'UTC'),
      originating_cell_cgi Nullable(String),
      destination_cell_cgi Nullable(String),
      multimedia Bool,
      segment_number UInt32,
      segment_count UInt32,
      delivered_at Nullable(DateTime64(3, 'UTC')),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(submitted_at)
    ORDER BY sms_record_id`,
    `CREATE TABLE IF NOT EXISTS ${db}.call_records (
      call_record_id UUID,
      originating_imsi String,
      originating_imei Nullable(String),
      destination_imsi Nullable(String),
      destination_imei Nullable(String),
      setup_at DateTime64(3, 'UTC'),
      outcome LowCardinality(String),
      ring_seconds UInt32,
      duration_seconds UInt32,
      origin_cell_cgi Nullable(String),
      end_cell_cgi Nullable(String),
      destination_origin_cell_cgi Nullable(String),
      destination_end_cell_cgi Nullable(String),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(setup_at)
    ORDER BY call_record_id`,
    `CREATE TABLE IF NOT EXISTS ${db}.call_handovers (
      call_record_id UUID,
      sequence UInt32,
      occurred_at DateTime64(3, 'UTC'),
      cell_cgi Nullable(String),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY (call_record_id, sequence)`,
    `CREATE TABLE IF NOT EXISTS ${db}.bank_transactions (
      transaction_id UUID,
      occurred_at DateTime64(3, 'UTC'),
      amount Decimal(14, 2),
      transaction_type LowCardinality(String),
      approved Bool,
      decline_code Nullable(String),
      instrument Nullable(String),
      mcc Nullable(UInt16),
      merchant Nullable(String),
      account_number Nullable(String),
      card_last_four Nullable(String),
      card_network Nullable(String),
      balance_after Nullable(Decimal(14, 2)),
      merchant_latitude Nullable(Float64),
      merchant_longitude Nullable(Float64),
      _version UInt64
    ) ENGINE = ReplacingMergeTree(_version)
    PARTITION BY toYYYYMM(occurred_at)
    ORDER BY transaction_id`,
  ];
  // Columns added after a table first shipped. CREATE IF NOT EXISTS leaves an
  // existing table as it was, so each addition is repeated here as an idempotent
  // ALTER and a store built before the column existed picks it up on the next
  // schema pass. Every entry is Nullable, so the rows already there stay valid.
  const migrate = [
    `ALTER TABLE ${db}.network_events
      ADD COLUMN IF NOT EXISTS timing_advance Nullable(UInt16) AFTER tracking_area,
      ADD COLUMN IF NOT EXISTS secondary_cell_cgi Nullable(String) AFTER timing_advance`,
    // The KDAY a row was imported from. An overwrite of one day deletes by this
    // column, so rows a KDAY carries past its own midnight go with it and a
    // neighboring day's spill-over stays. Rows written before the column existed
    // read NULL and fall back to the local calendar day of their clock column.
    ...DYNAMIC_DAY_COLUMNS.map(([name]) => `ALTER TABLE ${db}.${quoteIdentifier(name)}
      ADD COLUMN IF NOT EXISTS observation_date Nullable(Date32)`),
  ];
  return [...create, ...migrate];
}
