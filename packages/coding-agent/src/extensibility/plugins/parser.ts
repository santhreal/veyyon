/** Feature bracket parser for plugin specifiers. Supports syntax like: */

export interface ParsedPluginSpec {
	/** Package name (may include version specifier like @1.0.0) */
	packageName: string;
	/** Feature selection: - null: use defaults (base features on first install, preserve on reinstall) */
	features: string[] | null | "*";
}

/** Parse plugin specifier with feature bracket syntax. parsePluginSpec("my-plugin") // { packageName: "my-plugin", features: null } */
export function parsePluginSpec(spec: string): ParsedPluginSpec {
	// Find the last bracket pair (to handle version specifiers like @1.0.0)
	const bracketStart = spec.lastIndexOf("[");
	const bracketEnd = spec.lastIndexOf("]");

	// No brackets or malformed -> base features
	if (bracketStart === -1 || bracketEnd === -1 || bracketEnd < bracketStart) {
		return { packageName: spec, features: null };
	}

	const packageName = spec.slice(0, bracketStart);
	const featureStr = spec.slice(bracketStart + 1, bracketEnd).trim();

	// All features
	if (featureStr === "*") {
		return { packageName, features: "*" };
	}

	// No optional features
	if (featureStr === "") {
		return { packageName, features: [] };
	}

	// Specific features (comma-separated)
	const features = featureStr
		.split(",")
		.map(f => f.trim())
		.filter(Boolean);

	return { packageName, features };
}

/** Format a parsed plugin spec back to string form. formatPluginSpec({ packageName: "pkg", features: null }) // "pkg" */
export function formatPluginSpec(spec: ParsedPluginSpec): string {
	if (spec.features === null) {
		return spec.packageName;
	}
	if (spec.features === "*") {
		return `${spec.packageName}[*]`;
	}
	if (spec.features.length === 0) {
		return `${spec.packageName}[]`;
	}
	return `${spec.packageName}[${spec.features.join(",")}]`;
}

/** Extract the dependency key from an npm package specifier. Used for path lookups after npm install. */
export function extractPackageName(specifier: string): string {
	const npmSpecifier = specifier.replace(/^npm:/i, "");
	// Handle scoped packages: @scope/name@version -> @scope/name
	if (npmSpecifier.startsWith("@")) {
		const match = npmSpecifier.match(/^(@[^/]+\/[^@]+)/);
		return match ? match[1] : npmSpecifier;
	}
	// Unscoped: name@version -> name
	return npmSpecifier.replace(/@[^@]+$/, "");
}
