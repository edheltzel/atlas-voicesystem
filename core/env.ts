// =============================================================================
// Environment parsing helpers — host-neutral
// =============================================================================

// Parse a numeric environment variable, falling back to `fallback` when the
// value is missing, non-numeric, or below `min`. Guards against degenerate
// configs (NaN / negative / zero) that would otherwise silently break timeouts,
// retry counts, or breaker thresholds — e.g. a NaN timeout → setTimeout(fn, 0)
// firing instantly, or a NaN retry count zeroing the retry loop and reporting a
// false success for a synthesis that never ran (issue #25, masks real outages).
export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
