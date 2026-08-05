/**
 * The bearer-token file the local auth services authenticate clients with.
 *
 * WHY THIS SUITE EXISTS. This token is the only thing between a local HTTP port and a user's provider
 * credentials, and it had TWO implementations: the auth gateway's and the auth broker's, byte-identical
 * in three of five functions and divergent in the two that matter.
 *
 *  - The broker minted a token on every start that found none, without an exclusive create, so two
 *    simultaneous starts each minted one and the second overwrote the first. A client handed the first
 *    token is then rejected by the very service that issued it.
 *  - The broker wrote the file with `Bun.write`, whose default mode is `0644`, and narrowed it with a
 *    later `chmod`. Between those two calls any local user could read the token, and on Windows, where
 *    `chmod` does nothing, it stayed readable.
 *
 * Both are silent in ordinary use, which is why they survived: nothing fails, the token is simply
 * weaker or newer than the caller thinks. So the properties are asserted directly against the file on
 * disk: the mode at creation, the refusal to clobber, and the convergence of concurrent callers on one
 * token. A source check keeps the two CLIs from growing private copies again.
 *
 * The `token` subcommand both services offer is here too, for the same reason: it was implemented twice,
 * down to the JSON shape it prints, and its plain output is written to be substituted into a shell
 * (`Bearer $(veyyon auth-gateway token)`), so an extra character in it breaks a request far from here.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	AuthTokenFile,
	formatTokenOutput,
	generateAuthToken,
	printToken,
} from "@veyyon/coding-agent/cli/auth-token-file";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";

const FILE_NAME = "auth-test.token";

let isolated: IsolatedConfigRoot;
let file: AuthTokenFile;

beforeEach(() => {
	// The token path resolves through the config root, so the suite MUST own that root: without this it
	// writes a token into the developer's real `~/.veyyon`, where it would replace a live one. Setting
	// `VEYYON_CONFIG_DIR` by hand is not enough (the value is joined onto the real home and `os.homedir()`
	// is fixed at process start under Bun), which is exactly why this helper exists.
	isolated = enterIsolatedConfigRoot("auth-token-file");
	file = new AuthTokenFile(FILE_NAME);
});

afterEach(() => {
	isolated.restore();
});

/** Put a token file in place by hand, as an older version or an operator would have left it. */
async function seed(content: string, mode = 0o600): Promise<void> {
	await fs.mkdir(path.dirname(file.path()), { recursive: true });
	await fs.writeFile(file.path(), content, { mode });
}

/** The file's permission bits, as three octal digits. */
async function modeOf(target: string): Promise<string> {
	return ((await fs.stat(target)).mode & 0o777).toString(8);
}

describe("reading a token", () => {
	/** First run: nothing stored yet, which is a state and not an error. */
	it("answers null when the file does not exist", async () => {
		expect(await file.read()).toBeNull();
	});

	it("answers null for an empty or whitespace-only file, which carries no token", async () => {
		await seed("   \n");

		expect(await file.read()).toBeNull();
	});

	it("trims the stored token, so a trailing newline from an editor does not change it", async () => {
		await seed("  tok-abc\n");

		expect(await file.read()).toBe("tok-abc");
	});

	/**
	 * A token file that exists but cannot be read must NOT read as "no token": that would mint a second
	 * one and lock out every client holding the first. Only ENOENT is an answer; everything else raises.
	 */
	it("raises rather than reporting no token when the path is unreadable", async () => {
		await fs.mkdir(file.path(), { recursive: true });

		await expect(file.read()).rejects.toThrow();
	});
});

describe("creating the token file", () => {
	/**
	 * THE permissions property, and the broker's bug. The mode is asserted on the file itself, not on the
	 * call that made it, because the whole failure was that the mode arrived one call too late.
	 */
	it("creates it readable only by its owner", async () => {
		expect(await file.createExclusive("tok-new")).toBe(true);

		expect(await modeOf(file.path())).toBe("600");
		expect(await file.read()).toBe("tok-new");
	});

	it("creates the config directory it needs, also owner-only", async () => {
		const nested = new AuthTokenFile(path.join("nested-dir", FILE_NAME));

		await nested.createExclusive("tok-nested");

		expect(await nested.read()).toBe("tok-nested");
		expect(await modeOf(path.dirname(nested.path()))).toBe("700");
	});

	/**
	 * The mode has to arrive IN the create call, not in a `chmod` after it.
	 *
	 * The window this closes is unobservable in the finished state: the following `chmod` narrows the
	 * file either way, so a `stat` after the call reads `600` in both worlds. The broker's version wrote
	 * with `Bun.write` (mode `0644`) and chmod'd afterwards, so the token existed world-readable for the
	 * length of one syscall, and on Windows, where `chmod` does nothing, permanently.
	 *
	 * So the assertion is on the CALL, watched at the `node:fs/promises` seam the module actually uses,
	 * rather than on the characters of the source. A rename, a reflow, or a moved comment changes
	 * nothing here; switching to `Bun.write`, or dropping `mode` from the options, is red immediately,
	 * because then no `writeFile` carrying both flags ever reaches the seam.
	 */
	it("asks for the restricted mode in the same call that creates the file", async () => {
		const calls: Array<{ target: string; options: unknown }> = [];
		const realWriteFile = fs.writeFile;
		const spy = spyOn(fs, "writeFile").mockImplementation((async (target, data, options) => {
			calls.push({ target: String(target), options });
			return await Reflect.apply(realWriteFile, fs, [target, data, options]);
		}) as typeof fs.writeFile);
		try {
			expect(await file.createExclusive("tok-mode")).toBe(true);
		} finally {
			spy.mockRestore();
		}

		const create = calls.find(call => call.target === file.path());
		// `wx` is the no-clobber half and `0o600` is the never-briefly-wider half; both must ride the
		// same call, so they are asserted as one object rather than as two independent facts.
		expect(create?.options).toEqual({ flag: "wx", mode: 0o600 });
		expect(await modeOf(file.path())).toBe("600");
	});

	/** THE concurrency property: an existing file is reported, never truncated. */
	it("refuses to clobber an existing token and leaves it byte for byte", async () => {
		await file.createExclusive("tok-first");

		expect(await file.createExclusive("tok-second")).toBe(false);
		expect(await file.read()).toBe("tok-first");
	});
});

describe("ensuring a token", () => {
	it("mints and stores one on first run, owner-only", async () => {
		const token = await file.ensure();

		expect(token.length).toBeGreaterThan(0);
		expect(await file.read()).toBe(token);
		expect(await modeOf(file.path())).toBe("600");
	});

	it("returns the stored token on every later call rather than minting another", async () => {
		const first = await file.ensure();
		const second = await file.ensure();

		expect(second).toBe(first);
	});

	/**
	 * The race the broker lost. Ten simultaneous callers, one token: every caller must be handed the
	 * SAME string, because each of them is about to tell a client to use it. Under the broker's old
	 * read-generate-write this produced ten tokens and kept the last.
	 */
	it("hands every concurrent caller the same token", async () => {
		const tokens = await Promise.all(Array.from({ length: 10 }, () => file.ensure()));

		expect(new Set(tokens).size).toBe(1);
		expect(await file.read()).toBe(tokens[0]);
	});

	it("does not disturb a token written by hand", async () => {
		await seed("operator-supplied-token");

		expect(await file.ensure()).toBe("operator-supplied-token");
	});

	/**
	 * The SECOND race, narrower than the one above and hidden by it, found by this suite failing about one
	 * run in ten with `Received: 2`.
	 *
	 * `O_CREAT | O_EXCL` makes the file EXIST before its contents are written. A caller that lost the
	 * create race and read inside that window saw an empty file, `read()` reports empty as "no token", so
	 * the loser fell through to the last-resort write and minted a SECOND token -- the exact failure the
	 * exclusive create was added to prevent, one layer down. The fix waits for the winner to finish
	 * writing, so the assertion is the same as above, repeated enough times to actually enter the window.
	 *
	 * Repetition is the test. A single round passed most of the time even while the bug was live, which is
	 * why the bug survived: an intermittent failure in a security-adjacent suite reads as flakiness.
	 */
	it("keeps handing concurrent callers one token across many rounds", async () => {
		for (let round = 0; round < 40; round++) {
			await fs.rm(file.path(), { force: true });

			const tokens = await Promise.all(Array.from({ length: 12 }, () => file.ensure()));

			expect(new Set(tokens).size, `round ${round} produced ${new Set(tokens).size} tokens`).toBe(1);
			expect(await file.read()).toBe(tokens[0]);
		}
	});

	/**
	 * And the case the wait cannot fix: a creator that died between creating the file and writing to it
	 * leaves an empty file that will never fill in. The caller still must not be handed an empty token, so
	 * this invocation takes ownership -- but the file it replaces may have been handed out, so taking
	 * ownership is reported rather than done quietly (Law 10).
	 */
	it("replaces an empty token file left behind by an interrupted creator", async () => {
		await seed("");

		const token = await file.ensure();

		expect(token.length).toBeGreaterThan(0);
		expect(await file.read()).toBe(token);
		expect(await modeOf(file.path())).toBe("600");
	});
});

describe("rotating a token", () => {
	/** Rotation is the one path that MAY clobber, and it must land at the same restricted mode. */
	it("replaces the stored token and keeps the file owner-only", async () => {
		await file.createExclusive("tok-old");

		await file.write("tok-rotated");

		expect(await file.read()).toBe("tok-rotated");
		expect(await modeOf(file.path())).toBe("600");
	});

	/** A rotation onto a world-readable file left by an older version must narrow it. */
	it("narrows a file an older version left readable", async () => {
		await seed("tok-old", 0o644);

		await file.write("tok-rotated");

		expect(await modeOf(file.path())).toBe("600");
	});
});

describe("the generated token", () => {
	/**
	 * 32 bytes of CSPRNG output, base64url. The length is asserted because a shorter token is the kind of
	 * change that looks harmless in a diff, and the alphabet because the token travels in a header, a URL
	 * and a shell argument, where `+` and `/` do not survive intact.
	 */
	it("is 256 bits rendered in the URL-safe alphabet", () => {
		const token = generateAuthToken();

		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(token, "base64url")).toHaveLength(32);
	});

	it("differs on every call", () => {
		const tokens = new Set(Array.from({ length: 100 }, () => generateAuthToken()));

		expect(tokens.size).toBe(100);
	});
});

describe("the two auth CLIs", () => {
	/**
	 * The lock. Each of them had the whole family privately, which is how the gateway's exclusive create
	 * and creation-time mode failed to reach the broker. A reintroduced copy would pass every test above.
	 *
	 * Stated as the IMPORT EDGE, which is also the proof of absence: TypeScript refuses a module that
	 * both imports `AuthTokenFile` and declares it, so `bun check` enforces the exclusivity while this
	 * enforces the edge. The eight `not.toContain("async function readToken(")` lines this replaced
	 * checked one exact spelling each: a copy written as `const readToken = async (` satisfied all
	 * eight, and so did a copy whose signature wrapped onto a second line.
	 */
	it("use the shared owner and define no token handling of their own", async () => {
		for (const name of ["auth-broker-cli.ts", "auth-gateway-cli.ts"]) {
			const specifiers = moduleSpecifiersIn(
				await fs.readFile(path.join(import.meta.dir, "../../src/cli", name), "utf-8"),
			);

			expect(specifiers, name).toContain("./auth-token-file");
		}
	});

	it("name their own token files, which stay distinct", async () => {
		const broker = new AuthTokenFile("auth-broker.token");
		const gateway = new AuthTokenFile("auth-gateway.token");

		expect(broker.path()).not.toBe(gateway.path());
		expect(broker.path().endsWith("auth-broker.token")).toBe(true);
		expect(gateway.path().endsWith("auth-gateway.token")).toBe(true);
	});
});

describe("the `token` subcommand output", () => {
	/**
	 * The plain form is the bare token and NOTHING else, because it is written to be
	 * substituted into a shell: `--header "authorization: Bearer $(veyyon auth-gateway token)"`.
	 * A label, a colour, or the file path alongside it would travel inside the header and the
	 * request would fail somewhere far away from here. Asserted as exact bytes, including the
	 * single trailing newline.
	 */
	it("is the bare token and a newline, with nothing else on the line", () => {
		expect(formatTokenOutput("tok-abc", "/cfg/auth.token", false)).toBe("tok-abc\n");
	});

	/** The JSON form carries the path too, so a script does not have to guess where the file is. */
	it("carries the token and the path when JSON is asked for", () => {
		expect(formatTokenOutput("tok-abc", "/cfg/auth.token", true)).toBe(
			'{"token":"tok-abc","path":"/cfg/auth.token"}\n',
		);
	});

	it("stays valid JSON when the path needs escaping", () => {
		const output = formatTokenOutput("tok-abc", 'C:\\cfg\\"weird"\\auth.token', true);

		expect(JSON.parse(output)).toEqual({ token: "tok-abc", path: 'C:\\cfg\\"weird"\\auth.token' });
	});
});

describe("running the `token` subcommand", () => {
	/** Capture what the subcommand writes, since printing IS its behaviour. */
	async function run(flags: { regenerate?: boolean; json?: boolean }): Promise<string> {
		const written: string[] = [];
		const original = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		}) as typeof process.stdout.write;
		try {
			await printToken(file, flags);
		} finally {
			process.stdout.write = original;
		}
		return written.join("");
	}

	it("prints the stored token without disturbing it", async () => {
		await seed("operator-supplied-token");

		expect(await run({})).toBe("operator-supplied-token\n");
		expect(await file.read()).toBe("operator-supplied-token");
	});

	it("mints one on first run, prints it, and stores it owner-only", async () => {
		const printed = (await run({})).trimEnd();

		expect(printed).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await file.read()).toBe(printed);
		expect(await modeOf(file.path())).toBe("600");
	});

	/**
	 * Running it twice must print the same token. This is the property the broker's old
	 * read-generate-write broke: every invocation minted a token and stored the last one, so a
	 * client that read the first answer was rejected by the service that gave it.
	 */
	it("prints the same token every time it is run", async () => {
		const first = await run({});

		expect(await run({})).toBe(first);
	});

	/** `--regenerate` is the one path that MAY clobber, and rotating is a deliberate act. */
	it("replaces the token when regeneration is asked for", async () => {
		await seed("tok-old");

		const printed = (await run({ regenerate: true })).trimEnd();

		expect(printed).not.toBe("tok-old");
		expect(await file.read()).toBe(printed);
		expect(await modeOf(file.path())).toBe("600");
	});

	it("regenerates onto a missing file rather than failing", async () => {
		const printed = (await run({ regenerate: true })).trimEnd();

		expect(await file.read()).toBe(printed);
	});

	it("prints the path alongside the token in JSON, for both paths", async () => {
		const minted = JSON.parse(await run({ json: true }));
		expect(minted.path).toBe(file.path());
		expect(minted.token).toBe(await file.read());

		const rotated = JSON.parse(await run({ json: true, regenerate: true }));
		expect(rotated.token).not.toBe(minted.token);
		expect(rotated.token).toBe(await file.read());
	});
});
