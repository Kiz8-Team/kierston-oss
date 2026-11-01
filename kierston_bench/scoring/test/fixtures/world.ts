/**
 * A four-person city on disk: the smallest sim_data that still exercises every
 * way an agent can name someone or somewhere.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function writeSimData(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kbench-scoring-"));
  const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
  await Promise.all([
    write("identity.json", {
      identities: {
        "1": { first_name: "Ada", surname: "Byron", birth_date: "1990-01-01", taxpayer_id: "111-22-3333", mobile: "(610) 000-0001" },
        "2": { first_name: "Grace", surname: "Hopper", birth_date: "1985-05-05", taxpayer_id: "222-33-4444", mobile: "(610) 000-0002" },
        "3": { first_name: "Alan", surname: "Turing", birth_date: "1980-06-23", taxpayer_id: "333-44-5555" },
        // Two people share a name, so a name is not always an identifier.
        "4": { first_name: "Alan", surname: "Turing", birth_date: "1999-09-09", taxpayer_id: "444-55-6666" },
        // No SSN: one holds an ITIN, one nothing. Name and date of birth is all anyone can say of them.
        "5": { first_name: "Mary", surname: "Somerville", birth_date: "1978-12-26", taxpayer_id: "902-11-2222", taxpayer_id_kind: "itin" },
        "6": { first_name: "Sofia", surname: "Kovalevskaya", birth_date: "1988-01-15", taxpayer_id: null, taxpayer_id_kind: null },
      },
    }),
    write("devices.json", { subscriptions: { "2": [{ msisdn: "6100000022", imsi: "310150123456789" }] } }),
    write("accounts.json", { account_records: { "3": [{ channel: "skeet", handle: "birdy" }] } }),
    write("dwellings.json", {
      dwellings: [{ id: "way/100", address: "1 Bridge Street, Allentown, PA 18103", lat: 40.6, lon: -75.47 }],
    }),
    write("orgs.json", { org_records: [{ id: "v:way/200", name: "Hop Po", lat: 40.61, lon: -75.48 }] }),
    write("schools.json", { school_records: [{ id: "way/300", name: "Jefferson Elementary School" }] }),
    // Two buildings on one street, which is how a real address index looks and
    // why an address that names several places must still score the right one.
    write("workplaces.json", {
      site_records: [
        { id: "way/400", name: "Sacred Heart Hospital", address: "North 10th Street, Allentown, PA 18102" },
        { id: "way/401", name: "Milano Furniture", address: "North 10th Street, Allentown, PA 18102" },
      ],
    }),
    write("vehicles.json", {
      vehicles: { "1HGCM82633A004352": { vin: "1HGCM82633A004352", plate: "LAV-1459", owner: 1, household: 9 } },
    }),
    write("population.json", {
      person_records: [
        { id: 1, household: 9 },
        { id: 2, household: 9 },
        { id: 3, household: 10 },
        { id: 4, household: 11 },
      ],
    }),
  ]);
  return dir;
}
