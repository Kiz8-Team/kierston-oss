import { ADI } from "../../model_visible_text";
import { findQuery, publicCatalog } from "./catalog";
import { execute, QueryRejected, type Execution } from "./execute";
import type { DatabaseDef, QueryDef, QueryRequest } from "./catalog-types";
import { clickhouse, postgres, STATIC_SCHEMA } from "./stores";
import { applyQueryPolicy, parseKdiPolicy, redactSubject } from "./policy";
import { recordCause } from "./diagnostics";

export const MINIMUM_REASON = 12;

export interface QueryResponse extends Execution {
  database: Pick<DatabaseDef, "code" | "name" | "custodian" | "holder">;
  query: Pick<QueryDef, "id" | "label" | "kind" | "note">;
}

export function catalog() {
  return publicCatalog(parseKdiPolicy());
}

export async function heldDays(): Promise<string[]> {
  const response = await clickhouse().query({
    query: `SELECT toString(observation_date) AS day FROM ingested_days
            WHERE status = 'complete' ORDER BY observation_date DESC`,
    format: "JSONEachRow",
  });
  return (await response.json<{ day: string }>()).map((row) => row.day);
}

async function probe(name: string, run: () => Promise<unknown>) {
  try {
    await run();
    return { name, status: "online" as const };
  } catch (error) {
    // The status is all the caller (and so the agent) sees; the cause is for the operator.
    recordCause(`health: ${name}`, error);
    return { name, status: "offline" as const };
  }
}

export async function health() {
  const [staticStore, eventStore] = await Promise.all([
    probe("static registers", () =>
      postgres().query(`SELECT 1 FROM "${STATIC_SCHEMA}".identity_registry_people LIMIT 1`)),
    probe("event stores", async () => {
      const ping = await clickhouse().ping({ select: true });
      if (!ping.success) throw ping.error;
    }),
  ]);
  return {
    status: staticStore.status === "online" && eventStore.status === "online"
      ? "online" as const
      : "degraded" as const,
    stores: [staticStore, eventStore],
  };
}

export async function query(
  databaseId: string,
  queryId: string,
  reason: string,
  request: QueryRequest,
): Promise<QueryResponse> {
  const found = findQuery(databaseId, queryId);
  if (!found) throw new QueryRejected("INVALID_FILTER", ADI.noSuchSearch);
  const why = reason.trim().replace(/\s+/g, " ");
  if (why.length < MINIMUM_REASON) {
    throw new QueryRejected("INVALID_FILTER", ADI.reasonTooShort(MINIMUM_REASON));
  }
  const policy = parseKdiPolicy();
  const maskedQuery = applyQueryPolicy(policy, databaseId, found.query);
  const result = await execute(maskedQuery, request);
  const columns = result.columns.map(({ name, label, format, align }) => ({ name, label, format, align }));
  return {
    database: { code: found.database.code, name: found.database.name,
      custodian: found.database.custodian, holder: found.database.holder },
    query: { id: found.query.id, label: found.query.label, kind: found.query.kind, note: found.query.note },
    ...result,
    subject: redactSubject(policy, result.subject),
    columns,
  };
}
