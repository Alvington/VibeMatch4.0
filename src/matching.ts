/** Great-circle distance between two lat/lng points, in kilometers. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Similarity between two "vibe quiz" answer vectors, based on normalized
 * Euclidean distance. Returns 1 for identical answers, 0 for maximally
 * different answers on a 1-5 scale.
 *
 * Note: this deliberately isn't cosine similarity. Cosine similarity compares
 * *direction* rather than actual value, so on a 1-5 Likert scale it would
 * score [5,5,5,5] and [1,1,1,1] as a perfect match (they're just one being a
 * scalar multiple of the other) even though those are the most opposite
 * answers possible on the quiz. Distance-based scoring gets this right.
 */
export function vibeScore(a: number[], b: number[], scaleMax = 5): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;

  const squaredDiffs = a.reduce((sum, v, i) => sum + (v - b[i]) ** 2, 0);
  const distance = Math.sqrt(squaredDiffs);
  const maxPossibleDistance = Math.sqrt(a.length * (scaleMax - 1) ** 2);

  if (maxPossibleDistance === 0) return 1;
  return 1 - distance / maxPossibleDistance;
}

/** Combines vibe similarity and shared-interest count into one ranking score. */
export function overallScore(vibe: number, sharedInterests: number): number {
  return vibe + sharedInterests * 0.1;
}
