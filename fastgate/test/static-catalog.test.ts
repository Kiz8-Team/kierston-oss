import { expect, test } from "bun:test";
import { omittedProviderRecord, PROVIDER_TABLES, providerTable } from "../src/static-catalog.ts";

test("only provider-owned static record families are exported", () => {
  expect(PROVIDER_TABLES).toHaveLength(26);
  expect(new Set(PROVIDER_TABLES.map((entry) => entry.table)).size).toBe(PROVIDER_TABLES.length);
  expect(providerTable("vehicles", "vehicle").table).toBe("dot_vehicle_registrations");
  expect(providerTable("holdings", "bank_account").table).toBe("bank_accounts");
  expect(providerTable("holdings", "mortgage").table).toBe("bank_mortgages");
  expect(providerTable("identity", "identity").derivedSsn).toBe(true);
  expect(providerTable("identity", "device").identities).toEqual([]);
  expect(omittedProviderRecord("holdings", "payment_profile")).toBe(true);
  expect(PROVIDER_TABLES.some((entry) => entry.table === "bank_customer_payment_profiles")).toBe(false);
  expect(providerTable("identity", "subscription").identities.map((role) => role.prefix)).toEqual([
    "subscriber_", "account_holder_",
  ]);
});
