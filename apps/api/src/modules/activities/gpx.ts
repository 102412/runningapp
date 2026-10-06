import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { SportKey } from '@runningapp/contracts';
import { haversine, type LatLon } from './geo';

/**
 * GPX 1.0/1.1 import: turns a track into the same metrics a manually logged activity has.
 * Security: DOCTYPE/ENTITY declarations are refused outright (XXE / entity-expansion bombs),
 * entity processing is off, and the point count is bounded.
 */

export class GpxError extends Error {}

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | undefined;
  time: number | undefined; // epoch ms
  hr: number | undefined;
}

export interface ImportedActivity {
  externalId: string;
  title: string | undefined;
  sport: SportKey | undefined;
  startedAt: Date;
  elapsedTimeS: number;
  movingTimeS: number;
  distanceM: number;
  elevationGainM: number | undefined;
  elevationLossM: number | undefined;
  maxSpeedMps: number;
  avgHeartRateBpm: number | undefined;
  maxHeartRateBpm: number | undefined;
  splits: Array<{
    index: number;
    distanceM: number;
    elapsedTimeS: number;
    elevationDiffM: number | undefined;
  }>;
  /** Route for storage, thinned to <= MAX_ROUTE_POINTS. */
  route: LatLon[];
}

const MAX_RAW_POINTS = 400_000;
const MAX_ROUTE_POINTS = 50_000;
const MOVING_SPEED_MPS = 0.5;
const GLITCH_SPEED_MPS = 100;
const ELEVATION_HYSTERESIS_M = 3;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === 'trk' || name === 'trkseg' || name === 'trkpt',
});

type Node = Record<string, unknown>;
const asNode = (v: unknown): Node | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Node) : undefined;
const asString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

function unescapeXml(s: string): string {
  return s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

const SPORT_HINTS: Array<[RegExp, SportKey]> = [
  [/trail.?run|running|^run$|^9$/i, 'running'],
  [/cycl|bik|ride|^1$/i, 'cycling'],
  [/hik/i, 'hiking'],
  [/walk/i, 'walking'],
  [/swim/i, 'swimming'],
  [/row/i, 'rowing'],
];

function sportFromType(type: string | undefined): SportKey | undefined {
  if (!type) return undefined;
  return SPORT_HINTS.find(([re]) => re.test(type))?.[1];
}

export function parseGpx(xml: string): ImportedActivity {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new GpxError('DOCTYPE and ENTITY declarations are not allowed.');
  let doc: Node;
  try {
    const parsed = asNode(parser.parse(xml));
    if (!parsed) throw new GpxError('Not an XML document.');
    doc = parsed;
  } catch (err) {
    if (err instanceof GpxError) throw err;
    throw new GpxError('Could not parse the file as XML.');
  }
  const gpx = asNode(doc.gpx);
  if (!gpx) throw new GpxError('Not a GPX file (missing <gpx> root).');

  const tracks = asArray(gpx.trk)
    .map(asNode)
    .filter((t): t is Node => t !== undefined);
  const raw: TrackPoint[] = [];
  for (const trk of tracks) {
    for (const seg of asArray(trk.trkseg).map(asNode)) {
      if (!seg) continue;
      for (const pt of asArray(seg.trkpt).map(asNode)) {
        if (!pt) continue;
        const lat = Number(pt['@_lat']);
        const lon = Number(pt['@_lon']);
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        ) {
          throw new GpxError('A track point has an invalid latitude/longitude.');
        }
        const ele = Number(asString(pt.ele));
        const timeStr = asString(pt.time);
        const time = timeStr ? Date.parse(timeStr) : Number.NaN;
        const ext = asNode(pt.extensions);
        const tpx = ext ? asNode(ext.TrackPointExtension) : undefined;
        const hr = tpx ? Number(asString(tpx.hr)) : Number.NaN;
        raw.push({
          lat,
          lon,
          ele: Number.isFinite(ele) ? ele : undefined,
          time: Number.isFinite(time) ? time : undefined,
          hr: Number.isFinite(hr) && hr >= 20 && hr <= 260 ? hr : undefined,
        });
        if (raw.length > MAX_RAW_POINTS) throw new GpxError('The track has too many points.');
      }
    }
  }
  if (raw.length < 2)
    throw new GpxError('The file contains no usable track (need at least 2 points).');
  if (raw.some((p) => p.time === undefined))
    throw new GpxError('Every track point needs a <time> to compute duration and pace.');

  const first = raw[0] as TrackPoint;
  const last = raw[raw.length - 1] as TrackPoint;
  const startMs = first.time as number;
  const elapsedS = Math.round(((last.time as number) - startMs) / 1000);
  if (elapsedS <= 0) throw new GpxError('Track timestamps must increase.');

  // ---- distance, moving time, speed, splits ---------------------------------------------------
  let distance = 0;
  let moving = 0;
  let maxSpeed = 0;
  let hrWeighted = 0;
  let hrTime = 0;
  let hrMax = 0;
  let splitStartDist = 0;
  let splitStartTime = startMs;
  let splitStartEle = first.ele;
  const splits: ImportedActivity['splits'] = [];

  for (let i = 1; i < raw.length; i++) {
    const a = raw[i - 1] as TrackPoint;
    const b = raw[i] as TrackPoint;
    const dt = ((b.time as number) - (a.time as number)) / 1000;
    if (dt <= 0) continue;
    const d = haversine([a.lat, a.lon], [b.lat, b.lon]);
    const speed = d / dt;
    if (speed > GLITCH_SPEED_MPS) continue; // GPS teleport: ignore the segment
    const before = distance;
    distance += d;
    if (speed >= MOVING_SPEED_MPS) moving += dt;
    if (speed > maxSpeed && dt <= 30) maxSpeed = speed;
    if (b.hr !== undefined) {
      hrWeighted += b.hr * dt;
      hrTime += dt;
      hrMax = Math.max(hrMax, b.hr);
    }
    // Emit a split for EVERY kilometre boundary crossed within this segment (a sparse track can
    // cross several), interpolating the crossing time and elevation linearly along the segment.
    let boundary = (Math.floor(before / 1000) + 1) * 1000;
    while (boundary <= distance && d > 0) {
      const frac = (boundary - before) / d;
      const tBoundary = (a.time as number) + frac * ((b.time as number) - (a.time as number));
      const eleAt =
        a.ele !== undefined && b.ele !== undefined ? a.ele + frac * (b.ele - a.ele) : undefined;
      splits.push({
        index: splits.length,
        distanceM: boundary - splitStartDist,
        elapsedTimeS: Math.round((tBoundary - splitStartTime) / 1000),
        elevationDiffM:
          eleAt !== undefined && splitStartEle !== undefined ? eleAt - splitStartEle : undefined,
      });
      splitStartDist = boundary;
      splitStartTime = tBoundary;
      splitStartEle = eleAt;
      boundary += 1000;
    }
  }
  if (distance - splitStartDist > 50) {
    splits.push({
      index: splits.length,
      distanceM: distance - splitStartDist,
      elapsedTimeS: Math.round(((last.time as number) - splitStartTime) / 1000),
      elevationDiffM:
        last.ele !== undefined && splitStartEle !== undefined
          ? last.ele - splitStartEle
          : undefined,
    });
  }

  // ---- elevation (3-point smoothing + hysteresis against GPS noise) ---------------------------
  const elevations = raw.map((p) => p.ele);
  let gain: number | undefined;
  let loss: number | undefined;
  if (elevations.every((e) => e !== undefined)) {
    const e = elevations;
    const smooth = e.map(
      (_, i) =>
        ((e[Math.max(0, i - 1)] as number) +
          (e[i] as number) +
          (e[Math.min(e.length - 1, i + 1)] as number)) /
        3,
    );
    let baseline = smooth[0] as number;
    gain = 0;
    loss = 0;
    for (const v of smooth) {
      if (v - baseline > ELEVATION_HYSTERESIS_M) {
        gain += v - baseline;
        baseline = v;
      } else if (baseline - v > ELEVATION_HYSTERESIS_M) {
        loss += baseline - v;
        baseline = v;
      }
    }
  }

  // ---- route (thinned if enormous) -----------------------------------------------------------
  const step = Math.ceil(raw.length / MAX_ROUTE_POINTS);
  const route: LatLon[] = raw
    .filter((_, i) => i % step === 0 || i === raw.length - 1)
    .map((p) => [p.lat, p.lon]);

  const name = asString(asNode(gpx.metadata)?.name) ?? asString(tracks[0]?.name);
  return {
    externalId: `gpx:${createHash('sha256').update(xml).digest('hex').slice(0, 40)}`,
    title: name ? unescapeXml(name).slice(0, 100) : undefined,
    sport: sportFromType(asString(tracks[0]?.type)),
    startedAt: new Date(startMs),
    elapsedTimeS: elapsedS,
    movingTimeS: Math.min(elapsedS, Math.round(moving)),
    distanceM: Math.round(distance * 10) / 10,
    elevationGainM: gain === undefined ? undefined : Math.round(gain * 10) / 10,
    elevationLossM: loss === undefined ? undefined : Math.round(loss * 10) / 10,
    maxSpeedMps: Math.round(Math.min(maxSpeed, 120) * 100) / 100,
    avgHeartRateBpm: hrTime > 0 ? Math.round(hrWeighted / hrTime) : undefined,
    maxHeartRateBpm: hrMax > 0 ? hrMax : undefined,
    splits,
    route,
  };
}
