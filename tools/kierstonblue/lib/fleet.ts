export type FleetKind = "district" | "contractor" | "taxi" | "police";

export interface FleetOperator {
  id: number;
  name: string;
  kind: FleetKind;
  legal_form: string;
  depot: { site: string; lat: number; lon: number; evidence: string };
}

export interface FleetVehicle {
  vin: string;
  service_class: "taxi" | "school_bus" | "police";
  operator: number | null;
  owner_driver: number | null;
  /** The premises the vehicle is kept at. Police only; see fleet.py. */
  base?: string | null;
}

export interface FleetDriver {
  person: number;
  operator: number | null;
  vehicle: string | null;
}

export interface FleetFile {
  source: string;
  seed: number;
  reference_year: number;
  operators: FleetOperator[];
  vehicles: FleetVehicle[];
  drivers: FleetDriver[];
}

export class Fleets {
  readonly operators: FleetOperator[];
  readonly operatorById: Map<number, FleetOperator>;
  readonly vehicles: FleetVehicle[];
  readonly driverById: Map<number, FleetDriver>;

  constructor(file: FleetFile) {
    this.operators = file.operators;
    this.operatorById = new Map(file.operators.map((row) => [row.id, row]));
    this.vehicles = file.vehicles;
    this.driverById = new Map(file.drivers.map((row) => [row.person, row]));
  }
}
