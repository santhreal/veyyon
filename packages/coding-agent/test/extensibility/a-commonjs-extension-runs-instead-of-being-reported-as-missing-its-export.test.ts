/**
 * A CommonJS extension entry runs, and a CommonJS entry that throws is reported as throwing.
 *
 * WHY THIS SUITE EXISTS. Every extension entry is served to Bun through a `Bun.plugin` `onLoad`
 * hook so its legacy imports can be rewritten. Source that arrives through that hook is never
 * given Bun's CommonJS treatment: a `module.exports = factory` file came back as an empty,
 * unevaluated namespace. The loader then reported "no default export that is a function" for a
 * file that was never run, and a CommonJS entry that threw at top level was reported the same
 * way, since it never ran either. A `.js` extension written the way `node` documents it was dead,
 * with a diagnosis that sent the author to the wrong line.
 *
 * THE CLASS THIS CLOSES. Every CommonJS shape an entry can take: `.cjs`, `.js` with
 * `module.exports`, transpiled `.js` with `__esModule` and `exports.default`, and `.ts` with a
 * `require` and no `import`.
 * The controls are an ES module that also calls `require` (must not be wrapped) and an ES module
 * with no export (must still be reported as missing its export, which is now true).
 *
 * WHAT IT DOES NOT CATCH. A CommonJS module reached through `import` from a hooked module is
 * left to Bun's native loader; its named-export interop is Bun's contract, not this suite's. The
 * synchronous hook serves an entry only when a helper that requires a native addon requires the
 * entry back; that needs a real `.node` fixture and is not driven here.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@veyyon-cjs-extension-");
});

afterEach(() => {
	tempDir.removeSync();
});

/** Loads one entry the way a session does, as an operator-named path so the trust gate passes it. */
async function loadOne(fileName: string, source: string): Promise<{ loaded: boolean; error: string | null }> {
	const entry = path.join(tempDir.path(), fileName);
	fs.writeFileSync(entry, source);
	const result = await loadExtensions([entry], tempDir.path(), new EventBus(), undefined, {
		configuredPaths: [entry],
	});
	return { loaded: result.extensions.length === 1, error: result.errors[0]?.error ?? null };
}

/** The factory records that it ran by registering a command, which is what a loaded extension does. */
const REGISTERS = `(pi) => { pi.registerCommand("cjs-ran", { description: "d", handler: async () => {} }); }`;

const COMMONJS_SHAPES: Array<{ name: string; file: string; source: string }> = [
	{ name: "`.cjs` with module.exports", file: "ext.cjs", source: `module.exports = ${REGISTERS};\n` },
	{ name: "`.js` with module.exports", file: "ext.js", source: `module.exports = ${REGISTERS};\n` },
	{
		name: "transpiled `.js` with __esModule and exports.default",
		file: "ext-default.js",
		source: `Object.defineProperty(exports, "__esModule", { value: true });\nexports.default = ${REGISTERS};\n`,
	},
	{
		name: "`.ts` with a require and no import",
		file: "ext.ts",
		source: `const fs = require("node:fs");\nvoid fs;\nmodule.exports = ${REGISTERS};\n`,
	},
];

describe("a CommonJS extension entry", () => {
	for (const shape of COMMONJS_SHAPES) {
		it(`written as ${shape.name} is loaded and its factory runs`, async () => {
			const { loaded, error } = await loadOne(shape.file, shape.source);

			expect(error).toBeNull();
			expect(loaded).toBe(true);
		});
	}

	it("that requires a plain CommonJS helper is loaded and its factory runs", async () => {
		// The helper is left to Bun's native loader; only the entry is served through the hook.
		fs.writeFileSync(path.join(tempDir.path(), "helper.js"), `module.exports = { v: 1 };\n`);
		const { loaded, error } = await loadOne(
			"entry.js",
			`const helper = require("./helper.js");\nif (helper.v !== 1) throw new Error("helper not evaluated");\nmodule.exports = ${REGISTERS};\n`,
		);

		expect(error).toBeNull();
		expect(loaded).toBe(true);
	});

	it("that throws at top level is reported as throwing, with its own message", async () => {
		const { loaded, error } = await loadOne(
			"boom.js",
			`const fs = require("node:fs");\nthrow new Error("cjs boom");\n`,
		);

		expect(loaded).toBe(false);
		expect(error).toContain("Importing this extension threw");
		expect(error).toContain("cjs boom");
	});

	it("that exports something other than a function is reported as missing its export", async () => {
		const { loaded, error } = await loadOne("object.js", `module.exports = { notAFactory: true };\n`);

		expect(loaded).toBe(false);
		expect(error).toContain("no default export that is a function");
	});
});

describe("an ES module entry", () => {
	it("that also calls require is loaded as written", async () => {
		const { loaded, error } = await loadOne(
			"esm-require.ts",
			`const fs = require("node:fs");\nvoid fs;\nexport default ${REGISTERS};\n`,
		);

		expect(error).toBeNull();
		expect(loaded).toBe(true);
	});

	it("with no default export is still reported as missing it", async () => {
		const { loaded, error } = await loadOne("nodefault.ts", `export const x = 1;\n`);

		expect(loaded).toBe(false);
		expect(error).toContain("no default export that is a function");
	});
});
