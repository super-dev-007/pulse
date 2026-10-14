// Where it's day and night right now, and what time it is "there" — so the
// globe can show the night side and each stranger's local moment.

const RAD = Math.PI / 180;
const J2000 = Date.UTC(2000, 0, 1, 12);

// Point on Earth where the sun is directly overhead (low-precision solar
// ephemeris — well under a degree, plenty for a map shadow).
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const d = (date.getTime() - J2000) / 86_400_000; // days since J2000
  const g = (357.529 + 0.98560028 * d) * RAD; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude, degrees
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD; // obliquity of the ecliptic
  const declination = Math.asin(Math.sin(e) * Math.sin(L));
  const rightAscension = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const gmst = (280.46061837 + 360.98564736629 * d) % 360; // sidereal time
  const lng = ((((rightAscension / RAD - gmst + 540) % 360) + 360) % 360) - 180;
  return { lat: declination / RAD, lng };
}

// Sun elevation above the horizon at a point, in degrees (< 0 → night).
export function sunElevation(lat: number, lng: number, date: Date): number {
  const sun = subsolarPoint(date);
  const h = (lng - sun.lng) * RAD;
  const s =
    Math.sin(lat * RAD) * Math.sin(sun.lat * RAD) +
    Math.cos(lat * RAD) * Math.cos(sun.lat * RAD) * Math.cos(h);
  return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

// Polygon covering the night side of the planet.
export function nightPolygon(date: Date): GeoJSON.Feature<GeoJSON.Polygon> {
  const sun = subsolarPoint(date);
  // Avoid tan(0) at the equinoxes.
  const decl = Math.abs(sun.lat) < 0.01 ? 0.01 : sun.lat;
  const ring: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    const h = (lng - sun.lng) * RAD;
    const lat = Math.atan(-Math.cos(h) / Math.tan(decl * RAD)) / RAD;
    ring.push([lng, Math.max(-85, Math.min(85, lat))]);
  }
  // Close the ring over whichever pole is in darkness.
  const darkPole = decl > 0 ? -85 : 85;
  ring.push([180, darkPole], [-180, darkPole], ring[0]);
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}

// Local *solar* time at a longitude, e.g. "3:12 AM". Real time zones differ
// by politics, hence the "≈" wherever this is shown.
export function solarTime(lng: number, date: Date): string {
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const minutes = (((utcMinutes + Math.round(lng * 4)) % 1440) + 1440) % 1440;
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"}`;
}

// Great-circle distance in km.
export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

// "nearby", "~40 km away", "~2,300 km away".
export function formatDistance(km: number): string {
  if (km < 10) return "nearby";
  const step = km < 100 ? 10 : km < 1000 ? 50 : 100;
  return `~${(Math.round(km / step) * step).toLocaleString("en-US")} km away`;
}

// GeoJSON circle (as a polygon) of `radiusKm` around a point.
export function circlePolygon(
  center: { lat: number; lng: number },
  radiusKm: number,
  steps = 64,
): GeoJSON.Feature<GeoJSON.Polygon> {
  const ring: [number, number][] = [];
  const dLat = radiusKm / 110.574;
  const dLng = radiusKm / (111.32 * Math.cos(center.lat * RAD));
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    ring.push([center.lng + dLng * Math.cos(t), center.lat + dLat * Math.sin(t)]);
  }
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [ring] },
  };
}
