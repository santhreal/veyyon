/**
 * WHY: folding every character with bitwise OR also folds control characters
 * into URL punctuation. Every declared marker must retain literal punctuation
 * while matching ASCII letter case. The registry supplies the variant space;
 * every marker position is exercised against the complete ASCII alphabet.
 * This tests host classification, not endpoint authentication or URL validation.
 */
import { expect, test } from "bun:test";
import { hostMatchesUrl, KNOWN_HOSTS, type KnownHost, modelMatchesHost } from "@veyyon/catalog/hosts";

for (const host of Object.keys(KNOWN_HOSTS) as KnownHost[]) {
	test(`${host} preserves literal marker characters across every ASCII substitution`, () => {
		const markers: readonly string[] = KNOWN_HOSTS[host].urlMarkers;
		expect(markers.length).toBeGreaterThan(0);
		const mismatches: Array<{ marker: string; offset: number; code: number; expected: boolean }> = [];
		for (const marker of markers) {
			expect(marker).toMatch(/^[\x20-\x7e]+$/);
			for (let offset = 0; offset < marker.length; offset++) {
				for (let code = 0; code < 128; code++) {
					const changed = marker.slice(0, offset) + String.fromCharCode(code) + marker.slice(offset + 1);
					const url = `https://fixture.invalid/proxy/${changed}/v1`;
					const expected = markers.some(candidate => url.toLowerCase().includes(candidate));
					if (
						hostMatchesUrl(url, host) !== expected ||
						modelMatchesHost({ provider: "fixture", baseUrl: url }, host) !== expected
					) {
						mismatches.push({ marker, offset, code, expected });
					}
				}
				for (const character of ["K", "ſ", "İ", "ı", "é", "\ud800", "\udfff", "\u{10400}"]) {
					const changed = marker.slice(0, offset) + character + marker.slice(offset + 1);
					expect(hostMatchesUrl(`https://fixture.invalid/proxy/${changed}/v1`, host)).toBe(false);
				}
			}
			expect(hostMatchesUrl(`https://fixture.invalid/proxy/${marker.toUpperCase()}`, host)).toBe(true);
		}
		expect(mismatches).toEqual([]);
		expect(hostMatchesUrl(undefined, host)).toBe(false);
		expect(hostMatchesUrl("", host)).toBe(false);
	});
}
