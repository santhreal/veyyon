/**
 * Trailing-marker vocabulary for proxy-reference lookup. A "marker" is a
 * routing/quantization/effort suffix a reseller or aggregator appends to an
 * upstream model id (`-thinking`, `:nitro`, `-fp8`, …) that does not change
 * model identity.
 *
 * Canonical-id coalescing deliberately does NOT share this module: it needs a
 * narrower vocabulary (it must never strip `search`) and runs generator-side
 * only, so it keeps its own copy in `scripts/equivalence.ts`.
 */
const TRAILING_MARKERS = [
	"thinking",
	"customtools",
	"high",
	"low",
	"medium",
	"minimal",
	"xhigh",
	"free",
	"cloud",
	"exacto",
	"nitro",
	"original",
	"optimized",
	"nvfp4",
	"fp8",
	"fp4",
	"bf16",
	"int8",
	"int4",
] as const;

/**
 * Markers treated as identity-preserving ONLY when recovering bundled metadata
 * for a proxied model id, never during canonical-id coalescing: Perplexity's
 * `sonar-pro-search` is a distinct model from `sonar-pro`, so canonical
 * resolution must not strip `search`, while a proxy id like
 * `claude-opus-4-6-search` should still inherit the upstream pricing/limits.
 */
const REFERENCE_ONLY_TRAILING_MARKERS = ["search"] as const;

/** Marker pattern used by proxy-reference lookup (`search` included). */
export const REFERENCE_TRAILING_MARKER_PATTERN = new RegExp(
	`[-:](?:${[...TRAILING_MARKERS, ...REFERENCE_ONLY_TRAILING_MARKERS].join("|")})$`,
	"i",
);
