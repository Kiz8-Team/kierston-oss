/** Structured presentation of one JSONL record written by the KDI service. */

export interface KdiCall {
  at?: string;
  args?: string[];
  code?: number;
  ms?: number;
  outBytes?: number;
  err?: string;
}

export interface ParsedKdiCall {
  operation: string;
  target?: string;
  inputs: { name: string; value: string }[];
  reason?: string;
  options: string[];
}

export function parseKdiCall(call: KdiCall): ParsedKdiCall {
  const args = call.args ?? [];
  const operation = (args[0] ?? "unknown").replace(/^--/, "");
  const query = operation === "query";
  const target = query ? [args[1], args[2]].filter(Boolean).join(" › ") : undefined;
  const inputs: ParsedKdiCall["inputs"] = [];
  const options: string[] = [];
  let reason: string | undefined;

  for (let index = query ? 3 : 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--reason" && args[index + 1] !== undefined) {
      reason = args[++index];
    } else if (argument === "--input" && args[index + 1] !== undefined) {
      const input = args[++index]!;
      const equals = input.indexOf("=");
      inputs.push(equals === -1
        ? { name: input, value: "" }
        : { name: input.slice(0, equals), value: input.slice(equals + 1) });
    } else if (argument !== "--pretty") {
      options.push(argument);
    }
  }

  return { operation, ...(target ? { target } : {}), inputs, ...(reason ? { reason } : {}), options };
}
