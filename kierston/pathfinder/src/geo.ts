/** Spherical helpers shared by the builder, the snapper and the search. */

export const EARTH_RADIUS_METERS = 6_371_008.8;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLon = (bLon - aLon) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h = sinLat * sinLat
    + Math.cos(aLat * DEG_TO_RAD) * Math.cos(bLat * DEG_TO_RAD) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Metres per degree of latitude — constant enough at city scale to precompute. */
export const METERS_PER_DEGREE_LAT = (Math.PI / 180) * EARTH_RADIUS_METERS;

export function metersPerDegreeLon(lat: number): number {
  return METERS_PER_DEGREE_LAT * Math.cos(lat * DEG_TO_RAD);
}

export function bearingDegrees(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const phi1 = aLat * DEG_TO_RAD;
  const phi2 = bLat * DEG_TO_RAD;
  const dLon = (bLon - aLon) * DEG_TO_RAD;
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/** Signed turn in (-180, 180]: negative is a left turn, positive a right one. */
export function turnAngle(fromBearing: number, toBearing: number): number {
  let delta = (toBearing - fromBearing + 540) % 360 - 180;
  if (delta === -180) delta = 180;
  return delta;
}
