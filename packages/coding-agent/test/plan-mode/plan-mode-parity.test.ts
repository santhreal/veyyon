/**
 * Plan-mode subsystem parity oracle: pins plan title normalization, title
 * resolution, humanization, slug-to-URL mapping, and the default plan file URL.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite must reproduce these exact
 * behaviors: title sanitization rules, path-separator rejection, fallback
 * chain ordering, and URL construction.
 */
import { describe, expect, it } from "bun:test";
import {
	normalizePlanTitle,
	resolvePlanTitle,
	humanizePlanTitle,
	planFileUrlForSlug,
} from "@veyyon/coding-agent/plan-mode/approved-plan";
import { DEFAULT_PLAN_FILE_URL } from "@veyyon/coding-agent/plan-mode/plan-file-url";
import { ToolError } from "@veyyon/coding-agent/tools/tool-errors";

describe("DEFAULT_PLAN_FILE_URL", () => {
	it("is exactly 'local://PLAN.md'", () => {
		expect(DEFAULT_PLAN_FILE_URL).toBe("local://PLAN.md");
	});
});

describe("normalizePlanTitle", () => {
	it("passes through a simple valid title", () => {
		expect(normalizePlanTitle("my-feature")).toEqual({ title: "my-feature", fileName: "my-feature.md" });
	});

	it("strips trailing .md extension", () => {
		expect(normalizePlanTitle("my-plan.md")).toEqual({ title: "my-plan", fileName: "my-plan.md" });
	});

	it("replaces spaces with hyphens", () => {
		expect(normalizePlanTitle("My Feature Plan")).toEqual({ title: "My-Feature-Plan", fileName: "My-Feature-Plan.md" });
	});

	it("collapses multiple hyphens", () => {
		expect(normalizePlanTitle("a   b")).toEqual({ title: "a-b", fileName: "a-b.md" });
	});

	it("strips leading and trailing hyphens", () => {
		expect(normalizePlanTitle("---test---")).toEqual({ title: "test", fileName: "test.md" });
	});

	it("drops non-alphanumeric characters except underscore and hyphen", () => {
		expect(normalizePlanTitle("test@home!")).toEqual({ title: "testhome", fileName: "testhome.md" });
	});

	it("preserves underscores", () => {
		expect(normalizePlanTitle("my_plan")).toEqual({ title: "my_plan", fileName: "my_plan.md" });
	});

	it("throws on empty title", () => {
		expect(() => normalizePlanTitle("")).toThrow(ToolError);
		expect(() => normalizePlanTitle("  ")).toThrow(ToolError);
	});

	it("throws on path separators", () => {
		expect(() => normalizePlanTitle("a/b")).toThrow(ToolError);
		expect(() => normalizePlanTitle("a\\b")).toThrow(ToolError);
		expect(() => normalizePlanTitle("..")).toThrow(ToolError);
	});

	it("throws when sanitization leaves no valid characters", () => {
		expect(() => normalizePlanTitle("@@@")).toThrow(ToolError);
	});
});

describe("resolvePlanTitle", () => {
	it("uses supplied title when valid", () => {
		const result = resolvePlanTitle({
			suppliedTitle: "auth-refactor",
			planContent: "# Some Plan\nbody",
			planFilePath: "local://PLAN.md",
		});
		expect(result.title).toBe("auth-refactor");
		expect(result.fileName).toBe("auth-refactor.md");
		expect(result.source).toBe("supplied");
	});

	it("falls back to heading when supplied title is missing", () => {
		const result = resolvePlanTitle({
			suppliedTitle: undefined,
			planContent: "# My Awesome Plan\nbody",
			planFilePath: "local://PLAN.md",
		});
		expect(result.source).toBe("heading");
		expect(result.title).toBe("My-Awesome-Plan");
	});

	it("falls back to filename stem when no heading", () => {
		const result = resolvePlanTitle({
			suppliedTitle: undefined,
			planContent: "no heading here",
			planFilePath: "local://my-plan.md",
		});
		expect(result.source).toBe("filename");
		expect(result.title).toBe("my-plan");
	});

	it("falls back to default 'plan' when nothing else works", () => {
		const result = resolvePlanTitle({
			suppliedTitle: undefined,
			planContent: "",
			planFilePath: "",
		});
		expect(result.source).toBe("default");
		expect(result.title).toBe("plan");
		expect(result.fileName).toBe("plan.md");
	});

	it("skips non-string suppliedTitle", () => {
		const result = resolvePlanTitle({
			suppliedTitle: 42,
			planContent: "# Heading\n",
			planFilePath: "local://PLAN.md",
		});
		expect(result.source).toBe("heading");
	});

	it("skips empty string suppliedTitle", () => {
		const result = resolvePlanTitle({
			suppliedTitle: "  ",
			planContent: "# Heading\n",
			planFilePath: "local://PLAN.md",
		});
		expect(result.source).toBe("heading");
	});
});

describe("humanizePlanTitle", () => {
	it("replaces hyphens with spaces and capitalizes first letter", () => {
		expect(humanizePlanTitle("my-feature-plan")).toBe("My feature plan");
	});

	it("replaces underscores with spaces", () => {
		expect(humanizePlanTitle("my_plan")).toBe("My plan");
	});

	it("collapses multiple separators", () => {
		expect(humanizePlanTitle("a--b__c")).toBe("A b c");
	});

	it("returns empty string for whitespace-only input", () => {
		expect(humanizePlanTitle("---")).toBe("");
		expect(humanizePlanTitle("___")).toBe("");
	});

	it("passes through single word capitalized", () => {
		expect(humanizePlanTitle("plan")).toBe("Plan");
	});
});

describe("planFileUrlForSlug", () => {
	it("constructs local:// URL with -plan.md suffix", () => {
		expect(planFileUrlForSlug("auth")).toBe("local://auth-plan.md");
		expect(planFileUrlForSlug("my-feature")).toBe("local://my-feature-plan.md");
	});

	it("passes through empty slug", () => {
		expect(planFileUrlForSlug("")).toBe("local://-plan.md");
	});
});
