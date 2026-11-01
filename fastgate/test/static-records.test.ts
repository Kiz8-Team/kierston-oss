import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticContainerReader, StaticRecordSet } from "../src/static-records.ts";
import { writeStaticFixture } from "./static-fixture.ts";

test("reads every self-described static table and preserves child relationships", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fastgate-static-records-test-"));
  const path = join(directory, "sim_init.bin");
  try {
    await writeStaticFixture(path);
    const container = await StaticContainerReader.open(path);
    try {
      expect(container.meta.digest).toBe("fixture-static-1");
      const section = container.recordSections()[0]!;
      const records = StaticRecordSet.decode(await container.section(section));
      expect(records.recordCount).toBe(4);
      expect([...records.records()]).toEqual([
        {
          dataset: "identity",
          recordType: "identity",
          recordIndex: 0,
          personId: 0,
          parent: null,
          record: {
            first_name: "Ada", middle_name: null, surname: "Lovelace", birth_date: "1980-01-02",
            taxpayer_id_kind: "ssn", taxpayer_id: "111-22-3333", worker_class: "private",
          },
        },
        {
          dataset: "identity",
          recordType: "identity",
          recordIndex: 1,
          personId: 1,
          parent: null,
          record: {
            first_name: "Grace", middle_name: null, surname: "Hopper", birth_date: "1990-03-04",
            taxpayer_id_kind: "itin", taxpayer_id: "444-55-6666", worker_class: "private",
          },
        },
        {
          dataset: "identity",
          recordType: "device",
          recordIndex: 0,
          personId: 0,
          parent: { recordType: "identity", recordIndex: 0, field: "devices" },
          record: { person: 0, imei: "111111111111111", model: "Phone One" },
        },
        {
          dataset: "identity",
          recordType: "subscription",
          recordIndex: 0,
          personId: 0,
          parent: { recordType: "identity", recordIndex: 0, field: "subscriptions" },
          record: {
            person: 0,
            user: 0,
            account_holder: 1,
            carrier: "Carrier One",
            plan_type: "postpaid",
            msisdn: "+15550000001",
            imsi: "imsi-1",
          },
        },
      ]);
    } finally {
      await container.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
