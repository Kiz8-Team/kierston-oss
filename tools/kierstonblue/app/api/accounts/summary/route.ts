import { accountsSummary } from "@/lib/server/accounts";

export async function GET() {
  try {
    return Response.json(await accountsSummary());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
