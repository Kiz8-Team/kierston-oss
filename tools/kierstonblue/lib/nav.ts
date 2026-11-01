import {
  Banknote,
  Briefcase,
  Building2,
  Bus,
  Cctv,
  Car,
  CarFront,
  CarTaxiFront,
  CalendarDays,
  Crosshair,
  FileText,
  GitCompareArrows,
  GraduationCap,
  Handshake,
  Home,
  IdCard,
  LayoutDashboard,
  LocateFixed,
  Map,
  MessageCircleMore,
  MessagesSquare,
  RadioTower,
  Receipt,
  Route,
  Scale,
  School,
  Share2,
  Siren,
  Smartphone,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

/**
 * The one description of where you can go.
 *
 * The rail and the command palette were drifting apart — a page added to the
 * rail was not reachable from ⌘K, and the palette's wording was a second
 * guess at what each page does. Both read this now, so a destination is
 * described once: the label a reader scans for, the hint that says what is on
 * the page, and the keywords that let the palette match "guns" to Firearms.
 */

export interface NavLink {
  href: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  /** Extra words the command palette matches on, beyond label and hint. */
  keywords?: string;
}

export interface NavSection {
  title: string;
  links: NavLink[];
}

export const NAV: NavSection[] = [
  {
    title: "Overview",
    links: [
      {
        href: "/",
        label: "Global aggregates",
        hint: "distributions",
        icon: LayoutDashboard,
        keywords: "home summary overview totals glance dashboard charts distributions "
          + "citywide age income race employment school",
      },
    ],
  },
  {
    title: "Map",
    links: [
      {
        href: "/map",
        label: "Explorer",
        hint: "roads · POIs · buildings",
        icon: Map,
        keywords: "geography streets places",
      },
      {
        href: "/map?panel=analysis",
        label: "Area analysis",
        hint: "density · age · income",
        icon: Crosshair,
        keywords: "choropleth heatmap cells grid",
      },
      // With the map rather than beside the phones: what this page draws is
      // geography — where the masts are and what ground each cell claims. The
      // handsets that attach to them are a different table and a different
      // question, and /devices answers that one.
      {
        href: "/towers",
        label: "Cell network",
        hint: "masts · sectors · areas",
        icon: RadioTower,
        keywords: "cell tower towers mast masts antenna site sites structure asr "
          + "coverage sector azimuth band lte nr 5g carrier operator verizon at&t "
          + "t-mobile boost tracking area tac cgi ecgi ncgi pci enodeb gnodeb "
          + "colocation range cdr network signal",
      },
      // Beside the network it reads: the page answers how precisely those
      // masts, their timing advance and their secondary carriers can place a
      // handset when all an analyst has is the operator's records.
      {
        href: "/cell-location",
        label: "Cell location estimator",
        hint: "records vs truth",
        icon: LocateFixed,
        keywords: "cellular location estimate estimator geolocation localisation "
          + "localization handset phone position timing advance ta secondary carrier "
          + "cell id sector azimuth ring accuracy error precision coarse fine "
          + "network events cdr sms tau tracking area ground truth agent evidence",
      },
      {
        href: "/cameras",
        label: "Plate readers",
        hint: "ALPR · coverage · aim",
        icon: Cctv,
        keywords: "camera cameras alpr lpr anpr plate plates licence license "
          + "reader readers surveillance cctv capture zone fov "
          + "field of view azimuth bearing direction cone mount pole mast arm "
          + "storefront cordon arterial commercial coverage greedy drivers "
          + "traffic volume vehicles rear plate pennsylvania",
      },
      {
        href: "/routes",
        label: "Routes",
        hint: "pathfinder",
        icon: Route,
        keywords: "drive time directions navigation",
      },
    ],
  },
  {
    title: "Population",
    links: [
      {
        href: "/households",
        label: "Households",
        hint: "browse",
        icon: Home,
        keywords: "families dwellings addresses tenure",
      },
      {
        href: "/people",
        label: "People",
        hint: "browse",
        icon: Users,
        keywords: "residents persons age sex income",
      },
    ],
  },
  {
    title: "Social",
    links: [
      {
        href: "/social",
        label: "Social graph",
        hint: "ties",
        icon: Share2,
        keywords: "ties network friends neighbours contacts",
      },
      // Beside the graph rather than with the phones: the tie graph says who a
      // person would talk to and this says who they actually did, on one date.
      // The handsets those messages left from are a different table and
      // /devices answers that.
      // Between the graph and the messages, because that is where it sits in
      // the causal chain: a tie makes a gathering likely, a gathering happens,
      // and the phones around it go quiet. A reader following that story
      // should not have to leave the section to see the middle of it.
      {
        href: "/meetings",
        label: "Gatherings",
        hint: "attendees · venues",
        icon: Handshake,
        keywords: "meeting meetings gathering gatherings meet meetup coffee "
          + "dinner drinks party visit outing household family friends "
          + "co-presence together attendees party venue convener host lift "
          + "carpool driver rider timeline arrivals",
      },
      {
        href: "/comms",
        label: "Messages and calls",
        hint: "threads · attention · CDR",
        icon: MessagesSquare,
        keywords: "message messages sms mms text texting imessage whatsapp "
          + "telegram signal messenger snapchat call calls voice cdr call detail "
          + "record thread threads conversation chat group dyad broadcast reply "
          + "latency attention curve glance glances screen phone in hand awake "
          + "asleep unreachable handle handles msisdn account accounts platform "
          + "carrier operator segment delivery report",
      },
    ],
  },
  {
    title: "Work",
    links: [
      {
        href: "/work",
        label: "Jobs",
        hint: "occupations · commutes",
        icon: Briefcase,
        keywords: "employment occupation commute shifts",
      },
      {
        href: "/workplaces",
        label: "Workplaces",
        hint: "sites · rosters",
        icon: Building2,
        keywords: "employers sites staff businesses",
      },
    ],
  },
  {
    title: "Education",
    links: [
      {
        href: "/students",
        label: "Students",
        hint: "enrollment · grades",
        icon: GraduationCap,
        keywords: "enrollment pupils grade band",
      },
      {
        href: "/schools",
        label: "Schools",
        hint: "rolls · catchments",
        icon: School,
        keywords: "campuses districts places seats",
      },
      {
        href: "/buses",
        label: "School buses",
        hint: "trips · fleet · drivers",
        icon: Bus,
        keywords: "bus routes stops riders lifts escort walk transit yellow",
      },
    ],
  },
  {
    title: "Transport",
    links: [
      {
        href: "/days",
        label: "Daily movement",
        hint: "schedules · trips",
        icon: CalendarDays,
        keywords: "day itinerary timeline movement journey person paths kday",
      },
      {
        href: "/scenarios",
        label: "Scenarios",
        hint: "deltas · diffs",
        icon: GitCompareArrows,
        keywords: "kdiff kdif delta scenario patch diff baseline compare merge "
          + "materialize replay coffee taxi seed affected ground truth",
      },
      // Beside the resident's day: this is the same date from the car's end.
      // The rail entry lands on the finder; every VIN in the app links
      // straight to the vehicle itself.
      {
        href: "/vehicles/movement",
        label: "Vehicle movement",
        hint: "VIN · parked · moving",
        icon: CarFront,
        keywords: "vehicle vehicles car cars vin fleet parked kerb driveway "
          + "moving journey drive driver passengers riders lift carpool "
          + "occupants mileage kilometres taxi cab school bus day kday",
      },
      {
        href: "/taxi",
        label: "Taxis",
        hint: "stands · drivers · riders",
        icon: CarTaxiFront,
        keywords: "cab cabs rank stand dispatch fleet hackney driver JWTRNS",
      },
    ],
  },
  {
    title: "Identity",
    links: [
      {
        href: "/record",
        label: "Full record",
        hint: "dossier",
        icon: FileText,
        keywords: "dossier profile everything person",
      },
      {
        href: "/identities",
        label: "Identities",
        hint: "names · ids · status",
        icon: IdCard,
        keywords: "names ssn documents passport licence birth",
      },
      // Beside the identities rather than under Holdings: a phone is how you
      // reach somebody, not something they own like a car. Both pages read
      // identity.bin, so arriving from one has already paid for the other.
      {
        href: "/devices",
        label: "Phones and lines",
        hint: "handsets · IMEI · SIM",
        icon: Smartphone,
        keywords: "phone phones mobile handset device imei imsi iccid eid tac "
          + "sim esim carrier mvno prepaid postpaid msisdn number subscription "
          + "line android ios iphone samsung network subscriber",
      },
      {
        href: "/accounts",
        label: "Messaging accounts",
        hint: "reach · calibration",
        icon: MessageCircleMore,
        keywords: "account accounts handle handles sms imessage whatsapp telegram "
          + "signal messenger snapchat platform adoption reach pew target "
          + "intercept contagion username display name",
      },
    ],
  },
  // Its own section rather than under Justice: a call for service is an
  // operational event on one date, read out of the day file, not a record a
  // resident carries. Police and EMS runs share the page.
  {
    title: "Emergency",
    links: [
      {
        href: "/dispatch",
        label: "911 calls",
        hint: "calls · units · response",
        icon: Siren,
        keywords: "911 emergency dispatch cad call calls for service cfs incident "
          + "incidents police patrol officer unit units ems ambulance paramedic "
          + "emt hospital transport response time on scene cleared unserved "
          + "priority caller",
      },
    ],
  },
  {
    title: "Justice",
    links: [
      {
        href: "/criminal",
        label: "Criminal record",
        hint: "cases · charges",
        icon: Scale,
        keywords: "arrests convictions dockets sentences police",
      },
      {
        href: "/civil",
        label: "Civil and family",
        hint: "dockets",
        icon: FileText,
        keywords: "divorce custody support protection orders",
      },
    ],
  },
  {
    title: "Holdings",
    links: [
      {
        href: "/firearms",
        label: "Firearms",
        hint: "guns · LTC · PICS",
        icon: Crosshair,
        keywords: "guns weapons permits background check",
      },
      {
        href: "/vehicles",
        label: "Vehicles",
        hint: "plates · licences",
        icon: Car,
        keywords: "cars registration vin driving movement parked kerb driver "
          + "passengers riders lift mileage",
      },
      {
        href: "/banking",
        label: "Banking",
        hint: "accounts · paydays · cards",
        icon: Banknote,
        keywords: "bank account balance deposit savings income stream payday "
          + "salary wages direct deposit cash unbanked credit debit card money "
          + "payments spend",
      },
      // Beside banking rather than beside the day file it is read out of: a
      // reader looking for money looks here. Banking is the position, this is
      // the flow across one date, and neither is much use without the other.
      {
        href: "/spending",
        label: "Spending",
        hint: "transactions · tickets",
        icon: Receipt,
        keywords: "money transactions payments purchases spend ledger charges "
          + "merchant mcc cash card till basket fare fuel groceries receipts "
          + "day",
      },
      {
        href: "/holdings",
        label: "Holdings",
        hint: "licences · loans · scripts",
        icon: Wallet,
        keywords: "licences property mortgages student loans credentials "
          + "prescriptions military",
      },
    ],
  },
];

/** Every destination, flattened — what the command palette lists. */
export const NAV_LINKS: NavLink[] = NAV.flatMap((section) =>
  section.links.map((link) => ({ ...link })),
);

/** The section a link belongs to, for palette grouping. */
export const SECTION_OF: Record<string, string> = Object.fromEntries(
  NAV.flatMap((section) => section.links.map((link) => [link.href, section.title])),
);

/**
 * Whether a rail entry is the page currently open.
 *
 * Links carry query strings — `/map?panel=analysis` is a different rail entry
 * from `/map` — so matching on pathname alone lit both, or neither. The query
 * has to agree as well, which means the caller passes the live search string.
 */
export function isCurrent(href: string, pathname: string, search: string): boolean {
  const [path, query] = href.split("?");
  // A page with children — a gathering under /meetings — still belongs to the
  // rail entry that leads to it, or a reader on the detail page loses their
  // place in the navigation.
  if (path !== pathname && !(path !== "/" && pathname.startsWith(`${path}/`))) return false;
  // Except where a longer entry claims the same page: /vehicles/movement is
  // its own destination, and lighting the register beside it would say the
  // reader is in two places at once.
  if (path !== pathname && NAV_LINKS.some((link) => {
    const other = link.href.split("?")[0];
    return other.length > path.length
      && (other === pathname || pathname.startsWith(`${other}/`));
  })) return false;
  if (!query) return !search;
  const wanted = new URLSearchParams(query);
  const actual = new URLSearchParams(search);
  for (const [key, value] of wanted) {
    if (actual.get(key) !== value) return false;
  }
  return true;
}
