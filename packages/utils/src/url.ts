/**
 * URL string primitives shared by provider/discovery base-URL normalizers.
 * Each caller keeps its own default/env/suffix policy; the slash handling
 * lives here so "http://x//" cannot normalize differently across providers.
 */

/** Strip every trailing slash — `"http://x//"` → `"http://x"`. */
export function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}
