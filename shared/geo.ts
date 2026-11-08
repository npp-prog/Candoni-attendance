/**
 * Geofence helpers. Distances use the Haversine great-circle formula on a
 * spherical Earth (mean radius 6,371,008.8 m). Over the short distances used by
 * workplace geofences (meters to a few kilometers) the error versus the WGS-84
 * ellipsoid is well under 0.5%, which is far smaller than phone GPS error.
 */

export const EARTH_RADIUS_METERS = 6_371_008.8;

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

export interface GeofenceTarget {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radiusMeters: number;
}

export interface GeofenceMatch {
  target: GeofenceTarget;
  distanceMeters: number;
  inside: boolean;
}

/**
 * Finds the nearest geofence and whether the point is inside it.
 * The reported accuracy is deliberately NOT added to the radius: a poor reading
 * must be retried, not rewarded with a larger fence. Points exactly on the
 * boundary (distance === radius) count as inside.
 */
export function evaluateGeofences(
  lat: number,
  lng: number,
  targets: GeofenceTarget[],
): { nearest: GeofenceMatch | null; match: GeofenceMatch | null } {
  let nearest: GeofenceMatch | null = null;
  let match: GeofenceMatch | null = null;
  for (const target of targets) {
    const distanceMeters = haversineMeters(lat, lng, target.lat, target.lng);
    const inside = distanceMeters <= target.radiusMeters;
    const m = { target, distanceMeters, inside };
    if (!nearest || distanceMeters < nearest.distanceMeters) nearest = m;
    if (inside && (!match || distanceMeters < match.distanceMeters)) match = m;
  }
  return { nearest, match };
}

export function mapLinks(lat: number, lng: number) {
  return {
    openStreetMap: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=18/${lat}/${lng}`,
    googleMaps: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
    osmEmbed: (radiusMeters: number) => {
      const dLat = Math.max(radiusMeters * 3, 150) / 111_320;
      const dLng = dLat / Math.max(Math.cos(toRad(lat)), 0.01);
      const bbox = [lng - dLng, lat - dLat, lng + dLng, lat + dLat].map((n) => n.toFixed(6)).join(',');
      return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${lat},${lng}`;
    },
  };
}
