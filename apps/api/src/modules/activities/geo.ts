/**
 * Geometry helpers and the route-privacy transform.
 *
 * Points are [latitude, longitude] in degrees. Everything here is pure (no I/O) so the privacy
 * guarantees can be tested exhaustively.
 */
export type LatLon = readonly [number, number];

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Fast flat-earth distance; accurate to well under 1% for the sub-5 km radii used by zones. */
function flatDistance(a: LatLon, b: LatLon): number {
  const dy = toRad(b[0] - a[0]) * EARTH_RADIUS_M;
  const dx = toRad(b[1] - a[1]) * Math.cos(toRad((a[0] + b[0]) / 2)) * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

export function pathLength(points: readonly LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += haversine(points[i - 1] as LatLon, points[i] as LatLon);
  return total;
}

// ------------------------------------------------------------------ encoded polyline (Google, precision 5)

const MAX_POLYLINE_POINTS = 50_000;

export class PolylineError extends Error {}

export function encodePolyline(points: readonly LatLon[], precision = 5): string {
  const factor = 10 ** precision;
  let lastLat = 0;
  let lastLon = 0;
  let out = '';
  const encodeValue = (value: number): string => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    let chunk = '';
    while (v >= 0x20) {
      chunk += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return chunk + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const iLat = Math.round(lat * factor);
    const iLon = Math.round(lon * factor);
    out += encodeValue(iLat - lastLat) + encodeValue(iLon - lastLon);
    lastLat = iLat;
    lastLon = iLon;
  }
  return out;
}

/** Strict decoder: rejects out-of-range characters, truncated input, and invalid coordinates. */
export function decodePolyline(encoded: string, precision = 5): LatLon[] {
  const factor = 10 ** precision;
  const points: LatLon[] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  const readValue = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (index >= encoded.length) throw new PolylineError('Truncated polyline');
      const code = encoded.charCodeAt(index++);
      if (code < 63 || code > 126) throw new PolylineError('Invalid polyline character');
      const b = code - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
      if (shift > 30) throw new PolylineError('Polyline value overflow');
    }
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += readValue();
    lon += readValue();
    const point: LatLon = [lat / factor, lon / factor];
    if (Math.abs(point[0]) > 90 || Math.abs(point[1]) > 180)
      throw new PolylineError('Coordinate out of range');
    points.push(point);
    if (points.length > MAX_POLYLINE_POINTS) throw new PolylineError('Too many points');
  }
  return points;
}

// ------------------------------------------------------------------ simplification

/** Iterative Ramer-Douglas-Peucker (no recursion, so 50k-point tracks cannot overflow the stack). */
export function simplify(points: readonly LatLon[], toleranceM: number): LatLon[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    let maxDist = 0;
    let maxIdx = -1;
    const a = points[start] as LatLon;
    const b = points[end] as LatLon;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistance(points[i] as LatLon, a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxIdx !== -1 && maxDist > toleranceM) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx], [maxIdx, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

function perpendicularDistance(p: LatLon, a: LatLon, b: LatLon): number {
  const cosLat = Math.cos(toRad(a[0]));
  const toXY = (q: LatLon): [number, number] => [
    toRad(q[1]) * cosLat * EARTH_RADIUS_M,
    toRad(q[0]) * EARTH_RADIUS_M,
  ];
  const [px, py] = toXY(p);
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Simplifies with growing tolerance until at most `maxPoints` remain. */
export function simplifyToMax(points: readonly LatLon[], maxPoints: number): LatLon[] {
  if (points.length <= maxPoints) return [...points];
  let tolerance = 1;
  let result = simplify(points, tolerance);
  while (result.length > maxPoints && tolerance < 100_000) {
    tolerance *= 1.7;
    result = simplify(points, tolerance);
  }
  if (result.length > maxPoints) {
    const step = Math.ceil(result.length / maxPoints);
    result = result.filter((_, i) => i % step === 0 || i === result.length - 1);
  }
  return result;
}

// ------------------------------------------------------------------ route privacy

export interface PrivacyZone {
  lat: number;
  lon: number;
  radiusM: number;
}

type RoutePrivacyMode = 'FULL' | 'TRIMMED' | 'APPROXIMATE' | 'HIDDEN';

export interface RoutePrivacyInput {
  points: readonly LatLon[];
  mode: RoutePrivacyMode;
  /** Radius (metres) of the exclusion circles placed at the start and end for TRIMMED/APPROXIMATE. */
  trimMeters: number;
  zones: readonly PrivacyZone[];
}

/** Coordinate precision for APPROXIMATE (3 decimals ~ 110 m). */
const APPROXIMATE_DECIMALS = 3;

/**
 * The ONLY function that decides what part of a GPS track a non-owner may see.
 *
 *  - HIDDEN: nothing.
 *  - TRIMMED / APPROXIMATE: every point within `trimMeters` of the start or the end is removed
 *    (a circle, not just "the first N metres of path", so a route that loops back past the start
 *    or end mid-activity is hidden there too).
 *  - ALL modes except HIDDEN: points inside any of the owner's privacy zones are removed.
 *  - Removing points splits the route into segments; gaps are never bridged by a straight line.
 *  - APPROXIMATE additionally coarsens coordinates.
 * Returns null when nothing visible remains.
 */
export function applyRoutePrivacy(input: RoutePrivacyInput): LatLon[][] | null {
  const { points, mode, trimMeters, zones } = input;
  if (mode === 'HIDDEN' || points.length < 2) return null;

  const exclusions: PrivacyZone[] = zones.map((z) => ({ ...z }));
  if (mode === 'TRIMMED' || mode === 'APPROXIMATE') {
    const start = points[0] as LatLon;
    const end = points[points.length - 1] as LatLon;
    exclusions.push({ lat: start[0], lon: start[1], radiusM: trimMeters });
    exclusions.push({ lat: end[0], lon: end[1], radiusM: trimMeters });
  }

  // Coarsen FIRST so the exclusion test runs on exactly the coordinates that would be served;
  // otherwise a rounded point could land inside a zone its original position was outside of.
  const working: readonly LatLon[] =
    mode === 'APPROXIMATE'
      ? points.map(
          ([la, lo]) =>
            [round(la, APPROXIMATE_DECIMALS), round(lo, APPROXIMATE_DECIMALS)] as LatLon,
        )
      : points;

  const segments: LatLon[][] = [];
  let current: LatLon[] = [];
  for (const p of working) {
    const hidden = exclusions.some((z) => flatDistance(p, [z.lat, z.lon]) <= z.radiusM);
    if (hidden) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    const prev = current[current.length - 1];
    // Vertices alone are not enough: on a sparse track the straight chord between two visible
    // vertices can cut straight through an exclusion circle. Break the route there as well.
    if (prev && exclusions.some((z) => segmentTouchesCircle(prev, p, z))) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length > 0) segments.push(current);

  const visible = (mode === 'APPROXIMATE' ? segments.map(dedupe) : segments).filter(
    (seg) => seg.length >= 2,
  );
  return visible.length > 0 ? visible : null;
}

/** True when the straight segment a-b comes within `zone.radiusM` of the zone centre. */
function segmentTouchesCircle(a: LatLon, b: LatLon, zone: PrivacyZone): boolean {
  const cosLat = Math.cos(toRad(zone.lat));
  const toXY = (p: LatLon): [number, number] => [
    toRad(p[1] - zone.lon) * cosLat * EARTH_RADIUS_M,
    toRad(p[0] - zone.lat) * EARTH_RADIUS_M,
  ];
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
  return Math.hypot(ax + t * dx, ay + t * dy) <= zone.radiusM;
}

const round = (v: number, decimals: number): number =>
  Math.round(v * 10 ** decimals) / 10 ** decimals;

function dedupe(points: LatLon[]): LatLon[] {
  return points.filter(
    (p, i) =>
      i === 0 || p[0] !== (points[i - 1] as LatLon)[0] || p[1] !== (points[i - 1] as LatLon)[1],
  );
}

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export function boundingBox(segments: readonly (readonly LatLon[])[]): Bbox | null {
  let box: Bbox | null = null;
  for (const seg of segments) {
    for (const [lat, lon] of seg) {
      box = box
        ? {
            minLat: Math.min(box.minLat, lat),
            minLon: Math.min(box.minLon, lon),
            maxLat: Math.max(box.maxLat, lat),
            maxLon: Math.max(box.maxLon, lon),
          }
        : { minLat: lat, minLon: lon, maxLat: lat, maxLon: lon };
    }
  }
  return box;
}
