/**
 * Regression: a GitHub cache setting that cannot be used must say so.
 *
 * `resolveCacheTtl` reads three settings. Both of its failure paths used to be
 * silent:
 *
 *  - an exception from `settings.get` was swallowed by a bare `catch`, with a
 *    comment explaining that settings "may be a stripped test stub". That is a
 *    test concern shaping production behaviour, and it hid real read failures.
 *  - a value of the wrong type or out of range fell through to the default with
 *    nothing reported. This is the one a user hits: write
 *    `github.cache.softTtlSec: "10m"` or a negative TTL and the setting simply
 *    has no effect, with nothing anywhere to explain why.
 *
 * Falling back to the default is correct. Doing it quietly is not (Law 10).
 * These tests pin both the value that comes out AND the report that goes with
 * it, because the report is the part that regressed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveCacheTtl } from "@veyyon/coding-agent/tools/github-cache";
import { logger } from "@veyyon/utils";

/** A settings object that answers from a map, as the real one does. */
function settingsFrom(values: Record<string, unknown>): Settings {
	return { get: (key: string) => values[key] } as unknown as Settings;
}

/** A settings object whose reads throw, standing in for a broken config load. */
function throwingSettings(message: string): Settings {
	return {
		get: (key: string) => {
			throw new Error(`${message}: ${key}`);
		},
	} as unknown as Settings;
}

describe("resolveCacheTtl reports settings it cannot use", () => {
	let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

	beforeEach(() => {
		warnings = [];
		vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
			warnings.push({ message, fields: fields ?? {} });
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("uses values a user set correctly, and says nothing about them", () => {
		const ttl = resolveCacheTtl(
			settingsFrom({
				"github.cache.softTtlSec": 30,
				"github.cache.hardTtlSec": 600,
				"github.cache.enabled": false,
			}),
		);

		expect(ttl).toEqual({ softMs: 30_000, hardMs: 600_000, enabled: false });
		expect(warnings).toEqual([]);
	});

	it("accepts zero as a real value rather than treating it as unset", () => {
		// Zero is a meaningful TTL (always stale). Reporting it as unusable, or
		// silently replacing it with the default, would both be wrong.
		const ttl = resolveCacheTtl(settingsFrom({ "github.cache.softTtlSec": 0 }));

		expect(ttl.softMs).toBe(0);
		expect(warnings).toEqual([]);
	});

	it("reports a TTL written as a string, and names the key, the value and the fix", () => {
		// The exact misconfiguration this fix is about: a plausible-looking value
		// that the reader cannot use.
		const ttl = resolveCacheTtl(settingsFrom({ "github.cache.softTtlSec": "10m" }));

		expect(ttl.softMs).toBe(300 * 1000);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("A GitHub cache setting has an unusable value and is being ignored");
		expect(warnings[0]?.fields.key).toBe("github.cache.softTtlSec");
		expect(warnings[0]?.fields.value).toBe("10m");
		expect(warnings[0]?.fields.expected).toBe("a number of zero or more");
		expect(warnings[0]?.fields.usingInstead).toBe(300);
		expect(warnings[0]?.fields.fix).toBe(
			"Set github.cache.softTtlSec to a number of zero or more, or remove it to use the default.",
		);
	});

	it("reports a negative TTL, which is in range for the type but not for the setting", () => {
		const ttl = resolveCacheTtl(settingsFrom({ "github.cache.hardTtlSec": -1 }));

		expect(ttl.hardMs).toBe(604_800 * 1000);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.fields.key).toBe("github.cache.hardTtlSec");
		expect(warnings[0]?.fields.value).toBe(-1);
	});

	it("reports a boolean setting written as a string, which YAML makes easy to do", () => {
		const ttl = resolveCacheTtl(settingsFrom({ "github.cache.enabled": "false" }));

		// Note the value: the string "false" is truthy, so the old silent path made
		// this read as the default `true` while the user believed they had turned
		// the cache off.
		expect(ttl.enabled).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.fields.key).toBe("github.cache.enabled");
		expect(warnings[0]?.fields.expected).toBe("true or false");
	});

	it("reports every unusable setting, not just the first one read", () => {
		const ttl = resolveCacheTtl(
			settingsFrom({
				"github.cache.softTtlSec": "soon",
				"github.cache.hardTtlSec": null,
				"github.cache.enabled": 1,
			}),
		);

		expect(ttl).toEqual({ softMs: 300_000, hardMs: 604_800_000, enabled: true });
		// `null` is absence, not a bad value, so it is not reported. The other two
		// are.
		expect(warnings.map(w => w.fields.key)).toEqual(["github.cache.softTtlSec", "github.cache.enabled"]);
	});

	it("reports a settings read that throws instead of swallowing it", () => {
		const ttl = resolveCacheTtl(throwingSettings("config unreadable"));

		expect(ttl).toEqual({ softMs: 300_000, hardMs: 604_800_000, enabled: true });
		expect(warnings).toHaveLength(3);
		for (const warning of warnings) {
			expect(warning.message).toBe("Could not read a GitHub cache setting; using its default");
			expect(String(warning.fields.error)).toContain("config unreadable");
		}
	});

	it("says nothing when there are no settings at all", () => {
		// A caller with no settings is not a misconfiguration, it is the documented
		// way to ask for defaults. Warning here would make the log noise that trains
		// people to ignore these warnings.
		const ttl = resolveCacheTtl(undefined);

		expect(ttl).toEqual({ softMs: 300_000, hardMs: 604_800_000, enabled: true });
		expect(warnings).toEqual([]);
	});

	it("says nothing when a setting is simply unset", () => {
		const ttl = resolveCacheTtl(settingsFrom({}));

		expect(ttl).toEqual({ softMs: 300_000, hardMs: 604_800_000, enabled: true });
		expect(warnings).toEqual([]);
	});
});
