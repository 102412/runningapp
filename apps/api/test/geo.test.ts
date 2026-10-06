import { describe, expect, it } from 'vitest';
import {
  applyRoutePrivacy,
  boundingBox,
  decodePolyline,
  encodePolyline,
  haversine,
  pathLength,
  PolylineError,
  simplify,
  simplifyToMax,
  type LatLon,
  type PrivacyZone,
} from '../src/modules/activities/geo';

/** A straight east-west route at ~44N sampled every ~50 m. */
function straightRoute(km: number, startLon = -123.0): LatLon[] {
  const lat = 44.0;
  const stepDeg = 50 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const n = Math.round((km * 1000) / 50);
  return Array.from({ length: n + 1 }, (_, i) => [lat, startLon + i * stepDeg] as LatLon);
}

describe('polyline codec', () => {
  it('matches the documented Google example', () => {
    const pts: LatLon[] = [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ];
    expect(encodePolyline(pts)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(pts);
  });

  it('round-trips arbitrary tracks to 5-decimal precision', () => {
    const pts = straightRoute(3);
    const back = decodePolyline(encodePolyline(pts));
    expect(back).toHaveLength(pts.length);
    for (let i = 0; i < pts.length; i++) {
      expect(Math.abs((back[i] as LatLon)[0] - (pts[i] as LatLon)[0])).toBeLessThan(1e-5);
      expect(Math.abs((back[i] as LatLon)[1] - (pts[i] as LatLon)[1])).toBeLessThan(1e-5);
    }
  });

  it('rejects malformed input instead of producing garbage', () => {
    expect(() => decodePolyline('abc\u0001')).toThrow(PolylineError); // bad character
    expect(() => decodePolyline('_p~iF')).toThrow(PolylineError); // truncated pair
    expect(() => decodePolyline('~~~~~~~~~~~~~')).toThrow(PolylineError); // overflow
  });
});

describe('distance & simplification', () => {
  it('haversine is correct for a known pair', () => {
    expect(haversine([0, 0], [0, 1])).toBeGreaterThan(111_000);
    expect(haversine([0, 0], [0, 1])).toBeLessThan(111_400);
    expect(haversine([10, 10], [10, 10])).toBe(0);
  });

  it('simplify keeps endpoints and removes collinear points', () => {
    const route = straightRoute(2);
    const s = simplify(route, 2);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual(route[0]);
    expect(s[1]).toEqual(route[route.length - 1]);
  });

  it('simplifyToMax honours the cap even for noisy tracks', () => {
    const noisy: LatLon[] = Array.from({ length: 5000 }, (_, i) => [
      44 + Math.sin(i / 7) * 0.01,
      -123 + i * 0.0001,
    ]);
    expect(simplifyToMax(noisy, 200).length).toBeLessThanOrEqual(200);
    expect(simplifyToMax(noisy, 200)[0]).toEqual(noisy[0]);
  });

  it('handles 50k-point tracks without stack overflow', () => {
    const big: LatLon[] = Array.from({ length: 50_000 }, (_, i) => [
      44 + Math.sin(i / 50) * 0.005,
      -123 + i * 0.00002,
    ]);
    expect(() => simplify(big, 3)).not.toThrow();
  });
});

describe('applyRoutePrivacy', () => {
  const route = straightRoute(5);
  const start = route[0] as LatLon;
  const end = route[route.length - 1] as LatLon;
  const flat = (segs: LatLon[][] | null): LatLon[] => (segs ?? []).flat();

  it('HIDDEN reveals nothing', () => {
    expect(
      applyRoutePrivacy({ points: route, mode: 'HIDDEN', trimMeters: 200, zones: [] }),
    ).toBeNull();
  });

  it('FULL keeps every point when there are no zones', () => {
    const out = applyRoutePrivacy({ points: route, mode: 'FULL', trimMeters: 200, zones: [] });
    expect(out).toHaveLength(1);
    expect(out?.[0]).toHaveLength(route.length);
  });

  it('TRIMMED hides everything within the trim radius of the start AND end', () => {
    const out = applyRoutePrivacy({ points: route, mode: 'TRIMMED', trimMeters: 300, zones: [] });
    expect(out).not.toBeNull();
    for (const p of flat(out)) {
      expect(haversine(p, start)).toBeGreaterThan(299);
      expect(haversine(p, end)).toBeGreaterThan(299);
    }
    expect(flat(out).length).toBeLessThan(route.length);
  });

  it('TRIMMED also hides a mid-route pass back through the start (loop that revisits home)', () => {
    const out1 = straightRoute(2);
    const back = [...out1].reverse();
    const loopThroughHome = [...out1, ...back, ...out1, ...back]; // passes the start region repeatedly
    const s = loopThroughHome[0] as LatLon;
    const out = applyRoutePrivacy({
      points: loopThroughHome,
      mode: 'TRIMMED',
      trimMeters: 300,
      zones: [],
    });
    for (const p of flat(out)) expect(haversine(p, s)).toBeGreaterThan(299);
  });

  it('a route shorter than twice the trim radius disappears entirely', () => {
    const tiny = straightRoute(0.4);
    expect(
      applyRoutePrivacy({ points: tiny, mode: 'TRIMMED', trimMeters: 250, zones: [] }),
    ).toBeNull();
  });

  it('privacy zones split the route and never bridge the gap', () => {
    const mid = route[Math.floor(route.length / 2)] as LatLon;
    const zone: PrivacyZone = { lat: mid[0], lon: mid[1], radiusM: 400 };
    const out = applyRoutePrivacy({ points: route, mode: 'FULL', trimMeters: 0, zones: [zone] });
    expect(out).toHaveLength(2);
    for (const p of flat(out)) expect(haversine(p, [zone.lat, zone.lon])).toBeGreaterThan(399);
    const firstSegment = out?.[0] ?? [];
    const gapStart = firstSegment[firstSegment.length - 1] as LatLon;
    const gapEnd = (out?.[1] as LatLon[])[0] as LatLon;
    expect(haversine(gapStart, gapEnd)).toBeGreaterThan(700); // a real gap, not a straight line across it
  });

  it('a long chord between two visible points never cuts through a zone (sparse GPS track)', () => {
    // Two points ~4 km apart with the zone centred on the straight line between them.
    const a: LatLon = [44.0, -123.0];
    const b: LatLon = [44.0, -122.95];
    const centre: LatLon = [44.0, -122.975];
    const sparse: LatLon[] = [a, [44.0, -122.99], b]; // chord from -122.99 to -122.95 crosses the centre
    const out = applyRoutePrivacy({
      points: sparse,
      mode: 'FULL',
      trimMeters: 0,
      zones: [{ lat: centre[0], lon: centre[1], radiusM: 200 }],
    });
    // Nothing may connect across the zone: any returned segment must stay clear of it.
    for (const seg of out ?? []) {
      for (let i = 1; i < seg.length; i++) {
        const p = seg[i - 1] as LatLon;
        const q = seg[i] as LatLon;
        const midpoints = [0, 0.25, 0.5, 0.75, 1].map(
          (t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t] as LatLon,
        );
        for (const m of midpoints) expect(haversine(m, centre)).toBeGreaterThan(199);
      }
    }
  });

  it('zones apply even in FULL mode and when the zone covers the start', () => {
    const out = applyRoutePrivacy({
      points: route,
      mode: 'FULL',
      trimMeters: 0,
      zones: [{ lat: start[0], lon: start[1], radiusM: 500 }],
    });
    for (const p of flat(out)) expect(haversine(p, start)).toBeGreaterThan(499);
  });

  it('APPROXIMATE coarsens coordinates to 3 decimals', () => {
    const out = applyRoutePrivacy({
      points: route,
      mode: 'APPROXIMATE',
      trimMeters: 100,
      zones: [],
    });
    for (const [la, lo] of flat(out)) {
      expect(Math.abs(la * 1000 - Math.round(la * 1000))).toBeLessThan(1e-6);
      expect(Math.abs(lo * 1000 - Math.round(lo * 1000))).toBeLessThan(1e-6);
    }
  });

  it('property: for random zones and modes, no visible point is ever inside a zone or trim circle', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let trial = 0; trial < 60; trial++) {
      const pts = straightRoute(2 + rnd() * 6, -123 + rnd() * 0.1);
      const zones: PrivacyZone[] = Array.from({ length: Math.floor(rnd() * 4) }, () => {
        const c = pts[Math.floor(rnd() * pts.length)] as LatLon;
        return { lat: c[0], lon: c[1], radiusM: 50 + Math.floor(rnd() * 600) };
      });
      const mode = (['FULL', 'TRIMMED', 'APPROXIMATE'] as const)[Math.floor(rnd() * 3)] as
        'FULL' | 'TRIMMED' | 'APPROXIMATE';
      const trim = Math.floor(rnd() * 500);
      const out = applyRoutePrivacy({ points: pts, mode, trimMeters: trim, zones });
      for (const p of flat(out)) {
        for (const z of zones)
          expect(haversine(p, [z.lat, z.lon])).toBeGreaterThan(z.radiusM * 0.995);
        if (mode !== 'FULL') {
          expect(haversine(p, pts[0] as LatLon)).toBeGreaterThan(trim * 0.995);
          expect(haversine(p, pts[pts.length - 1] as LatLon)).toBeGreaterThan(trim * 0.995);
        }
      }
    }
  });

  it('bounding box is computed from what is shown, not the raw route', () => {
    const out = applyRoutePrivacy({ points: route, mode: 'TRIMMED', trimMeters: 500, zones: [] });
    const box = boundingBox(out ?? []);
    expect(box?.minLon).toBeGreaterThan(start[1]);
    expect(box?.maxLon).toBeLessThan(end[1]);
    expect(pathLength(route)).toBeGreaterThan(4900);
  });
});
