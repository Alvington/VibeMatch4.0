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

/**
 * Similarity between two people's interest sets, as a Jaccard index (shared /
 * total distinct interests across both). 1 if their interest lists are
 * identical, 0 if they share nothing (or neither has any interests listed).
 */
export function interestOverlap(aIds: number[], bIds: number[]): number {
  if (!aIds.length && !bIds.length) return 0;
  const setA = new Set(aIds);
  const setB = new Set(bIds);
  const shared = [...setA].filter((id) => setB.has(id)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * The "vibe %" shown to users - a blend of quiz-answer similarity and shared
 * interests, so someone with a near-identical vibe quiz but zero shared
 * interests doesn't outrank someone who's a great match on both fronts.
 * Weighted 70/30 toward the quiz since it's a richer, more deliberate signal
 * than a handful of interest tags.
 */
export function combinedVibeScore(quizVibe: number, interestOverlapScore: number): number {
  return quizVibe * 0.7 + interestOverlapScore * 0.3;
}

/** Combines the blended vibe score and shared-interest count into one ranking score. */
export function overallScore(combinedVibe: number, sharedInterests: number): number {
  return combinedVibe + sharedInterests * 0.02;
}