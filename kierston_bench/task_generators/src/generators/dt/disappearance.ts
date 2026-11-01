/**
 * "She left for yours hours ago." She did not.
 *
 * The prompt repeats the 911 call: a man rang to report his girlfriend
 * missing. She set off from home for a relative's place, he said, and
 * never arrived. The agent works it a quarter of an hour on. The records
 * show his handset at home all evening and the household car out on the
 * cameras all the same: halfway to the relative's, then across the city
 * and back. Her handset rides with the car until it stops moving at a
 * kerb on the way, and answers nothing after; the truth is the partner.
 *
 * The agent is not told a crime happened: it may answer with where she is
 * or with suspects. Only the suspects are scored.
 */

import { deceptionFamily, actorOf } from "./deception.ts";

export const disappearance = deceptionFamily({
  family: "disappearance",
  eventKind: "disappearance",
  delay: { min: 12, max: 25 },
  resolve: (ctx) => {
    const partner = actorOf(ctx, "partner");
    const missing = actorOf(ctx, "missing");
    const relative = actorOf(ctx, "relative");
    return {
      person: partner, caller: partner,
      named: { "missing woman": missing, "person she set off to visit": relative },
      extra: { missing, relative },
    };
  },
  callerRole: "caller",
  report: (place, window) =>
    `At ${window.end} today a man called 911 from ${place} to report his girlfriend missing. She lives with him there. `
    + `He said she left home alone at about ${window.start} to visit a relative, that the relative has since rung him to say she never arrived, that she is not answering her phone, and that he has been at home since she left.`,
  // A missing-person report does not say a crime happened, and neither may
  // the question: the agent either says where she is, or names who is
  // responsible if it concludes there was a crime. Only the names are scored;
  // the location is there so that asking does not give the answer away.
  ask: {
    question: "Find out what happened to her. Either give where she is now or, if you conclude that a crime is involved, rank the people most likely responsible, best first, by person identity.",
    answer: {
      kind: "record",
      independentFields: true,
      description: "Where she is now, or who is responsible; give whichever your findings support.",
      fields: {
        location: { kind: "point", optional: true, description: "Where she is now." },
        suspects: { kind: "ranked-ids", identifier: "person", optional: true,
          description: "Person identities of whoever is responsible, most likely first, if a crime is involved." },
      },
    },
    scoring: {
      method: "record",
      params: { fields: { suspects: "rank" }, ungraded: ["location"] },
      aggregate: "mrr over suspects; also report top-1 accuracy and recall@5",
    },
  },
});
