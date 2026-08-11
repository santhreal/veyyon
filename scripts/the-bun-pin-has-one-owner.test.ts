// WHY: the bun version this repository runs on was written out as a literal in
// fifteen places — a `bun-version:` input in every workflow job that set up bun,
// the composite action's install URL, the sandbox guest Dockerfile, and the two
// shell fallbacks that build that guest. A bump is one line in
// `packageManager`, and a bump that missed one of the other fifteen produced the
// worst available failure: a job that runs a DIFFERENT bun than the one the
// suites were pinned to, silently, and only on the jobs that were missed.
//
// THE CLASS this closes: a second owner for the pin. Workflows now pass
// `oven-sh/setup-bun` no version at all, which makes it read `packageManager`
// itself, and the composite action reads the same field. Anything that still
// spells a version out has to spell out the SAME one, and the files are read off
// disk rather than listed here, so a new workflow, action, or sandbox script
// carrying a stale literal is red on arrival.
//
// WHAT IT DOES NOT CATCH: a literal in a file outside the two trees below, and a
// pin that is consistent everywhere and simply wrong (nothing here knows which
// bun release is good). It also cannot see a version chosen at runtime from
// somewhere other than `packageManager`.

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** The one owner. Everything else in this file is checked against it. */
function pinnedBunVersion(): string {
	const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
		packageManager?: string;
	};
	const match = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
	if (!match) throw new Error(`package.json packageManager is not a bun pin: ${manifest.packageManager}`);
	return match[1];
}

/** Every file under the trees that decide which bun a job or a guest runs. */
function scannedFiles(): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs);
			else if (entry.isFile()) out.push(path.relative(ROOT, abs));
		}
	};
	walk(path.join(ROOT, ".github", "workflows"));
	walk(path.join(ROOT, ".github", "actions"));
	walk(path.join(ROOT, "scripts", "test-sandbox"));
	return out.sort();
}

/**
 * The spellings a bun version is written in around here: the setup-bun input,
 * the installer's release tag, the guest image tag, and the shell variable the
 * sandbox scripts default. Each captures the version so it can be compared
 * rather than merely detected.
 */
const VERSION_SPELLINGS: readonly RegExp[] = [
	/bun-version:\s*"?(\d+\.\d+\.\d+)/g,
	/bun-v(\d+\.\d+\.\d+)/g,
	/oven\/bun:(\d+\.\d+\.\d+)/g,
	/bun@(\d+\.\d+\.\d+)/g,
	/BUN_VERSION\s*[:?]?=\s*"?(\d+\.\d+\.\d+)/g,
];

interface Literal {
	readonly file: string;
	readonly version: string;
}

function literalsIn(file: string): Literal[] {
	const text = fs.readFileSync(path.join(ROOT, file), "utf8");
	const found: Literal[] = [];
	for (const pattern of VERSION_SPELLINGS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) found.push({ file, version: match[1] });
	}
	return found;
}

describe("the bun pin has one owner", () => {
	it("is declared as a bun packageManager in the root manifest", () => {
		expect(pinnedBunVersion()).toMatch(/^\d+\.\d+\.\d+$/);
	});

	it("finds the trees it claims to scan", () => {
		const files = scannedFiles();
		expect(files).toContain(".github/workflows/ci.yml");
		expect(files).toContain(".github/actions/bun-install/action.yml");
		expect(files).toContain("scripts/test-sandbox/guest/Dockerfile");
	});

	/**
	 * A literal is allowed only where it is a fallback for a read that already
	 * happened (the guest Dockerfile's ARG default, the two shell `:=` defaults),
	 * and only when it agrees with the owner. Disagreement is the bug this
	 * closes, so the assertion names every file that disagrees rather than
	 * counting them.
	 */
	it("never spells a different version than the one the manifest pins", () => {
		const pin = pinnedBunVersion();
		const disagreeing = scannedFiles()
			.flatMap(literalsIn)
			.filter(literal => literal.version !== pin)
			.map(literal => `${literal.file}: ${literal.version}`);

		expect(disagreeing, `these still pin a bun other than ${pin} from package.json`).toEqual([]);
	});

	/**
	 * The reason the count above is small: a workflow that passes setup-bun no
	 * version gets `packageManager` read for it. Passing one puts the pin back
	 * into thirteen job definitions, which is the state this gate replaced, and
	 * a version that merely agrees today is exactly how the drift started.
	 */
	it("lets setup-bun read the manifest instead of restating the version", () => {
		const offenders = scannedFiles().filter(file =>
			/bun-version(-file)?:/.test(fs.readFileSync(path.join(ROOT, file), "utf8")),
		);

		expect(offenders, "drop the bun-version input; setup-bun reads packageManager when given none").toEqual([]);
	});
});
