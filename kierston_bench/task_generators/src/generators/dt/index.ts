/**
 * Deception Tasks (DTs): the families that read a staged day with a story
 * attached. Somebody has told the dispatcher what happened — a partner
 * found a body, a caller saw a gunman, a woman never arrived — and the
 * prompt repeats it as told. The records contradict it; the family's truth is the person the
 * records point to, never the one the story does. Nothing in the prompt
 * or the evidence says the account is false, so an agent scores by reading
 * the records rather than by taking the caller at their word.
 *
 * Like the RTI families these read a scenario day (base + .kdiff), declare the
 * event `kind` they need, and cut the records off minutes after.
 */

import type { TaskGenerator } from "../../generator.ts";
import { disappearance } from "./disappearance.ts";
import { stabbing } from "./stabbing.ts";
import { swatting } from "./swatting.ts";

export const DT_GENERATORS: readonly TaskGenerator[] = [
  stabbing,
  swatting,
  disappearance,
];
