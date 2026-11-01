/**
 * Real-Time Investigations (RTIs): the families that read a day a scenario
 * was staged into. An incident has just happened; the agent works it as it
 * stands minutes later, against records KDI cuts off at that instant. Every
 * generator here declares the event `kind` it reads, so it runs only on a
 * scenario day that stages that kind. The shared header-reading helpers are
 * in `scenario.ts` beside them.
 */

import type { TaskGenerator } from "../../generator.ts";
import { explosion, massShooting, schoolShooting, shotsFired } from "./suspects.ts";
import { protestMembers } from "./protest-members.ts";
import { massGathering } from "./mass-gathering.ts";
import { abduction } from "./abduction.ts";

export const RTI_GENERATORS: readonly TaskGenerator[] = [
  massShooting,
  shotsFired,
  explosion,
  schoolShooting,
  protestMembers,
  massGathering,
  abduction,
];
