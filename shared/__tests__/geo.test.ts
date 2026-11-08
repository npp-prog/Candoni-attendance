import { describe, expect, it } from 'vitest';
import { evaluateGeofences, haversineMeters, isValidLatLng } from '../geo';

// Reference point: Manila City Hall area.
const BASE = { lat: 14.5896, lng: 120.9811 };
/** Offset north by `m` meters (1 deg latitude ≈ 111,195 m on the sphere used). */
const north = (m: number) => ({ lat: BASE.lat + m / 111_194.93, lng: BASE.lng });

describe('haversineMeters', () => {
  it('is zero for identical points', () => {
    expect(haversineMeters(BASE.lat, BASE.lng, BASE.lat, BASE.lng)).toBe(0);
  });
  it('matches a known long distance (Manila → Cebu ≈ 571 km)', () => {
    const d = haversineMeters(14.5995, 120.9842, 10.3157, 123.8854);
    expect(d / 1000).toBeGreaterThan(560);
    expect(d / 1000).toBeLessThan(580);
  });
  it('measures short north offsets accurately', () => {
    const p = north(100);
    expect(haversineMeters(BASE.lat, BASE.lng, p.lat, p.lng)).toBeCloseTo(100, 1);
  });
  it('is symmetric', () => {
    const p = north(250);
    expect(haversineMeters(BASE.lat, BASE.lng, p.lat, p.lng)).toBeCloseTo(haversineMeters(p.lat, p.lng, BASE.lat, BASE.lng), 9);
  });
});

describe('evaluateGeofences', () => {
  const office = { id: 'w1', name: 'Main Office', lat: BASE.lat, lng: BASE.lng, radiusMeters: 100 };
  it('accepts a point inside the radius', () => {
    const p = north(40);
    const r = evaluateGeofences(p.lat, p.lng, [office]);
    expect(r.match?.target.id).toBe('w1');
    expect(r.match?.distanceMeters).toBeCloseTo(40, 0);
  });
  it('rejects a point outside the radius', () => {
    const p = north(150);
    const r = evaluateGeofences(p.lat, p.lng, [office]);
    expect(r.match).toBeNull();
    expect(r.nearest?.distanceMeters).toBeCloseTo(150, 0);
  });
  it('handles the boundary: just inside accepted, just outside rejected', () => {
    const inside = north(99.5);
    const outside = north(100.5);
    expect(evaluateGeofences(inside.lat, inside.lng, [office]).match).not.toBeNull();
    expect(evaluateGeofences(outside.lat, outside.lng, [office]).match).toBeNull();
  });
  it('picks the nearest matching workplace among several', () => {
    const annex = { id: 'w2', name: 'Annex', lat: north(120).lat, lng: BASE.lng, radiusMeters: 100 };
    const p = north(90);
    const r = evaluateGeofences(p.lat, p.lng, [office, annex]);
    expect(r.match?.target.id).toBe('w2');
  });
  it('returns no match when there are no workplaces', () => {
    expect(evaluateGeofences(BASE.lat, BASE.lng, [])).toEqual({ nearest: null, match: null });
  });
});

describe('isValidLatLng', () => {
  it('validates ranges and types', () => {
    expect(isValidLatLng(14.5, 121)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, -181)).toBe(false);
    expect(isValidLatLng(NaN, 0)).toBe(false);
    expect(isValidLatLng('14', 121)).toBe(false);
  });
});
