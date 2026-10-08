/**
 * WHY THIS EXISTS. The tool-views bundle is gitignored build output that the HTML export inlines. It
 * used to be regenerated only when the file was missing, so a checkout whose bundle predated a source
 * change kept serving it: the export viewer then called a global the old bundle never published
 * (`formatToolCallLabel`) and the exported session tree threw a ReferenceError in the browser.
 *
 * THE CLASS. Any bundle that does not match the sources it was built from: one with no input stamp
 * (every bundle written before the stamp existed), one whose recorded hash no longer matches its
 * inputs, and one that lists an input that is gone. Each must be reported stale and rebuilt by the
 * helper both test entry points call, and a freshly built bundle must be reported current so a normal
 * run builds nothing.
 *
 * WHAT IT DOES NOT CATCH. A source the bundler never read (and so never listed) can change without
 * the stamp noticing; that is correct, since such a file cannot change the bundle. A stale bundle in
 * a compiled release binary is out of scope: the binary build writes the bundle fresh.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	buildToolViewsScript,
	toolViewsStaleness,
	writeToolViewsBundle,
} from "../clients/web/scripts/build-tool-views";
import { TempDir } from "../packages/utils/src/temp";
import { ensureToolViewsGenerated } from "./ensure-tool-views";

const BUILD_TIMEOUT_MS = 120_000;

let tempDir: TempDir;
let current: string;

beforeAll(async () => {
	tempDir = TempDir.createSync("@veyyon-tool-views-stale-");
	current = await buildToolViewsScript();
}, BUILD_TIMEOUT_MS);

afterAll(() => {
	tempDir[Symbol.dispose]();
});

const REPO_ROOT = path.join(import.meta.dirname, "..");

/**
 * The stamp a bundle built from `inputs` records. This is the persisted format the staleness check
 * reads back from disk: per input, its repository-relative path, a NUL, its byte length, a NUL, then
 * its bytes, all under one SHA-256.
 */
async function expectedStamp(inputs: readonly string[]): Promise<string> {
	const hash = createHash("sha256");
	for (const input of inputs) {
		const bytes = await fs.readFile(path.join(REPO_ROOT, input));
		hash.update(`${input}\0${bytes.length}\0`);
		hash.update(bytes);
	}
	return `// tool-views inputs ${hash.digest("hex")} ${JSON.stringify(inputs)}\n`;
}

/** The bundle with its second line (the input stamp) replaced, or removed when `stamp` is empty. */
function withStamp(script: string, stamp: string): string {
	const first = script.indexOf("\n") + 1;
	const second = script.indexOf("\n", first) + 1;
	return script.slice(0, first) + stamp + script.slice(second);
}

function stampLine(script: string): string {
	const first = script.indexOf("\n") + 1;
	return script.slice(first, script.indexOf("\n", first) + 1);
}

const STALE_VARIANTS: ReadonlyArray<readonly [string, (script: string) => string, string]> = [
	["a bundle written before the stamp existed", script => withStamp(script, ""), "no input stamp"],
	[
		"a bundle whose inputs changed after it was built",
		script => {
			const line = stampLine(script);
			const hash = line.split(" ")[3] ?? "";
			const forged = hash.replace(/^./, c => (c === "0" ? "1" : "0"));
			return withStamp(script, line.replace(hash, forged));
		},
		"sources changed since it was built",
	],
	[
		"a bundle that lists an input which is gone",
		script => {
			const line = stampLine(script);
			return withStamp(script, line.replace("[", '["clients/web/src/tool-render/no-such-input.tsx",'));
		},
		"an input was removed",
	],
];

describe("a stale tool-views bundle is rebuilt before it is served", () => {
	it("reports a freshly built bundle current, so a normal run builds nothing", async () => {
		const outFile = tempDir.join("fresh.generated.js");
		await fs.writeFile(outFile, current);
		expect(await toolViewsStaleness(outFile)).toBeNull();
	});

	it("reports a missing bundle", async () => {
		expect(await toolViewsStaleness(tempDir.join("absent.generated.js"))).toBe("missing");
	});

	for (const [name, damage, reason] of STALE_VARIANTS) {
		it(`reports ${name} stale`, async () => {
			const outFile = tempDir.join(`${reason.replaceAll(" ", "-")}.generated.js`);
			await fs.writeFile(outFile, damage(current));
			expect(await toolViewsStaleness(outFile)).toBe(reason);
		});
	}

	it("reports an input edited in place to the same length stale", async () => {
		const input = tempDir.join("input.tsx");
		await fs.writeFile(input, "export const a = 1;\n");
		const relative = path.relative(REPO_ROOT, input).split(path.sep).join("/");
		const outFile = tempDir.join("same-length.generated.js");
		await fs.writeFile(outFile, withStamp(current, await expectedStamp([relative])));
		expect(await toolViewsStaleness(outFile)).toBeNull();
		await fs.writeFile(input, "export const a = 2;\n");
		expect(await toolViewsStaleness(outFile)).toBe("sources changed since it was built");
	});

	it(
		"rebuilds a stale bundle into one that publishes the label formatter the export viewer calls",
		async () => {
			const outFile = tempDir.join("rebuilt.generated.js");
			// The shape every pre-stamp checkout holds: a real bundle, no stamp.
			await fs.writeFile(outFile, withStamp(current, ""));
			await ensureToolViewsGenerated(outFile);
			const rebuilt = await fs.readFile(outFile, "utf8");
			expect(await toolViewsStaleness(outFile)).toBeNull();
			expect(rebuilt).toBe(current);
			expect(rebuilt).toContain("formatToolCallLabel");
		},
		BUILD_TIMEOUT_MS,
	);

	it(
		"leaves a current bundle untouched",
		async () => {
			const outFile = tempDir.join("untouched.generated.js");
			await writeToolViewsBundle(outFile);
			const before = await fs.stat(outFile);
			await ensureToolViewsGenerated(outFile);
			const after = await fs.stat(outFile);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(after.ino).toBe(before.ino);
		},
		BUILD_TIMEOUT_MS,
	);
});
