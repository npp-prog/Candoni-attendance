/**
 * One-shot, high-accuracy location capture for an attendance action.
 * There is deliberately no watchPosition and no background tracking.
 */
export type GeoErrorKind = 'unsupported' | 'insecure' | 'denied' | 'unavailable' | 'timeout';

export class GeoError extends Error {
  constructor(public kind: GeoErrorKind) {
    super(kind);
  }
}

export interface Reading {
  lat: number;
  lng: number;
  accuracy: number;
  capturedAt: number;
}

export function geolocationSupport(): 'ok' | 'unsupported' | 'insecure' {
  if (typeof window !== 'undefined' && !window.isSecureContext) return 'insecure';
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return 'unsupported';
  return 'ok';
}

/** 'granted' | 'denied' | 'prompt' | 'unknown' (Safari may not support the query). */
export async function permissionState(): Promise<PermissionState | 'unknown'> {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const s = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
    return s.state;
  } catch {
    return 'unknown';
  }
}

export function getFreshPosition(timeoutMs = 20_000): Promise<Reading> {
  const support = geolocationSupport();
  if (support !== 'ok') return Promise.reject(new GeoError(support));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          // Some browsers report 0/odd timestamps; fall back to "now" on the same device clock.
          capturedAt: pos.timestamp && pos.timestamp > 1e12 ? pos.timestamp : Date.now(),
        }),
      (err) => {
        if (err.code === err.PERMISSION_DENIED) reject(new GeoError('denied'));
        else if (err.code === err.TIMEOUT) reject(new GeoError('timeout'));
        else reject(new GeoError('unavailable'));
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: timeoutMs },
    );
  });
}

export type Platform = 'ios' | 'android' | 'other';
export function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
}

export const GEO_HELP: Record<GeoErrorKind, { title: string; steps: Record<Platform, string[]> }> = {
  denied: {
    title: 'Location permission is blocked',
    steps: {
      ios: [
        'Open Settings → Privacy & Security → Location Services and make sure it is On.',
        'In Settings → Safari → Location (or Settings → Apps → Safari), choose “Ask” or “Allow”.',
        'Return here, reload the page, and tap Retry. Choose “Allow” when asked.',
      ],
      android: [
        'Tap the icon to the left of the address bar → Permissions → Location → Allow.',
        'Or open Chrome menu ⋮ → Settings → Site settings → Location and allow this site.',
        'Return here and tap Retry.',
      ],
      other: ['Allow location access for this site in your browser’s site settings, then tap Retry.'],
    },
  },
  unavailable: {
    title: 'Your location could not be determined',
    steps: {
      ios: ['Make sure Location Services is On (Settings → Privacy & Security).', 'Move near a window or outdoors and tap Retry.'],
      android: ['Turn on Location from the quick settings panel (swipe down from the top).', 'Turn on “Google Location Accuracy” if available.', 'Move near a window or outdoors and tap Retry.'],
      other: ['Turn on your device’s location services and tap Retry.'],
    },
  },
  timeout: {
    title: 'Getting your location took too long',
    steps: {
      ios: ['Move near a window or outdoors, wait a few seconds, and tap Retry.'],
      android: ['Move near a window or outdoors, check that Location is on, and tap Retry.'],
      other: ['Move to an area with better signal and tap Retry.'],
    },
  },
  unsupported: {
    title: 'This browser cannot share location',
    steps: {
      ios: ['Open this page in Safari (iOS 14 or later).'],
      android: ['Open this page in an up-to-date Google Chrome.'],
      other: ['Use an up-to-date Chrome, Safari, Edge or Firefox browser.'],
    },
  },
  insecure: {
    title: 'A secure connection is required',
    steps: {
      ios: ['Open the app using its https:// address.'],
      android: ['Open the app using its https:// address.'],
      other: ['Open the app using its https:// address.'],
    },
  },
};
