const NPM_DIST_TAGS = new Set([
	"latest",
	"next",
	"beta",
	"alpha",
	"canary",
	"rc",
	"dev",
	"stable",
	"nightly",
	"experimental",
]);

const LOOKS_LIKE_VERSION = /^[\d~^>=<]/;

function isLocalPathSpec(spec: string): boolean {
	if (spec === "." || spec === ".." || spec === "~") return true;
	if (spec.startsWith("./") || spec.startsWith("../")) return true;
	if (spec.startsWith(".\\") || spec.startsWith("..\\")) return true;
	if (spec.startsWith("~/") || spec.startsWith("~\\")) return true;
	if (spec.startsWith("/")) return true;
	if (spec.startsWith("\\\\")) return true;
	if (/^[A-Za-z]:[\\/]/.test(spec)) return true;
	return false;
}

export type ClassifiedInstallTarget =
	| { type: "local"; path: string }
	| { type: "marketplace"; name: string; marketplace: string }
	| { type: "npm"; spec: string };

export function classifyInstallTarget(spec: string, knownMarketplaces: Set<string>): ClassifiedInstallTarget {
	if (isLocalPathSpec(spec)) return { type: "local", path: spec };
	if (spec.startsWith("@")) return { type: "npm", spec };
	const atIdx = spec.lastIndexOf("@");
	if (atIdx > 0) {
		const rhs = spec.slice(atIdx + 1);
		if (NPM_DIST_TAGS.has(rhs) || LOOKS_LIKE_VERSION.test(rhs)) {
			return { type: "npm", spec };
		}
		if (knownMarketplaces.has(rhs)) {
			return { type: "marketplace", name: spec.slice(0, atIdx), marketplace: rhs };
		}
		return { type: "npm", spec };
	}
	return { type: "npm", spec };
}
