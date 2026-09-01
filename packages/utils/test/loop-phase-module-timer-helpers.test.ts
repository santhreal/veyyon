import { describe, expect, it } from "bun:test";
import { currentLoopPhase, popLoopPhase, pushLoopPhase, takeLoopPhaseProfile } from "../src/loop-phase";
import { importerDir, instrumentContents, MODULE_LOADER_FILTER, STATIC_IMPORT_PATTERN } from "../src/module-timer";

describe("MODULE_LOADER_FILTER", () => {
	it("matches .ts files", () => {
		expect(MODULE_LOADER_FILTER.test("file.ts")).toBe(true);
	});

	it("matches .tsx files", () => {
		expect(MODULE_LOADER_FILTER.test("file.tsx")).toBe(true);
	});

	it("matches .mts files", () => {
		expect(MODULE_LOADER_FILTER.test("file.mts")).toBe(true);
	});

	it("matches .cts files", () => {
		expect(MODULE_LOADER_FILTER.test("file.cts")).toBe(true);
	});
	it("does not match .js files", () => {
		expect(MODULE_LOADER_FILTER.test("file.js")).toBe(false);
	});

	it("does not match .json files", () => {
		expect(MODULE_LOADER_FILTER.test("file.json")).toBe(false);
	});

	it("does not match .css files", () => {
		expect(MODULE_LOADER_FILTER.test("file.css")).toBe(false);
	});
});

describe("STATIC_IMPORT_PATTERN", () => {
	it("matches default import", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('import foo from "bar"');
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("bar");
	});

	it("matches named import", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('import { foo } from "bar"');
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("bar");
	});

	it("matches namespace import", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('import * as foo from "bar"');
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("bar");
	});

	it("matches dynamic import", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('import("bar")');
		expect(match).not.toBeNull();
		expect(match?.[2]).toBe("bar");
	});

	it("matches type import", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('import type { Foo } from "bar"');
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("bar");
	});

	it("matches export from", () => {
		STATIC_IMPORT_PATTERN.lastIndex = 0;
		const match = STATIC_IMPORT_PATTERN.exec('export { foo } from "bar"');
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe("bar");
	});
});

describe("instrumentContents", () => {
	it("wraps regular content with markers", () => {
		const result = instrumentContents("/path/file.ts", "const x = 1;");
		expect(result).toContain("const x = 1;");
		expect(result).toContain("veyyon.moduleBodyStart");
		expect(result).toContain("veyyon.moduleLoadComplete");
	});

	it("preserves shebang line", () => {
		const result = instrumentContents("/path/file.ts", "#!/usr/bin/env bun\nconst x = 1;");
		expect(result.startsWith("#!/usr/bin/env bun\n")).toBe(true);
		expect(result).toContain("veyyon.moduleBodyStart");
		expect(result).toContain("const x = 1;");
	});

	it("handles shebang-only file", () => {
		const result = instrumentContents("/path/file.ts", "#!/usr/bin/env bun");
		expect(result).toContain("#!/usr/bin/env bun");
		expect(result).toContain("veyyon.moduleBodyStart");
	});

	it("includes path in markers", () => {
		const result = instrumentContents("/my/path/file.ts", "code");
		expect(result).toContain("/my/path/file.ts");
	});
});

describe("importerDir", () => {
	it("returns directory for absolute path", () => {
		expect(importerDir("/home/user/file.ts")).toBe("/home/user");
	});

	it("returns directory for relative path", () => {
		expect(importerDir("src/file.ts")).toBe("src");
	});

	it("returns . for no slash", () => {
		expect(importerDir("file.ts")).toBe(".");
	});

	it("returns . for empty string", () => {
		expect(importerDir("")).toBe(".");
	});

	it("handles nested paths", () => {
		expect(importerDir("/a/b/c/d/file.ts")).toBe("/a/b/c/d");
	});

	it("handles trailing slash", () => {
		expect(importerDir("/a/b/")).toBe("/a/b");
	});
});

describe("pushLoopPhase / popLoopPhase / currentLoopPhase", () => {
	it("currentLoopPhase returns undefined when stack is empty", () => {
		// Clear any existing state
		while (currentLoopPhase() !== undefined) popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	it("push sets currentLoopPhase", () => {
		pushLoopPhase("test-phase");
		expect(currentLoopPhase()).toBe("test-phase");
		popLoopPhase();
	});

	it("pop clears currentLoopPhase when stack becomes empty", () => {
		pushLoopPhase("test-phase");
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	it("handles nested push/pop", () => {
		pushLoopPhase("outer");
		pushLoopPhase("inner");
		expect(currentLoopPhase()).toBe("inner");
		popLoopPhase();
		expect(currentLoopPhase()).toBe("outer");
		popLoopPhase();
		expect(currentLoopPhase()).toBeUndefined();
	});

	it("pop on empty stack does not throw", () => {
		// Clear stack first
		while (currentLoopPhase() !== undefined) popLoopPhase();
		expect(() => popLoopPhase()).not.toThrow();
	});
});

describe("takeLoopPhaseProfile", () => {
	it("returns profile with phase and ms", () => {
		pushLoopPhase("test-phase");
		popLoopPhase();
		const profile = takeLoopPhaseProfile();
		expect(profile.phase).toBeDefined();
		expect(typeof profile.ms).toBe("number");
	});

	it("clears spent after taking profile", () => {
		pushLoopPhase("phase1");
		popLoopPhase();
		takeLoopPhaseProfile();
		const profile2 = takeLoopPhaseProfile();
		// After clearing, phase may be undefined or have 0 ms
		expect(profile2.ms).toBe(0);
	});

	it("reports a phase that was pushed", () => {
		pushLoopPhase("cheap");
		popLoopPhase();
		pushLoopPhase("expensive");
		popLoopPhase();
		const profile = takeLoopPhaseProfile();
		expect(profile.phase).toBeDefined();
	});

	it("handles empty stack", () => {
		// Clear everything
		while (currentLoopPhase() !== undefined) popLoopPhase();
		takeLoopPhaseProfile(); // clear spent
		const profile = takeLoopPhaseProfile();
		expect(profile.ms).toBe(0);
	});
});
