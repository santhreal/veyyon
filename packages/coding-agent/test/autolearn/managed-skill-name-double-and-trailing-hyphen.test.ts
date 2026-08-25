/**
 * `sanitizeSkillName` / `isValidManagedSkillName` share
 * `/^[a-z0-9][a-z0-9-]{0,63}$/`. The existing managed-skills suite rejects
 * leading dash, uppercase, empty, dot, underscore, and over-length. It does
 * not name:
 *
 *   - a trailing hyphen (`foo-`) which the regex allows
 *   - doubled hyphens (`foo--bar`) which the regex allows
 *   - interior uppercase that lowercasing would make valid (`Foo-Bar` → `foo-bar`)
 *   - a name that is valid only AFTER trim (` foo `)
 *
 * Trailing / doubled hyphens are legal on disk and must round-trip, OR the
 * pattern should refuse them — this file asserts the allowlist as written
 * so a later "kebab only" tighten cannot silently break stored skills.
 * `Foo-Bar` must be accepted via sanitize (lowercasing) but rejected by
 * `isValidManagedSkillName` (discovery reads the frontmatter as stored).
 */
import { describe, expect, it } from "bun:test";
import {
	isValidManagedSkillName,
	sanitizeSkillName,
} from "@veyyon/coding-agent/autolearn/managed-skills";

describe("sanitizeSkillName lowercases before the allowlist test", () => {
	it("accepts Foo-Bar by lowercasing to foo-bar", () => {
		expect(sanitizeSkillName("Foo-Bar")).toBe("foo-bar");
	});

	it("accepts a name that is valid only after trim", () => {
		expect(sanitizeSkillName(" foo-bar ")).toBe("foo-bar");
	});

	it("rejects a name that is still illegal after lowercasing (underscore)", () => {
		expect(() => sanitizeSkillName("Foo_Bar")).toThrow(/Invalid skill name/);
	});
});

describe("isValidManagedSkillName does not lowercase — discovery is exact", () => {
	it("rejects Foo-Bar as stored frontmatter (must already be kebab)", () => {
		expect(isValidManagedSkillName("Foo-Bar")).toBe(false);
	});

	it("rejects a padded name (trim is sanitize's job, not discovery's)", () => {
		expect(isValidManagedSkillName(" foo-bar ")).toBe(false);
	});

	it("accepts the post-sanitize shape", () => {
		expect(isValidManagedSkillName("foo-bar")).toBe(true);
	});
});

describe("the allowlist currently permits doubled and trailing hyphens", () => {
	it("accepts foo--bar as a legal managed-skill name", () => {
		expect(sanitizeSkillName("foo--bar")).toBe("foo--bar");
		expect(isValidManagedSkillName("foo--bar")).toBe(true);
	});

	it("accepts a trailing hyphen", () => {
		expect(sanitizeSkillName("foo-")).toBe("foo-");
		expect(isValidManagedSkillName("foo-")).toBe(true);
	});

	it("accepts a hyphen run at the end of a 64-char name", () => {
		const name = `a${"b".repeat(62)}-`;
		expect(name.length).toBe(64);
		expect(sanitizeSkillName(name)).toBe(name);
		expect(isValidManagedSkillName(name)).toBe(true);
	});

	it("still rejects a leading hyphen after lowercase/trim", () => {
		expect(() => sanitizeSkillName("-foo")).toThrow(/Invalid skill name/);
		expect(isValidManagedSkillName("-foo")).toBe(false);
	});

	it("still rejects an empty hyphen-only name that is just '-'", () => {
		expect(() => sanitizeSkillName("-")).toThrow(/Invalid skill name/);
		expect(isValidManagedSkillName("-")).toBe(false);
	});
});
