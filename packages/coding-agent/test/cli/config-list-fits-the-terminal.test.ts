/**
 * `veyyon config list` used to be laid out for an infinite terminal.
 *
 * Every setting printed as one `key = value (type)` line with no wrapping, so at 80 columns 15
 * lines ran past the edge and `bashInterceptor.patterns` emitted a single 2355-character line.
 * The terminal re-broke each of those wherever it liked, with no indent, so the tail of a value
 * came back at column 0 and read as a new setting. These tests hold the listing to the width of
 * the terminal it is printed on, and hold the fix to not having bought that by hiding values.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

const cliEntry = path.resolve(import.meta.dir, "..", "..", "src", "cli.ts");

/** The setting whose default value is far too long for any terminal. */
const LONG_VALUE_KEY = "bashInterceptor.patterns";

/** Widths to check: the narrow clamp, the conventional default, and two wider panes. */
const WIDTHS: number[] = [60, 80, 100, 120];

const listings = new Map<number, string>();
let jsonListing: Record<string, { value: unknown; type: string }> = {};

async function run(args: string[], columns?: number): Promise<{ stdout: string; exitCode: number }> {
	// Piped stdout reports no width, which is exactly how an operator reads a 400-setting
	// listing (into a pager or a grep); the renderer has to take the width from COLUMNS.
	const { env, cleanup } = hermeticSpawnEnv(columns === undefined ? {} : { COLUMNS: String(columns) });
	try {
		const proc = Bun.spawn([process.execPath, cliEntry, "config", ...args], {
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { stdout, exitCode };
	} finally {
		cleanup();
	}
}

/** A line that introduces a setting: exactly two spaces, then the key, then ` =`. */
const KEY_LINE = /^ {2}\S/;

/** The lines a setting's value continued onto, below its key line, in order. */
function continuationLines(text: string, key: string): string[] {
	const lines = text.split("\n");
	const start = lines.findIndex(line => line.startsWith(`  ${key} =`));
	expect(start).toBeGreaterThan(-1);
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === "" || !line.startsWith(" ") || KEY_LINE.test(line)) break;
		out.push(line);
	}
	return out;
}

beforeAll(async () => {
	for (const columns of WIDTHS) {
		const { stdout, exitCode } = await run(["list"], columns);
		expect(exitCode).toBe(0);
		listings.set(columns, stdout);
	}
	const { stdout, exitCode } = await run(["list", "--json"]);
	expect(exitCode).toBe(0);
	jsonListing = JSON.parse(stdout) as typeof jsonListing;
}, 60_000);

describe("config list fits the terminal", () => {
	/**
	 * The wrapping bug itself: `config list` ignored the terminal and emitted 15 lines past 80
	 * columns, the worst 2355 characters wide. A line may only exceed the width when it is a
	 * single token with nowhere to break (an unbroken enum spelling, a regex with no spaces);
	 * an over-width line that CONTAINS a space is the renderer failing to wrap.
	 */
	it.each(WIDTHS)("wraps every breakable line at %d columns", columns => {
		const lines = (listings.get(columns) ?? "").split("\n");
		expect(lines.length).toBeGreaterThan(400);

		const unwrapped = lines
			.filter(line => line.length > columns && line.trim().includes(" "))
			.map(line => `${line.length} cols: ${line.trim().slice(0, 60)}`);

		expect(unwrapped).toEqual([]);
	});

	/**
	 * The 2.3kB JSON value is the reason wrapping was chosen over truncating. `config list` is
	 * how an operator reads what a setting is ACTUALLY set to, so an ellipsis would hide the
	 * part they came to check. Rejoining the continuation lines must reproduce the stored value
	 * byte for byte, including its final `}]`, and it must genuinely span many lines: a value
	 * that still fits on one line means the renderer went back to laying out for no terminal.
	 */
	it("prints the 2.3kB JSON value in full across continuation lines", () => {
		const expected = JSON.stringify(jsonListing[LONG_VALUE_KEY]?.value);
		expect(expected.length).toBeGreaterThan(2000);

		const continuation = continuationLines(listings.get(80) ?? "", LONG_VALUE_KEY);
		expect(continuation.length).toBeGreaterThan(20);

		// Wrapping breaks at a space and drops it, so trimming and rejoining with one space is
		// the inverse: what comes back is the value, not an approximation of it.
		const rendered = continuation.map(line => line.trim()).join(" ");
		expect(rendered).toBe(`${expected} (array)`);
		// Stated separately because it is the specific claim: the END of the value survived.
		expect(rendered).toContain(expected.slice(-120));
		expect(rendered).not.toContain("...");
	});

	/**
	 * Wrapping a value back to column 0 would trade one bug for a worse one: the tail of
	 * `bashInterceptor.patterns` would read as another setting, and `awk '{print $1}'` over the
	 * listing would invent keys. Continuations are indented deeper than the two spaces a key
	 * sits at, so exactly the key lines carry a key.
	 */
	it("indents continuations so they cannot be read as new settings", () => {
		const listing = listings.get(80) ?? "";

		const continuation = continuationLines(listing, LONG_VALUE_KEY);
		// An empty block would make the loop below vacuous, and means the value went back to
		// riding on the key line at whatever length it happened to be.
		expect(continuation.length).toBeGreaterThan(20);
		for (const line of continuation) {
			expect(line).toMatch(/^ {3,}\S/);
			expect(KEY_LINE.test(line)).toBe(false);
		}

		// Nothing but a key line, a `[group]` header, the `Settings:` title or a blank line may
		// start at column 0-2, or the extracted key set below is fiction.
		const strays = listing
			.split("\n")
			.filter(line => line.trim() !== "" && !KEY_LINE.test(line) && !line.startsWith("   "))
			.filter(line => !/^\[[a-z-]+\]$/i.test(line) && line !== "Settings:");
		expect(strays).toEqual([]);
	});

	/**
	 * A layout change that merges or drops rows is a regression dressed as a fix. The keys the
	 * human listing shows must be exactly the keys `--json` reports, at every width, so a value
	 * that wrapped onto four lines is still one setting.
	 */
	it.each(WIDTHS)("still shows every setting at %d columns", columns => {
		const listing = listings.get(columns) ?? "";
		const expected = Object.keys(jsonListing).sort();

		expect(expected.length).toBeGreaterThan(400);
		const shown = listing
			.split("\n")
			.filter(line => KEY_LINE.test(line))
			.map(line => line.trim().split(" ")[0] ?? "")
			.sort();
		expect(shown).toEqual(expected);
	});

	/**
	 * Each key line still carries its `=`, at one indent, so the listing stays greppable:
	 * `grep '^  model.primary ='` is how a script reads a setting out of it.
	 */
	it("keeps every setting on a greppable key line", () => {
		const listing = listings.get(80) ?? "";
		for (const line of listing.split("\n").filter(line => KEY_LINE.test(line))) {
			expect(line).toMatch(/^ {2}\S+ =(\s|$)/);
		}
		expect(listing).toMatch(/^ {2}git\.enabled = +true \(boolean\)$/m);
	});
});
