/**
 * "There's a man with a gun in that house." There is not.
 *
 * The prompt repeats the 911 call: at the event's minute somebody reported
 * an armed man forcing his way into a residence and threatening the people
 * inside, and units were sent. The agent works it a few minutes on, with
 * officers arriving. The caller's handset is nowhere near the house,
 * nobody's handset came to it, and the caller had rung the occupant twice
 * earlier and been rejected; the truth is the caller.
 */

import { deceptionFamily, actorOf } from "./deception.ts";

export const swatting = deceptionFamily({
  family: "swatting",
  eventKind: "swatting",
  delay: { min: 6, max: 14 },
  resolve: (ctx) => {
    const occupant = actorOf(ctx, "occupant");
    const caller = actorOf(ctx, "caller");
    return { person: caller, caller, named: { "occupant of the residence": occupant }, extra: { occupant } };
  },
  callerRole: "caller",
  report: (place, window) =>
    `At ${window.start} today a caller told 911 that a man with a handgun had just forced his way into ${place} and was threatening to shoot the people inside. Units were sent.`,
});
