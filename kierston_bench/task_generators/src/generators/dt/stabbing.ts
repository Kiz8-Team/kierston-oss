/**
 * "He got home and found her." He did not.
 *
 * The prompt repeats the 911 call: a man rang at the event's end to say
 * he had just got home and found his girlfriend stabbed to death. The
 * agent works it half an hour on. The records show two handsets side by
 * side all day, the same car on the same cameras, one card at lunch and
 * the other at the shops, and not one text or call between them; the
 * truth is the boyfriend.
 */

import { deceptionFamily, actorOf } from "./deception.ts";

export const stabbing = deceptionFamily({
  family: "stabbing",
  eventKind: "stabbing",
  delay: { min: 25, max: 40 },
  resolve: (ctx) => {
    const boyfriend = actorOf(ctx, "boyfriend");
    const victim = actorOf(ctx, "girlfriend");
    return { person: boyfriend, caller: boyfriend, named: { "deceased": victim }, extra: { victim } };
  },
  callerRole: "caller",
  report: (place, window) =>
    `At ${window.end} today a man called 911 from ${place}. He said he had just got home and found his girlfriend dead on the floor with multiple stab wounds; he did not see anyone leave.`,
});
