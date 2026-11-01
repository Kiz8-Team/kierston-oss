// Response clock. When the time allowed for a case runs out, the
// investigator is told to stop and write up what they have.
//
// The allowance arrives in DL (milliseconds) and is dropped from the
// environment at load, so shells started later do not inherit it.

import { readFileSync } from "node:fs";

export default function (pi: any) {
  const allowance = Number(process.env.DL);
  delete process.env.DL;
  if (!Number.isFinite(allowance) || allowance <= 0) return;
  const message: string = JSON.parse(readFileSync("/usr/local/share/adi/messages.json", "utf8")).timeUp;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  pi.on("agent_start", () => {
    if (started) return;
    started = true;
    timer = setTimeout(() => {
      timer = undefined;
      pi.sendUserMessage(message, { deliverAs: "steer" });
    }, allowance);
    // Never the reason the process stays up once the agent has finished.
    (timer as any).unref?.();
  });
  pi.on("agent_end", () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  });
}
