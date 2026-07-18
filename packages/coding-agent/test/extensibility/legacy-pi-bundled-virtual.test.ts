import { describe, expect, it } from "bun:test";
import {
	__getLegacyPiBundledModulesGlobal,
	__synthesizeLegacyPiBundledSourceWithModules,
} from "@veyyon/coding-agent/extensibility/plugins/legacy-pi-compat";

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API. The compat layer now routes canonical
// `@veyyon/*` imports through virtual modules backed by live host module
// references. The synthesizer must preserve every named/default export.
describe("legacy-pi bundled virtual module synthesizer (issue #3423)", () => {
	const modules = {
		"@veyyon/coding-agent": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@veyyon/utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		typebox: {
			Type: { Object: () => undefined },
		},
	};
	const globalKey = __getLegacyPiBundledModulesGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
		expect(src).toContain(
			`const __veyyon_bundled = globalThis[${JSON.stringify(globalKey)}]["@veyyon/coding-agent"];`,
		);
		expect(src).toContain('export const VERSION = __veyyon_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __veyyon_bundled["defineTool"];');
		expect(src).toContain('export const Type = __veyyon_bundled["Type"];');
		// Every named export emerges from a live module lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/utils", modules);
		expect(src).toContain("export default __veyyon_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __veyyon_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __veyyon_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the bundled modules do not cover", () => {
		expect(() => __synthesizeLegacyPiBundledSourceWithModules("@veyyon/not-bundled", modules)).toThrow(
			/no bundled module registered for @veyyon\/pi-not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every legacy extension
		// load with a `Cannot read properties of undefined` at first import.
		const src = __synthesizeLegacyPiBundledSourceWithModules("typebox", modules);
		expect(src.startsWith(`const __veyyon_bundled = globalThis[${JSON.stringify(globalKey)}]["typebox"];`)).toBe(
			true,
		);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		Reflect.set(globalThis, globalKey, modules);
		try {
			const src = __synthesizeLegacyPiBundledSourceWithModules("@veyyon/coding-agent", modules);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__veyyon_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __veyyon_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __veyyon_bundled;`);
			const live: unknown = fn();
			if (typeof live !== "object" || live === null) {
				throw new Error("synthetic module did not resolve an object namespace");
			}
			expect("VERSION" in live ? live.VERSION : undefined).toBe("16.1.17");
			expect(typeof ("defineTool" in live ? live.defineTool : undefined)).toBe("function");
			expect(typeof ("Type" in live ? live.Type : undefined)).toBe("object");
		} finally {
			Reflect.deleteProperty(globalThis, globalKey);
		}
	});
});
