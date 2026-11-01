/**
 * Technical Tasks (TTs): the families that read a plain observed day. Each
 * asks one narrow question about the records — who holds a device, where
 * someone lived, who shared a car — whose truth is on the day's truth side
 * or in the static registers, and whose answer is exactly checkable.
 */

import type { TaskGenerator } from "../../generator.ts";
import { personReid } from "./person-reid.ts";
import { deviceToPerson } from "./device-to-person.ts";
import { accountResolution } from "./account-resolution.ts";
import { plateReconciliation } from "./plate-reconciliation.ts";
import { pointInTimeLocation } from "./point-in-time-location.ts";
import { vehicleOccupancy } from "./vehicle-occupancy.ts";
import { originDestination } from "./origin-destination.ts";
import { tripMode } from "./trip-mode.ts";
import { homeId } from "./home-id.ts";
import { workplaceId } from "./workplace-id.ts";
import { schoolEscort } from "./school-escort.ts";
import { householdRecon } from "./household-recon.ts";
import { kinshipInfer } from "./kinship-infer.ts";
import { relationshipType } from "./relationship-type.ts";
import { organizationMembership } from "./organization-membership.ts";
import { meetingRecon } from "./meeting-recon.ts";
import { sharedTravel } from "./shared-travel.ts";
import { payerInfer } from "./payer-infer.ts";
import { counterpartyRecon } from "./counterparty-recon.ts";
import { conversationClassif } from "./conversation-classif.ts";
import { colocation } from "./colocation.ts";
import { transactionToVisit } from "./transaction-to-visit.ts";

export const TECHNICAL_GENERATORS: readonly TaskGenerator[] = [
  personReid,
  deviceToPerson,
  accountResolution,
  plateReconciliation,
  pointInTimeLocation,
  vehicleOccupancy,
  originDestination,
  tripMode,
  homeId,
  workplaceId,
  schoolEscort,
  householdRecon,
  kinshipInfer,
  relationshipType,
  organizationMembership,
  meetingRecon,
  sharedTravel,
  payerInfer,
  counterpartyRecon,
  conversationClassif,
  colocation,
  transactionToVisit,
];
