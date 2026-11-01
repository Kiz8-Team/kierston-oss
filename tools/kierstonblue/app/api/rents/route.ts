import { readFile, stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { join } from "node:path";
import { roots } from "@/lib/server/repo";

interface RecurringFile {
  households: number;
  household: { kind: string; household: number; amount: number }[];
}

let cached: { path: string; mtimeMs: number; rents: (number | null)[] } | null = null;

/** Only the compact household rent column needed by the area map. */
export async function GET() {
  const path = join((await roots()).sim, "recurring_spending.json");
  try {
    const info = await stat(path);
    if (!cached || cached.path !== path || cached.mtimeMs !== info.mtimeMs) {
      const file = JSON.parse(await readFile(path, "utf8")) as RecurringFile;
      const rents: (number | null)[] = Array(file.households).fill(null);
      for (const charge of file.household) {
        if (charge.kind === "rent") rents[charge.household] = charge.amount;
      }
      cached = { path, mtimeMs: info.mtimeMs, rents };
    }
    return NextResponse.json(cached.rents);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
