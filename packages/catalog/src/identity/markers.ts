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

const REFERENCE_ONLY_TRAILING_MARKERS = ["search"] as const;

export const REFERENCE_TRAILING_MARKER_PATTERN = new RegExp(
	`[-:](?:${[...TRAILING_MARKERS, ...REFERENCE_ONLY_TRAILING_MARKERS].join("|")})$`,
	"i",
);
