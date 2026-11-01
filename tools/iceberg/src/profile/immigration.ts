/**
 * The immigration timeline, which is the one part of identity.bin whose facts
 * sit between a person and their papers rather than inside either.
 *
 * `records.ts` already catches a document dated before its holder was born.
 * What it cannot see is a timeline nobody could have lived: a green card one
 * year before naturalisation when the statute asks for five, an oath taken at
 * twelve, an H-1B held by a nine-year-old, a "temporary" resident whose I-94
 * ran out a decade ago. Each of those is a person and a document that are
 * individually plausible and only wrong against each other, so they are
 * checked here by joining the document table back to the identity row.
 *
 * The rule most worth having is the first one. PUMS years are the interview's
 * calendar, and the city ages everybody to its own reference year; a reported
 * year that is not moved with the age lands before the person was born. That
 * happened once, to a thousand people, and it shows up here first.
 *
 * Keyed on what the tables carry, like banking.ts: an identity file without
 * documents, or written before `resident_since` existed, skips the parts it
 * cannot answer.
 */

import { Builder, Cat, Num } from "../metrics.ts";
import { RecordSet, dateYear } from "../tables.ts";

/** INA 316(a) and 319(a): five years of residence, three for a citizen's spouse. */
const WAIT = 5;
const WAIT_SPOUSE = 3;
/** The class a citizen's spouse is admitted in, and the one the three years need. */
const SPOUSE_CLASS = "IR1";

/**
 * Classes a child is admitted in, as a child: IR2 and F22, and the child
 * derivative of every programme that has one. Held past 21 they are wrong.
 */
const CHILD_CLASSES = new Set(["IR2", "F22", "E15", "E23", "E35", "RE8", "AS8", "DV3"]);

/** Nonimmigrant categories held by the student or worker, never a dependant. */
const PRINCIPAL_VISAS = new Set(["F-1", "H-1B", "J-1", "L-1", "TN"]);

/** No EAD is issued below this age in practice, and the generator holds it. */
const EAD_MINIMUM_AGE = 16;

/**
 * How long a refugee or asylee stays one. A refugee must adjust after a year
 * and an asylee usually has by three, so past that the person is an LPR whose
 * card says RE6 or AS6.
 */
const HUMANITARIAN_LIMIT = 3;

export function analyseImmigration(b: Builder, set: RecordSet): void {
  const identity = set.table("identity");
  const documents = set.table("document");
  if (!identity || !documents || !identity.has("entry_year")) return;
  const at = "records.identity.immigration";
  const today: number = set.meta.referenceYear ?? new Date().getUTCFullYear();

  const born = identity.field("birth_date")!;
  const entry = identity.field("entry_year")!;
  const naturalized = identity.field("naturalized_year")!;
  const status = identity.field("legal_status")!;
  const citizenship = identity.field("citizenship")!;
  const basis = identity.field("status_basis");
  const married = identity.field("marital_married_year");

  const birthYear = (id: number) => dateYear(born.column[id]) ?? 0;

  // Person-level rules first.
  let entered = 0, enteredBefore = 0;
  let naturalizedChecked = 0, naturalizedBefore = 0;
  let foreign = 0, withoutBasis = 0;
  let humanitarian = 0, overdue = 0;
  let marriedChecked = 0, marriedYoung = 0;
  const ageAtEntry = new Num();
  const ageAtNaturalization = new Num();
  const basisByStatus = new Map<string, Cat>();
  const examples = { entry: [] as string[], naturalized: [] as string[], basis: [] as string[], overdue: [] as string[] };

  for (let id = 0; id < identity.rows; id += 1) {
    const year = birthYear(id);
    const arrived = identity.value(entry, id) as number | null;
    if (arrived !== null) {
      entered += 1;
      ageAtEntry.push(arrived - year);
      if (arrived < year) {
        enteredBefore += 1;
        if (examples.entry.length < 5) examples.entry.push(`resident ${id}: born ${year}, entered ${arrived}`);
      }
    }
    const oath = identity.value(naturalized, id) as number | null;
    if (oath !== null) {
      naturalizedChecked += 1;
      ageAtNaturalization.push(oath - year);
      if (oath < year) {
        naturalizedBefore += 1;
        if (examples.naturalized.length < 5) examples.naturalized.push(`resident ${id}: born ${year}, naturalized ${oath}`);
      }
    }
    const legal = identity.label(status, id);
    if (basis && legal && legal !== "citizen") {
      foreign += 1;
      const why = identity.label(basis, id);
      if (!why) {
        withoutBasis += 1;
        if (examples.basis.length < 5) examples.basis.push(`resident ${id}: ${legal} with no basis`);
      }
      const cat = basisByStatus.get(legal) ?? new Cat();
      cat.add(why ?? "«null»");
      basisByStatus.set(legal, cat);
      if (legal === "humanitarian" && arrived !== null) {
        humanitarian += 1;
        if ((why === "refugee" || why === "asylee") && today - arrived > HUMANITARIAN_LIMIT) {
          overdue += 1;
          if (examples.overdue.length < 5) examples.overdue.push(`resident ${id}: ${why} since ${arrived}`);
        }
      }
    }
    if (married) {
      const wed = identity.value(married, id) as number | null;
      if (wed !== null) {
        marriedChecked += 1;
        if (wed - year < 15) marriedYoung += 1;
      }
    }
  }

  b.num(`${at}.ageAtEntry`, ageAtEntry);
  b.num(`${at}.ageAtNaturalization`, ageAtNaturalization);
  b.invariant(`${at}.enteredBeforeBirth`, "nobody entered the country before being born", enteredBefore, entered, examples.entry);
  b.invariant(`${at}.naturalizedBeforeBirth`, "nobody naturalized before being born", naturalizedBefore, naturalizedChecked, examples.naturalized);
  // Married at thirteen or fourteen is in the survey for a few dozen people,
  // so this is measured rather than ruled. Before survey years were shifted
  // it was six thousand, which is the movement it is here to catch.
  b.countAndShare(`${at}.marriedBefore15`, marriedYoung, marriedChecked);
  if (basis) {
    b.invariant(`${at}.statusWithoutBasis`, "every noncitizen and naturalized status names its basis", withoutBasis, foreign, examples.basis);
    b.invariant(`${at}.refugeePastAdjustment`, "no refugee or asylee is still one more than three years after arriving", overdue, humanitarian, examples.overdue);
    for (const [legal, cat] of basisByStatus) b.cat(`${at}.basis.by.status.${legal}`, cat);
  }

  // Then the documents, each against its holder.
  const person = documents.field("person")!;
  const kind = documents.field("document")!;
  const issued = documents.field("issued")!;
  const expires = documents.field("expires")!;
  const category = documents.field("category");
  const docBasis = documents.field("basis");
  const since = documents.field("resident_since");

  let oathChecked = 0, oathMinor = 0;
  let waitChecked = 0, insideWait = 0, cardAfterOath = 0;
  let cards = 0, unclassed = 0, childChecked = 0, childAsAdult = 0;
  let visas = 0, minorPrincipal = 0;
  let eads = 0, eadYoung = 0;
  let admissions = 0, lapsedInStatus = 0;
  let residentCards = 0, residentCardsExpired = 0;
  // Numbered from series — an A-number is one file's, a certificate number one
  // oath's — so within a kind a number is never held twice. Across kinds it
  // could be; two countries' passports can agree.
  const numbers = documents.field("number");
  const numbered = new Map<string, Set<string>>();
  let reused = 0;
  const reusedExamples: string[] = [];
  const wait = new Num();
  const lag = new Num();
  const classes = new Cat();
  const docExamples = { oath: [] as string[], wait: [] as string[], card: [] as string[], visa: [] as string[], ead: [] as string[], i94: [] as string[] };

  for (let row = 0; row < documents.rows; row += 1) {
    const id = person.column[row];
    if (id >= identity.rows) continue;
    const document = documents.label(kind, row);
    const year = birthYear(id);
    const age = today - year;
    const legal = identity.label(status, id);
    const oath = identity.value(naturalized, id) as number | null;

    const value = numbers ? documents.label(numbers, row) : null;
    if (document && value) {
      const seen = numbered.get(document) ?? new Set<string>();
      if (seen.has(value)) {
        reused += 1;
        if (reusedExamples.length < 5) reusedExamples.push(`${document} ${value} at row ${row}`);
      } else seen.add(value);
      numbered.set(document, seen);
    }

    if (document === "certificate_of_naturalization" && oath !== null) {
      oathChecked += 1;
      if (oath - year < 18) {
        oathMinor += 1;
        if (docExamples.oath.length < 5) docExamples.oath.push(`resident ${id}: naturalized at ${oath - year}`);
      }
    }

    if (document === "permanent_resident_card") {
      cards += 1;
      const cls = category ? documents.label(category, row) : null;
      const began = since ? documents.value(since, row) as number | null : null;
      if (!cls || (docBasis && !documents.label(docBasis, row)) || (since && began === null)) {
        unclassed += 1;
        if (docExamples.card.length < 5) docExamples.card.push(`row ${row}, resident ${id}: card without class, basis or resident-since`);
      }
      if (cls) classes.add(cls);
      if (cls && began !== null && CHILD_CLASSES.has(cls)) {
        childChecked += 1;
        if (began - year >= 21) childAsAdult += 1;
      }
      const arrived = identity.value(entry, id) as number | null;
      if (began !== null && arrived !== null) lag.push(began - arrived);
      if (identity.label(citizenship, id) === "naturalized" && oath !== null && began !== null) {
        if (began > oath) cardAfterOath += 1;
        if (oath - year >= 18) {
          waitChecked += 1;
          wait.push(oath - began);
          const needed = cls === SPOUSE_CLASS ? WAIT_SPOUSE : WAIT;
          if (oath - began < needed) {
            insideWait += 1;
            if (docExamples.wait.length < 5) docExamples.wait.push(`resident ${id}: ${cls} resident ${began}, naturalized ${oath}`);
          }
        }
      }
      if (legal === "lpr") {
        residentCards += 1;
        const end = documents.value(expires, row) as number | null;
        if (end !== null && end < today) residentCardsExpired += 1;
      }
    }

    if (document === "nonimmigrant_visa" && legal === "temporary") {
      visas += 1;
      const cls = category ? documents.label(category, row) : null;
      if (cls && PRINCIPAL_VISAS.has(cls) && age < 18) {
        minorPrincipal += 1;
        if (docExamples.visa.length < 5) docExamples.visa.push(`resident ${id}: ${cls} at ${age}`);
      }
    }

    if (document === "employment_authorization") {
      eads += 1;
      const from = documents.value(issued, row) as number | null;
      if (from !== null && from - year < EAD_MINIMUM_AGE) {
        eadYoung += 1;
        if (docExamples.ead.length < 5) docExamples.ead.push(`resident ${id}: EAD issued at ${from - year}`);
      }
    }

    if (document === "arrival_departure_record" && legal === "temporary") {
      admissions += 1;
      const end = documents.value(expires, row) as number | null;
      if (end !== null && end < today) {
        lapsedInStatus += 1;
        if (docExamples.i94.length < 5) docExamples.i94.push(`resident ${id}: I-94 expired ${end}`);
      }
    }
  }

  b.num(`${at}.naturalizationWait`, wait);
  b.num(`${at}.residenceAfterEntry`, lag);
  b.cat(`${at}.admissionClass`, classes);
  b.countAndShare(`${at}.lprCardsExpired`, residentCardsExpired, residentCards);
  b.invariant(`${at}.naturalizedUnder18`, "nobody under 18 naturalizes by oath (minors derive citizenship)", oathMinor, oathChecked, docExamples.oath);
  b.invariant(`${at}.naturalizedCardAfterOath`, "a naturalized citizen's residence began before the oath", cardAfterOath, waitChecked, []);
  if (since) {
    b.invariant(`${at}.naturalizedInsideWait`, "naturalization comes five years after residence began, three for a citizen's spouse", insideWait, waitChecked, docExamples.wait);
    b.invariant(`${at}.childClassAsAdult`, "a child's class of admission is held by someone under 21", childAsAdult, childChecked);
  }
  b.invariant(`${at}.greenCardWithoutClass`, "every green card carries its class of admission, basis and resident-since year", unclassed, cards, docExamples.card);
  b.invariant(`${at}.principalVisaMinor`, "no child holds a student or worker's principal visa", minorPrincipal, visas, docExamples.visa);
  b.invariant(`${at}.eadUnder16`, "no EAD is issued to anyone under 16", eadYoung, eads, docExamples.ead);
  b.invariant(`${at}.documentNumberReused`, "no document number is issued twice within its kind", reused, documents.rows, reusedExamples);
  b.invariant(`${at}.temporaryOnExpiredI94`, "a resident on temporary status holds an I-94 that has not run out", lapsedInStatus, admissions, docExamples.i94);
}
