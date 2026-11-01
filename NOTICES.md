# Known issues

- **The personalized-plate rate is a national figure, not a Pennsylvania one.**
`init/personal_records/vehicles.py` issues a vanity plate to 2.6% of
registrations before the income weighting, which lands 2.4% of the registry on
one. Around 2% of US registrations carry a personalized plate, but the spread
between states is enormous — Virginia is near 16% — and no per-state PennDOT
figure was to hand. The income gradient over it, the 62% that spell the owner's
own name, and the pool of words the rest are drawn from are all invented.

  What it changes if wrong: the share of plates that leak their owner's
identity to anything reading them, and the share that defeat a syntax check —
a personalized plate may contain I, O and Q, which the sequential series skips.

- **The dwelling-stock fit is measured over a slightly wider population than
the stock it parameterises.** `init/intake/fit.py` fits `area_per_unit` and
`flats_by_level` from every multi-unit block with a usable footprint, including
the handful that carry POI tags — which the stock itself then excludes as
storefronts rather than homes. For Kierston that is five buildings, and
narrowing the fit to match would move `area_per_unit` from 106.0 to 105.9 and
change every area-estimated unit count in the city.

  It is kept as-is deliberately: 106.0 is the number the stock has always been
  built with, and the reorganization that introduced fitting was required to
  leave Kierston's parameters untouched. The inconsistency is small, recorded
  in `sim_data/intake.json` along with the sample it was measured on, and worth
  correcting the next time the building export is refreshed and the stock is
  expected to move anyway.

- **Two of the four dwelling-stock parameters are judgements, not measurements.**
`flats_default` (4, for apartment blocks OSM gives no height at all) and
`flats_per_tall_level` (12, for five levels and up) live in the city profile
rather than being fitted, because no sample answers them: the first is defined
by the absence of the data that would fit it, and the second has 16 blocks
behind it in Kierston whose flats-per-level median is 11.2 — close to 12, but
chosen rather than derived. A new city inherits both numbers unchanged unless
its author edits the profile, and nothing measures whether they suit it.

- **The TACs are real, and the table behind them is a community mirror.** Every
TAC in `reference/tac_table.json` is a genuine GSMA allocation for the model the
record claims, cut from [MoazEb/tac-database](https://github.com/MoazEb/tac-database)
(MIT, 254,995 rows, coverage to December 2025) by
`reference/build/build_tac_table.py`. That is deliberate: a TAC names a *model*,
not a person and not a handset — the six-digit serial after it is what makes a
phone unique — so a real iPhone 15 TAC on a synthetic iPhone 15 impersonates
nobody, while an invented one would resolve to nothing and mark every handset in
the city as fake to the first tool that looked one up. What remains uncertain:

  - **It is not the GSMA's own database.** The source is cross-referenced from
    Osmocom's tacdb and public IMEI lookups, which is good enough for a TAC —
    a published fact the moment a phone ships — but it is a mirror and can be
    stale or wrong in a way nothing here would catch. 64 of 64 catalogue models
    resolved, so no model is guessed at, but the allocations themselves are
    trusted rather than verified.
  - **Five models are thin.** TCL 50 XE 5G and Nokia G300 resolved to a single
    TAC each; Galaxy S22, OnePlus Nord N30 and Nokia G400 5G to two. Real
    handsets of those models carry more allocations than that, so the city's
    copies of them share a TAC more often than reality would.
  - **Only 19 of 64 models resolved to a US-market variant.** Samsung suffixes
    its US models `U`/`U1` and Apple annotates some A-numbers, so those are
    pinned to the variant an Allentown pocket would actually hold. Google's
    G-codes, Motorola's XT numbers and most of the rest carry no region marker
    in this source, so those handsets may report the TAC of a variant sold
    somewhere else. The record is a real allocation for the right model either
    way; it is the market that is not pinned down.
  - **Release years come from the source's variant strings**, which state a
    global launch. For the Galaxy A15 5G (2023), Galaxy A16 5G (2024) and
    OnePlus 13 (2024) the US launch was some months into the following year, so
    a handful of handsets are acquired shortly before those models reached US
    shelves. The catalogue no longer carries its own release year — one source
    of truth, and it is the one with the allocation behind it.
  - **Model names are the catalogue's, not the source's.** `devices.py` writes
    "moto g stylus (2023)" where the database says "MOTOROLA MOTO G STYLUS
    (2023)", and "Nord N30" where OnePlus's US retail name was "Nord N30 5G".
    The join between the two is written out by hand in `reference/build/build_tac_table.py` and
    checked on every build, but a string comparison against a TAC lookup's own
    model text will not match.
  - **Four models were dropped rather than guessed at.** BLU and ZTE have no
    modern handsets in this source, so both brands left the catalogue and the
    very cheapest end of the prepaid channel is now carried by TCL, Nokia and
    Motorola alone. LG K30 went because the source dates some of its variants
    2018 and others 2019 — two different phones under one name — with no way to
    tell the allocations apart.

- **Nothing about a handset is surveyed.** ACS asks whether a household has
telephone service and stops. Every distribution in `devices.py` is therefore
modelled, and these are the ones resting on a published figure loosely enough
that they should be treated as shapes rather than measurements:

  - **Platform by age.** The ~85% iPhone share among US teenagers and the
    ~55-58% overall are widely published; the eight-band curve between them,
    and the odds multipliers for income and for nativity, are fitted to hit
    those two anchors and are not separately sourced. The immigrant tilt in
    particular (0.62 foreign-born, a further 0.45 inside ten years of entry) is
    a strong, well-attested direction with no number behind its magnitude.
  - **Device age.** Median US phone age of roughly 2.5-3 years is published;
    the lognormal σ of 0.62 and the 0.74-1.35 spread by income band are chosen
    so that about a sixth of handsets are five years or older, which
    replacement-cycle surveys imply but do not state.
  - **Model share.** Brand shares of the US Android base are approximately
    right (Samsung ~58%, Motorola ~14%); the price-tier weights by income band
    and the release-recency decay are invented, and the resulting model mix is
    plausible rather than measured.
  - **Carrier shares.** The big three are close to published connection
    shares. The MVNO weights, and especially the oversizing of Xfinity Mobile
    for Comcast's home cable footprint, are judgement. **Boost's host split**
    (45% its own EchoStar network, 30% AT&T, 25% T-Mobile) is invented — Boost
    genuinely runs both its own network and inherited MVNO agreements, and the
    proportion is not published.
  - **Prepaid by income** (46% in the bottom band to 7% in the top) reproduces
    a real and steep gradient with invented steps; the citywide 25% it produces
    sits above the national ~22% because this city is poorer, which is the
    conditioning working rather than an error.
  - **Account holder.** That nearly every minor's line is on a parent's account
    is not in doubt; the unwind through the twenties (52% at 18-21, 13% at
    25-29) and the 7% of over-65s on an adult child's plan are estimates.
  - **OS support windows.** Six years for an iPhone and one for a budget
    Android are the right order of magnitude and are stated per make and tier
    with more precision than any single source supports.

- **Messaging-platform adoption is published reach and modelled everything
else.** No dataset in the extract knows what anybody's apps are, so
`accounts.py` starts from Pew Research Center's platform reach and age
gradients and models the rest. Which of the rest to distrust:

  - **The WhatsApp nativity effect is directionally certain and numerically
    invented.** That US WhatsApp use is concentrated among Hispanic and
    foreign-born adults is one of the largest and best-attested demographic
    effects on any platform. The odds multipliers that produce it here (2.9
    Hispanic, 3.4 foreign-born, a further 1.6 inside twelve years of entry)
    are fitted to land the published overall reach with a plausible spread,
    not read off a table. The resulting 13% US-born against 48% foreign-born
    is a shape, not a measurement.
  - **Telegram's regional concentration is judgement.** The platform's US
    reach is small and published; that it clusters in European and Middle
    Eastern diasporas is well attested and the multipliers (3.2 and 3.6) are
    invented.
  - **Signal keys on occupation with no source at all.** The 3.8 multiplier
    for computer and mathematical occupations reproduces a real and obvious
    pattern with a number nobody has published.
  - **Contagion and breadth are pure model.** The log-odds boost per unit of
    "share of my close ties already on this platform" (2.6) and the per-person
    breadth trait (σ 0.85) exist to stop adoption landing as a demographic
    sprinkle with correct marginals and no clustering. Both are set by how the
    output looks, not by evidence.
  - **Group-chat formation is entirely invented.** The per-focus rates at
    which a household, work unit or congregation actually has a thread, the
    70% share of a group that must have an app before the thread runs there,
    and the size caps are all judgement.

- **Nothing about conversation volume or timing is surveyed either.** The
attention curve in `sim/src/comms/attention.ts` derives when somebody is
reachable from their own planned day, which is a structural claim rather than a
fitted one; the levels it assigns to each state are estimates. The figures
calibrated by looking at the city's own output rather than at any source:

  - **The per-tie contact rate** (27 exchanges a week at full affinity, an
    affinity exponent of 2.0, exposure damping to a third) is tuned so the
    city sends about twenty messages per person per day. The first value tried
    produced a fifth of that.
  - **Reply and decay probabilities per purpose**, and the purpose mix itself
    (52% logistical, 22% conversational, 19% voice, 7% broadcast), are chosen
    for the message-count distribution they produce.
  - **The answer rate.** 57% of calls answered and 43% not is in the right
    region for personal calls and is not read from a source. Note that only
    social calls are modelled at all — no business calls, no robocalls — so
    the city's ~1 call per person per day is not comparable to published
    per-subscriber call volumes.
  - **The evening lift** on unclaimed time is the one place a clock enters the
    model rather than the day plan, and it exists because without it the
    city's messaging peaked in the middle of the afternoon.

- **The EID checksum is implemented from the scheme, not from a test vector.**
GSMA SGP.02 gives the 32-digit eUICC identifier two check digits computed the
IBAN way — append `00`, take mod 97, subtract from 98 — and `devices.py`
verifies its own output satisfies `EID mod 97 == 1`. That proves the
implementation is self-consistent, not that it agrees with a real EID.

- **Taxi demand — fixed, and the constraint has moved to supply.** Demand no
longer descends only from JWTRNS 7. `sim/src/transport/hire.ts` adds the two groups the
commute question cannot see: adults in households the vehicle registry gives no
car to, and people old enough to have stopped driving with nobody at home to
drive them. On a weekday the fleet now turns 16.7 fares per driver against the
trade's 15–25, up from 4.0, and its empty running falls from 62% to 41% against
a published 40–50% — a figure nothing in the fit aims at, which is the best
evidence available that the level is right. The stands moved with the demand:
they were clustered from the 198 commuters and are now clustered from all 8,743
people who can order a car, which took a minute off the median wait and put the
last idle driver to work. Visitors are still missing and still out of reach:
they are not in the population.

- **The fleet cannot serve the weekend.** 127 drivers are rostered on a Tuesday
and 48 on a Sunday, because `roster.ts` gives cab driving the general
population's `WEEKEND_WORKER`. Demand does not fall the same way — a carless
household shops on Sunday too — so Sunday runs 67 requests per rostered driver
against 20 on a Tuesday, and only 38% of them get a car. Either taxi driving
needs a rota of its own, which is what the trade actually looks like, or the
weekend fleet is genuinely this small and the unserved calls are real. Nothing
here can tell the two apart; `init/work/shifts.py` is where it would be fixed.

- **15% of weekday requests get no car**, and a further 25% only after the
passenger has walked on and asked again. That is no longer the 0.3% the
fallbacks used to see — they are exercised by the default run now rather than
only by a starved one — but it is worth knowing that the number is set by
`MAX_WAIT`, the passenger's 18-minute patience, and not by anything measured. A
real dispatcher quotes a longer ETA and keeps the booking.

- **A stop reached late keeps its planned departure**, so 10.6% of discretionary
stops record a leave earlier than their arrival. Pre-existing and not a taxi
problem — it was 9.0% before the hire layer, which moved it by 1.6 points by
making more people late. `travel.ts::resolve` pushes `leave` by the overrun for
a stay that is neither fixed nor just-in-time, and something on that path is not
reaching the stop's own record.

- **Seventeen union locals have no premises.** They exist as a body of members
and OSM has no building for them, so `day.ts` now skips the stay rather than
travelling to a null coordinate — which the router had been silently pricing as
a drive across town. Those members attend nothing, which understates union
exposure by however much a local's meetings are worth.
