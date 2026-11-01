import { expect, test } from "bun:test";
import { staticSchemaSql } from "../src/static-schema.ts";

test("PostgreSQL initialization creates only the provider namespace", () => {
  const sql = staticSchemaSql("fastgate_static_test").join("\n");
  expect(sql).toBe('CREATE SCHEMA IF NOT EXISTS "fastgate_static_test"');
  expect(staticSchemaSql("fastgate_static_test")).toHaveLength(1);
});
