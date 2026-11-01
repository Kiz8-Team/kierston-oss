import { writeFile } from "node:fs/promises";

type PackedArray = Uint8Array | Uint32Array | Int32Array;
type Kind = "u8" | "u32" | "i32";

const align8 = (value: number): number => (value + 7) & ~7;

function kindOf(array: PackedArray): Kind {
  return array instanceof Uint8Array ? "u8" : array instanceof Int32Array ? "i32" : "u32";
}

function packed(magic: string, metadata: Record<string, unknown>, arrays: Record<string, PackedArray>): Buffer {
  let payloadLength = 0;
  const specs = Object.entries(arrays).map(([name, array]) => {
    payloadLength = align8(payloadLength);
    const spec = { name, kind: kindOf(array), length: array.length, byteOffset: payloadLength };
    payloadLength += array.byteLength;
    return spec;
  });
  const header = Buffer.from(JSON.stringify({ ...metadata, arrays: specs }));
  const dataStart = align8(8 + header.length);
  const output = Buffer.alloc(dataStart + align8(payloadLength));
  output.write(magic, 0, "utf8");
  output.writeUInt32LE(header.length, 4);
  header.copy(output, 8);
  Object.values(arrays).forEach((array, index) => {
    Buffer.from(array.buffer, array.byteOffset, array.byteLength)
      .copy(output, dataStart + specs[index]!.byteOffset);
  });
  return output;
}

function stringArrays(name: string, values: readonly string[]): Record<string, PackedArray> {
  const encoded = values.map((value) => Buffer.from(value));
  const offsets = new Uint32Array(values.length + 1);
  let length = 0;
  encoded.forEach((value, index) => {
    length += value.length;
    offsets[index + 1] = length;
  });
  return {
    [`${name}_offset`]: offsets,
    [`${name}_bytes`]: new Uint8Array(Buffer.concat(encoded)),
  };
}

export async function writeStaticFixture(path: string): Promise<void> {
  const arrays: Record<string, PackedArray> = {
    identity_first_name: new Uint8Array([1, 2]),
    ...stringArrays("identity_first_name", ["Ada", "Grace"]),
    identity_middle_name: new Uint8Array([0, 0]),
    ...stringArrays("identity_middle_name", []),
    identity_surname: new Uint8Array([1, 2]),
    ...stringArrays("identity_surname", ["Lovelace", "Hopper"]),
    identity_birth_date: new Int32Array([19800102, 19900304]),
    identity_taxpayer_id_kind: new Uint8Array([1, 2]),
    ...stringArrays("identity_taxpayer_id_kind", ["ssn", "itin"]),
    identity_taxpayer_id: new Uint8Array([1, 2]),
    ...stringArrays("identity_taxpayer_id", ["111-22-3333", "444-55-6666"]),
    identity_worker_class: new Uint8Array([1, 1]),
    ...stringArrays("identity_worker_class", ["private"]),
    identity_devices_child: new Uint32Array([0, 1, 1]),
    identity_subscriptions_child: new Uint32Array([0, 1, 1]),
    device_person: new Uint32Array([0]),
    device_imei: new Uint8Array([1]),
    ...stringArrays("device_imei", ["111111111111111"]),
    device_model: new Uint8Array([1]),
    ...stringArrays("device_model", ["Phone One"]),
    subscription_person: new Uint32Array([0]),
    subscription_user: new Uint32Array([0]),
    subscription_account_holder: new Uint32Array([1]),
    subscription_carrier: new Uint8Array([1]),
    ...stringArrays("subscription_carrier", ["Carrier One"]),
    subscription_plan_type: new Uint8Array([1]),
    ...stringArrays("subscription_plan_type", ["postpaid"]),
    subscription_msisdn: new Uint8Array([1]),
    ...stringArrays("subscription_msisdn", ["+15550000001"]),
    subscription_imsi: new Uint8Array([1]),
    ...stringArrays("subscription_imsi", ["imsi-1"]),
  };
  const records = packed("KREC", {
    dataset: "identity",
    source: "identity.json",
    builtAt: "2026-01-01T00:00:00Z",
    seed: 1,
    referenceYear: 2026,
    surveyed: [],
    modelled: [],
    counts: { identities: 2, devices: 1, subscriptions: 1 },
    tables: [
      {
        name: "identity",
        rows: 2,
        fields: [
          { name: "first_name", kind: "enum", column: "identity_first_name" },
          { name: "middle_name", kind: "enum", column: "identity_middle_name" },
          { name: "surname", kind: "enum", column: "identity_surname" },
          { name: "birth_date", kind: "date", column: "identity_birth_date" },
          { name: "taxpayer_id_kind", kind: "enum", column: "identity_taxpayer_id_kind" },
          { name: "taxpayer_id", kind: "str", column: "identity_taxpayer_id" },
          { name: "worker_class", kind: "enum", column: "identity_worker_class" },
        ],
        children: [
          { name: "devices", table: "device", offsets: "identity_devices_child" },
          { name: "subscriptions", table: "subscription", offsets: "identity_subscriptions_child" },
        ],
      },
      {
        name: "device",
        rows: 1,
        fields: [
          { name: "person", kind: "id", column: "device_person" },
          { name: "imei", kind: "str", column: "device_imei" },
          { name: "model", kind: "enum", column: "device_model" },
        ],
        children: [],
      },
      {
        name: "subscription",
        rows: 1,
        fields: [
          { name: "person", kind: "id", column: "subscription_person" },
          { name: "user", kind: "id", column: "subscription_user" },
          { name: "account_holder", kind: "id", column: "subscription_account_holder" },
          { name: "carrier", kind: "enum", column: "subscription_carrier" },
          { name: "plan_type", kind: "enum", column: "subscription_plan_type" },
          { name: "msisdn", kind: "str", column: "subscription_msisdn" },
          { name: "imsi", kind: "str", column: "subscription_imsi" },
        ],
        children: [],
      },
    ],
  }, arrays);

  const meta = {
    magic: "KSIM",
    version: 1,
    builtAt: "2026-01-01T00:00:00Z",
    seed: 1,
    placementSeed: 1,
    digest: "fixture-static-1",
    byteLength: align8(records.length),
    sections: [{
      name: "identity",
      magic: "KREC",
      source: "identity.bin",
      byteOffset: 0,
      byteLength: records.length,
      rows: { identities: 2, devices: 1, subscriptions: 1 },
    }],
  };
  const header = Buffer.from(JSON.stringify(meta));
  const dataStart = align8(8 + header.length);
  const container = Buffer.alloc(dataStart + align8(records.length));
  container.write("KSIM", 0, "utf8");
  container.writeUInt32LE(header.length, 4);
  header.copy(container, 8);
  records.copy(container, dataStart);
  await writeFile(path, container);
}
