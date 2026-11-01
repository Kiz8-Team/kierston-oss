/** Small conversions every generator ends up needing. */

/** Minutes after midnight, sim convention, to "HH:MM". Days may exceed 24h. */
export function clock(minute: number): string {
  const total = Math.max(0, Math.floor(minute));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Seconds after midnight to "HH:MM:SS". */
export function clockSeconds(second: number): string {
  const total = Math.max(0, Math.floor(second));
  const s = total % 60;
  return `${clock(Math.floor(total / 60))}:${String(s).padStart(2, "0")}`;
}

export const degrees = (e6: number): number => e6 / 1e6;

/** Great-circle metres. */
export function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
