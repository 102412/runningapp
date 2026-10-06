import { encodePolyline, type LatLon } from '../../src/modules/activities/geo';

/** A straight eastward track near Eugene, OR sampled every ~50 m. */
export function eastwardRoute(km: number, startLon = -123.07): LatLon[] {
  const lat = 44.05;
  const stepDeg = 50 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const n = Math.round((km * 1000) / 50);
  return Array.from({ length: n + 1 }, (_, i) => [lat, startLon + i * stepDeg] as LatLon);
}

export const polylineOf = (points: LatLon[]): string => encodePolyline(points);

export interface GpxOptions {
  points: LatLon[];
  start?: Date;
  speedMps?: number;
  hr?: number;
  withTime?: boolean;
  name?: string;
  type?: string;
}

/** Builds a GPX 1.1 file with 1 point per `secondsBetween`, optional HR extension and elevation. */
export function makeGpx(o: GpxOptions): string {
  const start = o.start ?? new Date('2026-03-01T07:00:00Z');
  const speed = o.speedMps ?? 3;
  let t = start.getTime();
  const pts: string[] = [];
  o.points.forEach(([lat, lon], i) => {
    if (i > 0) {
      const [pl, po] = o.points[i - 1] as LatLon;
      const meters = Math.hypot(
        (lat - pl) * 111_320,
        (lon - po) * 111_320 * Math.cos((lat * Math.PI) / 180),
      );
      t += (meters / speed) * 1000;
    }
    const ele = 100 + Math.sin(i / 5) * 8;
    pts.push(
      `<trkpt lat="${lat}" lon="${lon}"><ele>${ele.toFixed(1)}</ele>${o.withTime === false ? '' : `<time>${new Date(t).toISOString()}</time>`}${
        o.hr
          ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${o.hr + (i % 7)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`
          : ''
      }</trkpt>`,
    );
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
<metadata><name>${o.name ?? 'Test run'}</name></metadata>
<trk><name>${o.name ?? 'Test run'}</name>${o.type ? `<type>${o.type}</type>` : ''}<trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}
