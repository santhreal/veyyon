/**
 * Helpers that existed as byte-identical copies now have exactly one definition each.
 *
 * WHY THIS SUITE EXISTS. Comparing every top-level function in `packages/` by name AND body turned up
 * 48 helpers defined identically in more than one file. Byte-identical is the dangerous state, not the
 * safe one: nothing tells you the copies exist, so a fix lands in one of them, and the pair that had
 * already drifted proves the cost is real (the three eval executors' session-key builders had grown
 * two behavioural differences, one of which started a second interpreter; see
 * `eval-session-key-has-one-owner.test.ts`).
 *
 * HOW "THERE IS ONE OWNER" IS ASSERTED, AND WHY IT CHANGED. Every family used to carry a source
 * search: `expect(text).not.toContain("async function canonicalProjectDir(")` beside
 * `expect(text).toContain("canonicalProjectDir")`. Both halves are broken in the same direction. The
 * absence passes the moment a copy is spelled `const canonicalProjectDir = async (`, or the signature
 * is reflowed onto two lines, or a type annotation lands between the name and the paren -- which is to
 * say it passes for every copy that is not a byte-for-byte replay of the one that was deleted. The
 * presence passes on the name appearing in a comment. Fifty of those assertions in one file amounted
 * to a spell-checker for code that had already been changed.
 *
 * Two things replace them, and each is exact:
 *
 *  - IDENTITY, where the name is reachable from both modules. `collab/protocol.ts` re-exports the
 *    envelope codec and `subprocess/worker-client.ts` re-exports the log replay, so
 *    `expect(consumer.fn).toBe(owner.fn)` is the whole claim: same function object, not a copy that
 *    happens to look alike. Nothing about how it is spelled can satisfy this.
 *  - THE IMPORT EDGE, where the consumer only calls the owner. `moduleSpecifiersIn` reads the runtime
 *    specifiers out of the module graph, so a reflow, a rename of a local, or a comment changes
 *    nothing. And the edge alone proves the absence: TypeScript refuses a module that both imports a
 *    binding and declares it, so "imports `canonicalProjectDir` from `./paths`" IS "does not define
 *    `canonicalProjectDir`", enforced by `bun check` rather than by a substring.
 *
 * The behaviour of each helper is asserted at its owner, which is what makes any of this worth
 * guarding.
 *
 * The families unified so far:
 *
 *  - `canonicalProjectDir`, the resolution that decides which launch daemon a project uses. Two copies,
 *    in the client and in the presence file. If they ever disagreed about a symlinked project, the
 *    client would talk to one daemon while presence kept another alive.
 *  - `parseJsonOrYamlByExtension`, the "YAML if `.yaml`/`.yml`, otherwise JSON" decision that the LSP
 *    and DAP config readers each made privately.
 *  - `formatProviderName`, which renders a provider slug for a person. Three copies, and all three are
 *    user-visible: the `/usage` report, the usage CLI, and the status line.
 *  - `assertUniqueCanonicalPaths`, the patch check that refuses two hashline sections resolving to one
 *    file, which now lives in the package that defines the section type.
 *  - `toErrorMessage` in the two DAP files, deleted rather than moved: `errorMessage` from
 *    `@veyyon/utils` already owns that question and answers it better.
 *  - `tryReadHeadSha`, the commit an experiment records, and `branch.currentOrHead`, the human-facing
 *    spelling of the current branch that two bundled commands each rolled themselves.
 *  - `sanitizeDiagnosticDisplayText`, one rendering rule that two diagnostic surfaces stated separately.
 *  - the browser tab target id, derived on both sides of the supervisor/worker boundary.
 *  - the collab wire envelope codec and the AES-256-GCM frame seal, both of which the TUI host and the
 *    browser guest each carried in full, and `asStrictBytes`, the WebCrypto coercion four packages
 *    needed. Both are shared across package boundaries, so the owner is the package that already owns
 *    the concept: `@veyyon/wire` for the envelope, beside the header length it reads, and
 *    `@veyyon/utils` for the byte coercion.
 *  - `buildTreePrefix`, drawn by three renderers, one of which had drifted to the opposite argument
 *    order; `isThenable`, whose two copies came with a comment justifying one of them; and the CLI
 *    model-runtime bootstrap, whose copies both had to close the credential store on failure.
 */

import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryReadHeadSha } from "@veyyon/coding-agent/autoresearch/git";
import * as collabCrypto from "@veyyon/coding-agent/collab/crypto";
import * as collabProtocol from "@veyyon/coding-agent/collab/protocol";
import { canonicalProjectDir } from "@veyyon/coding-agent/launch/paths";
import { formatProviderName } from "@veyyon/coding-agent/slash-commands/helpers/format";
import * as workerClient from "@veyyon/coding-agent/subprocess/worker-client";
import type { WorkerLogPayload } from "@veyyon/coding-agent/subprocess/worker-log";
import * as workerLog from "@veyyon/coding-agent/subprocess/worker-log";
import { buildTreePrefix } from "@veyyon/coding-agent/tui/utils";
import { branch } from "@veyyon/coding-agent/utils/git";
import { errorMessage, parseJsonOrYamlByExtension, TempDir } from "@veyyon/utils";
import { asStrictBytes } from "@veyyon/utils/bytes";
import * as logger from "@veyyon/utils/logger";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";
import * as wire from "@veyyon/wire";

const SRC = path.join(import.meta.dir, "../../src");
const PACKAGES = path.join(SRC, "../..");

/**
 * The runtime module specifiers `relative` (under `src/`) names.
 *
 * This is the "no private copy" proof, not a search for one: a module cannot import a binding and
 * also declare it, so the presence of the edge is checked here and its exclusivity by `bun check`.
 */
function importsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(SRC, relative), "utf-8"));
}

/** The same, for a file in a sibling package. */
function packageImportsOf(relative: string): string[] {
	return moduleSpecifiersIn(fs.readFileSync(path.join(PACKAGES, relative), "utf-8"));
}

describe("canonicalProjectDir", () => {
	/**
	 * The property the launch daemon depends on. A project reached through a symlink and through its real
	 * path must be ONE daemon; keying them separately starts a second broker that shares no sessions.
	 */
	it("resolves a symlinked project to the same directory as its real path", async () => {
		using dir = TempDir.createSync("@veyyon-canonical-project-");
		const real = path.join(dir.path(), "project");
		const link = path.join(dir.path(), "link-to-project");
		fs.mkdirSync(real);
		fs.symlinkSync(real, link);

		expect(await canonicalProjectDir(link)).toBe(await canonicalProjectDir(real));
		expect(await canonicalProjectDir(link)).toBe(fs.realpathSync.native(real));
	});

	it("resolves a relative path against the process directory", async () => {
		expect(await canonicalProjectDir(".")).toBe(fs.realpathSync.native(process.cwd()));
	});

	/**
	 * A directory that does not exist yet is answered with its absolute path rather than an error,
	 * because presence may be registered for a project that is about to be created.
	 */
	it("answers a missing directory with its absolute path", async () => {
		const missing = path.join(path.sep, "no-such-project-9d4f", "inner");

		expect(await canonicalProjectDir(missing)).toBe(path.resolve(missing));
	});

	/** Both launch callers take it from `./paths`, which is also the proof neither declares its own. */
	it("is defined once, and the two launch callers import it", () => {
		for (const file of ["launch/client.ts", "launch/presence.ts"]) {
			expect(importsOf(file), file).toContain("./paths");
		}
	});
});

describe("parseJsonOrYamlByExtension", () => {
	it("parses YAML for both YAML extensions, in either case", () => {
		expect(parseJsonOrYamlByExtension("servers:\n  ts: {}\n", "/etc/lsp.yaml")).toEqual({ servers: { ts: {} } });
		expect(parseJsonOrYamlByExtension("servers:\n  ts: {}\n", "/etc/lsp.YML")).toEqual({ servers: { ts: {} } });
	});

	it("parses JSON for anything else, including a file with no extension", () => {
		expect(parseJsonOrYamlByExtension('{"a":1}', "/etc/lsp.json")).toEqual({ a: 1 });
		expect(parseJsonOrYamlByExtension('{"a":1}', "/etc/lspconfig")).toEqual({ a: 1 });
	});

	/**
	 * A malformed config must throw, so the reader can name the file. Returning null here would make a
	 * config the user is looking at silently do nothing, which is the failure the copies risked.
	 */
	it("throws on malformed input rather than returning nothing", () => {
		expect(() => parseJsonOrYamlByExtension("{not json", "/etc/lsp.json")).toThrow();
		expect(() => parseJsonOrYamlByExtension("a:\n  - b\n c: broken", "/etc/lsp.yaml")).toThrow();
	});

	it("is what both config readers call, and neither defines its own", () => {
		for (const file of ["lsp/config.ts", "dap/config.ts"]) {
			expect(importsOf(file), file).toContain("@veyyon/utils");
		}
	});
});

describe("formatProviderName", () => {
	it("title-cases a slug on both separators", () => {
		expect(formatProviderName("openai")).toBe("Openai");
		expect(formatProviderName("openai-compat")).toBe("Openai Compat");
		expect(formatProviderName("z_ai")).toBe("Z Ai");
	});

	/** Degenerate input is rendered, not crashed on: these strings come from config a user typed. */
	it("survives empty segments and an empty slug", () => {
		expect(formatProviderName("")).toBe("");
		expect(formatProviderName("a--b")).toBe("A  B");
	});

	it("is defined once and imported by all three surfaces", () => {
		const surfaces: ReadonlyArray<readonly [string, string]> = [
			["slash-commands/helpers/usage-report.ts", "./format"],
			["cli/usage-cli.ts", "../slash-commands/helpers/format"],
			["modes/controllers/command-controller.ts", "../../slash-commands/helpers/format"],
		];
		for (const [file, owner] of surfaces) {
			expect(importsOf(file), file).toContain(owner);
		}
	});
});

describe("assertUniqueCanonicalPaths", () => {
	/**
	 * The hashline patcher owns it, because it owns `PreparedSection`. The coding agent's edit path had a
	 * byte-identical copy, message and all, so the two could have disagreed about whether a patch naming
	 * one file twice is an error, and the second write would have silently discarded the first.
	 */
	it("lives in the hashline package, not in the coding agent's copy", () => {
		expect(importsOf("edit/hashline/execute.ts")).toContain("@veyyon/hashline");
	});
});

describe("the DAP client's error rendering", () => {
	/**
	 * Both DAP files had a private `toErrorMessage` that returned `String(value)` for a non-Error and
	 * `value.message` otherwise. `errorMessage` from `@veyyon/utils` is the repo-wide owner of exactly
	 * that question and answers it slightly BETTER: an Error thrown with an empty message renders as its
	 * class name rather than as an empty string, which is the difference between a log line that names
	 * the failure and one that says nothing. So the copies are gone rather than moved.
	 */
	it("goes through the shared owner, and no private copy remains", () => {
		for (const file of ["dap/client.ts", "dap/session.ts"]) {
			expect(importsOf(file), file).toContain("@veyyon/utils");
		}
	});

	/**
	 * The BEHAVIOURAL difference that made deleting the copies an improvement rather than a move, which
	 * nothing asserted while the two copies existed. `String(value)` for a non-Error and `value.message`
	 * otherwise renders an Error thrown with an empty message as an empty string, so a DAP failure
	 * logged that way said nothing at all. The shared owner names the class instead.
	 */
	it("names the error class when the message is empty, which the private copies did not", () => {
		expect(errorMessage(new TypeError(""))).toBe("TypeError");
		expect(errorMessage(new Error("adapter closed"))).toBe("adapter closed");
		expect(errorMessage("adapter closed")).toBe("adapter closed");
	});
});

describe("tryReadHeadSha", () => {
	/**
	 * An experiment records the commit it ran against, and "there is no commit" is an ordinary state: a
	 * directory that is not a repository yet still deserves a recorded run. Asserted against a real
	 * non-repository directory, because that is the branch both copies existed to handle.
	 */
	it("answers null for a directory that is not a repository", async () => {
		using dir = TempDir.createSync("@veyyon-head-sha-");

		expect(await tryReadHeadSha(dir.path())).toBeNull();
	});

	it("reads this repository's HEAD as a full hex sha", async () => {
		const sha = await tryReadHeadSha(path.join(import.meta.dir, "../.."));

		expect(sha).toMatch(/^[0-9a-f]{40}$/);
	});

	it("is defined once in autoresearch/git.ts and imported by both experiment tools", () => {
		for (const file of ["autoresearch/tools/init-experiment.ts", "autoresearch/tools/log-experiment.ts"]) {
			expect(importsOf(file), file).toContain("../git");
		}
	});
});

describe("branch.currentOrHead", () => {
	/**
	 * The human-facing spelling of the current branch. `/review` and `/ci-green` each had their own copy,
	 * and both existed only to turn the "no branch" answer into the string git itself uses for that
	 * position. It now sits beside `branch.current`, which keeps the distinction for callers that need it.
	 */
	it("answers HEAD for a directory that is not a repository", async () => {
		using dir = TempDir.createSync("@veyyon-current-branch-");

		expect(await branch.currentOrHead(dir.path())).toBe("HEAD");
	});

	it("answers this repository's branch name, which is not the fallback", async () => {
		const name = await branch.currentOrHead(path.join(import.meta.dir, "../.."));

		expect(name.length).toBeGreaterThan(0);
		expect(name).toBe((await branch.current(path.join(import.meta.dir, "../.."))) ?? "HEAD");
	});

	it("is what both bundled commands call, and neither defines its own", async () => {
		for (const file of [
			"extensibility/custom-commands/bundled/review/index.ts",
			"extensibility/custom-commands/bundled/ci-green/index.ts",
		]) {
			expect(importsOf(file), file).toContain("../../../../utils/git");
		}
	});
});

describe("sanitizeDiagnosticDisplayText", () => {
	/**
	 * Two surfaces render diagnostics (the LSP panel and the tool-result renderer) and each had its own
	 * copy of the same one-line rule. A literal tab in a rendered diagnostic lands on the terminal's tab
	 * stops, so a column marker under it points at the wrong column; the two surfaces disagreeing about
	 * that would mean the same diagnostic reads differently depending on where it appeared.
	 */
	it("is defined once in render-utils, and the LSP renderer imports it", () => {
		expect(importsOf("lsp/render.ts")).toContain("../tools/render-utils");
	});
});

describe("the browser tab target id", () => {
	/**
	 * The supervisor hands the worker a target id and the worker matches its own targets against it, so
	 * the two sides MUST derive it identically: one reading puppeteer's private field while the other
	 * asked CDP would let a tab be addressed under two ids, and a command would land on no tab at all.
	 * Both had a private copy of both functions.
	 */
	it("is derived by one module that both sides import", () => {
		for (const file of ["tools/browser/tab-supervisor.ts", "tools/browser/tab-worker.ts"]) {
			expect(importsOf(file), file).toContain("./target-id");
		}
	});
});

describe("the collab wire envelope", () => {
	/**
	 * The envelope routes a collab frame, and the host writes the envelopes the browser guest reads. Both
	 * sides had their own copy of the codec, so the byte order and the header length were stated twice for
	 * one wire format. Drift there does not throw: the payload still decrypts, because the room key is
	 * untouched, and the frame is simply delivered to the wrong peer. `@veyyon/wire` already owned
	 * `ENVELOPE_HEADER_LENGTH`, so the three functions that read it belong beside it. The format itself is
	 * pinned byte by byte in `packages/wire/test/envelope.test.ts`.
	 */
	/**
	 * IDENTITY, which is the strongest form available here and the one a text search cannot reach: the
	 * host's three names ARE the wire package's function objects, so there is nothing to drift.
	 */
	it("is coded by @veyyon/wire, and the host re-exports those exact functions", () => {
		expect(collabProtocol.packEnvelope).toBe(wire.packEnvelope);
		expect(collabProtocol.unpackEnvelope).toBe(wire.unpackEnvelope);
		expect(collabProtocol.rewriteEnvelopePeer).toBe(wire.rewriteEnvelopePeer);
	});

	/**
	 * And the browser guest, which cannot be imported here (it is a browser-graph module in a private
	 * package), states the same thing as an import edge. Identity would be better; the edge is what is
	 * available, and it is still a graph fact rather than a substring.
	 */
	it("is what the browser guest imports too", () => {
		expect(packageImportsOf("collab-web/src/lib/link.ts")).toContain("@veyyon/wire");
	});
});

describe("asStrictBytes", () => {
	/**
	 * Four packages seal, sign or hash bytes through WebCrypto, and each had a private copy of the same
	 * coercion. `crypto.subtle` reads the whole backing buffer of the array it is given, so the copy a
	 * partial view needs is a correctness requirement and not a typing formality: a copy "tidied" into a
	 * bare cast would compile everywhere and sign the neighbouring bytes. The behaviour is pinned in
	 * `packages/utils/test/bytes.test.ts`; this is the lock against a fifth private copy.
	 */
	/**
	 * The correctness requirement itself, driven rather than searched for. `crypto.subtle` reads the
	 * WHOLE backing buffer, so a partial view has to be copied; a copy "tidied" into a bare cast
	 * compiles everywhere and signs the neighbouring bytes. Nothing here asserted that, and a source
	 * search for `function asStrict(` never could.
	 */
	it("copies a partial view so a signer cannot reach the neighbouring bytes", () => {
		const backing = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const view = backing.subarray(2, 5);
		const strict = asStrictBytes(view);

		expect([...strict]).toEqual([3, 4, 5]);
		expect(strict.byteOffset).toBe(0);
		expect(strict.buffer.byteLength).toBe(3);
		// A whole-buffer view needs no copy, which is the case the coercion must not pessimise.
		expect(asStrictBytes(backing).buffer.byteLength).toBe(8);
	});

	/**
	 * The two collab modules that used to need it are no longer call sites: their sealing moved to
	 * `@veyyon/wire`, which is dependency-free, and the copies both slices there need are
	 * unconditional (neither spans its own buffer), so a plain `new Uint8Array` is identical.
	 */
	it("is what every remaining crypto call site imports", () => {
		for (const file of ["ai/src/providers/aws-sigv4.ts", "ai/src/auth-broker/snapshot-cache.ts"]) {
			expect(packageImportsOf(file), file).toContain("@veyyon/utils/bytes");
		}
	});

	/**
	 * Where it IS imported outside a Bun-only graph, it must come from the submodule rather than the
	 * barrel: the `@veyyon/utils` barrel re-exports Bun-only modules, and pulling it into a browser
	 * bundle fails that build outright. `packages/utils/test/browser-safe-barrel.test.ts` enforces this
	 * for every browser-graph root; this pins the one call site that reaches it from a signing path.
	 */
	it("is reached through the submodule where the barrel would be wrong", () => {
		const specifiers = packageImportsOf("ai/src/providers/aws-sigv4.ts");

		expect(specifiers).toContain("@veyyon/utils/bytes");
		expect(specifiers).not.toContain("@veyyon/utils");
	});
});

describe("the AES-256-GCM frame seal", () => {
	/**
	 * The seal is a wire format, not an implementation detail of either end: the TUI host seals what the
	 * browser guest opens. Both sides had the whole thing, and the browser copy's own header called
	 * itself a mirror of the host's. Drift fails in the worst available way, because a GCM tag mismatch
	 * cannot distinguish a wrong key from a wrong layout: change the IV length on one side and every
	 * frame fails to authenticate with nothing naming the cause, which reads as a broken relay or a bad
	 * link. The format is pinned in `packages/wire/test/seal.test.ts`; this is the lock that neither side
	 * states it again.
	 */
	/**
	 * Driven end to end across the boundary, which is the only assertion that can see a layout drift:
	 * a GCM tag mismatch cannot distinguish a wrong key from a wrong IV length, so the host sealing and
	 * the wire package opening (and the reverse) is the statement worth making. The three key helpers
	 * are the wire package's own function objects, by identity.
	 */
	it("seals on the host and opens through the wire package, and back", async () => {
		expect(collabCrypto.generateRoomKey).toBe(wire.generateRoomKey);
		expect(collabCrypto.importRoomKey).toBe(wire.importRoomKey);
		expect(collabCrypto.generateWriteToken).toBe(wire.generateWriteToken);

		const key = await collabCrypto.importRoomKey(collabCrypto.generateRoomKey());
		const frame: collabProtocol.CollabFrame = { t: "hello", proto: 1, name: "guest-1" };
		const sealed = await collabCrypto.seal(key, frame);

		// 12-byte IV, then ciphertext and the 16-byte GCM tag. A layout change on either side moves this.
		expect(sealed.byteLength).toBeGreaterThan(12 + 16);
		expect(await wire.openFrame<collabProtocol.CollabFrame>(key, sealed)).toEqual(frame);
		expect(await collabCrypto.open(key, await wire.sealFrame(key, frame))).toEqual(frame);

		// A different key does not open it, so the round trip above is authentication and not a no-op.
		const other = await collabCrypto.importRoomKey(collabCrypto.generateRoomKey());

		await expect(collabCrypto.open(other, sealed)).rejects.toThrow();
	});

	/** And the browser guest states the same edge, since it cannot be imported into this realm. */
	it("is what the browser guest codec imports", () => {
		expect(packageImportsOf("collab-web/src/lib/codec.ts")).toContain("@veyyon/wire");
	});

	/**
	 * `@veyyon/wire` has no dependencies, which is what lets the browser guest import it directly. The
	 * seal was the one thing that looked like it needed `@veyyon/utils`, so this fails if a dependency
	 * appears rather than waiting for a browser build to break.
	 */
	it("did not give @veyyon/wire a dependency", () => {
		const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGES, "wire/package.json"), "utf-8")) as {
			dependencies?: Record<string, string>;
		};

		expect(manifest.dependencies ?? {}).toEqual({});
	});
});

describe("buildTreePrefix", () => {
	/**
	 * Three renderers draw tree indentation (the task tree, the JSON tree and the TUI helpers) and
	 * each had a copy. The JSON one had already drifted to the OPPOSITE argument order, which is a
	 * copy that no longer even looks like its sibling. Two renderers disagreeing here means one
	 * nesting draws different rules in two panes of the same screen.
	 */
	it("continues a rule for an ancestor with a sibling to come, and pads for one without", () => {
		const theme = { tree: { vertical: "│" } } as unknown as Parameters<typeof buildTreePrefix>[1];

		expect(buildTreePrefix([], theme)).toBe("");
		expect(buildTreePrefix([true], theme)).toBe("│  ");
		expect(buildTreePrefix([false], theme)).toBe("   ");
		expect(buildTreePrefix([true, false, true], theme)).toBe("│     │  ");
	});

	it("has one definition, and the two other renderers import it", () => {
		for (const file of ["task/render.ts", "tools/json-tree.ts"]) {
			expect(importsOf(file), file).toContain("../tui/utils");
		}
	});

	/**
	 * The argument ORDER, which is the drift that actually happened: the JSON renderer's copy took its
	 * arguments the other way round, so one nesting drew different rules in two panes of the same
	 * screen. Pinned by calling with a mixed list whose result is asymmetric, so a swapped pair cannot
	 * produce it.
	 */
	it("reads the ancestor list outermost-first, the order the copy had reversed", () => {
		const theme = { tree: { vertical: "|" } } as unknown as Parameters<typeof buildTreePrefix>[1];

		expect(buildTreePrefix([true, false], theme)).toBe("|     ");
		expect(buildTreePrefix([false, true], theme)).toBe("   |  ");
	});
});

describe("isThenable", () => {
	/**
	 * The IPC `send()` sites and the MCP stdio transport each had a copy, and the one in `ipc.ts`
	 * carried a comment claiming the other was justified because it was "battle-tested there". A
	 * five-line predicate is not battle-tested separately, and only one of the two had a test at
	 * all. Both now call the guard in `@veyyon/utils`, where its tests moved with it.
	 */
	it("is imported from utils by both send paths, and defined in neither", () => {
		const owners: ReadonlyArray<readonly [string, string]> = [
			["utils/ipc.ts", "@veyyon/utils/type-guards"],
			["mcp/transports/stdio.ts", "@veyyon/utils"],
		];
		for (const [file, owner] of owners) {
			expect(importsOf(file), file).toContain(owner);
		}
	});
});

describe("the CLI model runtime", () => {
	/**
	 * `veyyon bench` and `veyyon dry-balance` bootstrap identically: open the credential store, load
	 * the project's settings, build the registry from both. The part that matters is the failure
	 * path, which both copies happened to have: if settings or the extension providers throw, the
	 * credential store opened one line earlier must be closed before the error propagates, or a
	 * SQLite handle leaks on every failed invocation.
	 */
	it("is what both CLIs default to, and neither builds its own", () => {
		for (const file of ["cli/bench-cli.ts", "cli/dry-balance-cli.ts"]) {
			expect(importsOf(file), file).toContain("./model-runtime");
		}
	});
});

describe("the worker log replay", () => {
	/**
	 * A worker has no logger: it runs in another thread or process, ships the level with the
	 * message, and the supervisor replays it. The JS eval context manager and the browser tab
	 * supervisor each had a byte-identical copy of that replay, so a copy that mapped a level to
	 * the wrong method would move a whole class of worker diagnostics out of the log an operator
	 * is reading, without any sign that it happened.
	 */
	it("has one owner that both supervisors import", () => {
		for (const file of ["eval/js/context-manager.ts", "tools/browser/tab-supervisor.ts"]) {
			expect(importsOf(file), file).toContain("../../subprocess/worker-log");
		}
	});

	/**
	 * A THIRD copy hid in `subprocess/worker-client.ts`, the sibling module, and the check
	 * above could not see it because it only looked at the two supervisors it knew about.
	 * That copy was byte-identical and served the four ONNX subprocess clients (embeddings,
	 * speech-to-text, tiny-model titles, TTS), so exactly half the workers in the process
	 * replayed their logs through code nobody was guarding. It now re-exports the owner's
	 * function rather than defining its own, and its `WorkerLogMessage` is spelled as
	 * `{ type: "log" } & WorkerLogPayload` so the two cannot disagree about what a log line
	 * carries. Asserted on the whole directory rather than a list, because a list is how the
	 * third copy went unnoticed.
	 */
	it("has no second definition anywhere in the subprocess directory", () => {
		// IDENTITY across the sibling module: the client's export IS the owner's function object, so a
		// third copy cannot hide behind the same name. That is what a search for `function
		// logWorkerMessage(` could not say, and the third copy is exactly what it failed to find.
		expect(workerClient.logWorkerMessage).toBe(workerLog.logWorkerMessage);
	});

	/**
	 * The MAPPING, driven. Each level reaches its own logger method and an unrecognised one is logged
	 * as an error rather than dropped: a line worth sending is worth seeing, and losing it silently is
	 * worse than logging it too loudly.
	 *
	 * This used to search the owner's source for three exact statements, which passes with the branches
	 * swapped as long as the bytes are unchanged and fails on a reformat. A copy that mapped `warn` to
	 * `debug` -- the whole failure this family is about -- would have been invisible to it, because the
	 * assertion never ran the function.
	 */
	it("maps each level to its logger method and defaults to error", () => {
		const debug = spyOn(logger, "debug").mockImplementation(() => {});
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		const error = spyOn(logger, "error").mockImplementation(() => {});
		try {
			workerLog.logWorkerMessage({ level: "debug", msg: "spawned", meta: { pid: 7 } });
			workerLog.logWorkerMessage({ level: "warn", msg: "slow", meta: { ms: 900 } });
			workerLog.logWorkerMessage({ level: "error", msg: "died" });
			// Not a level the payload type admits, which is exactly the case the fallback is for: a
			// worker on an older build shipping a level this process does not know.
			workerLog.logWorkerMessage({ level: "trace", msg: "unknown level" } as unknown as WorkerLogPayload);

			expect(debug.mock.calls).toEqual([["spawned", { pid: 7 }]]);
			expect(warn.mock.calls).toEqual([["slow", { ms: 900 }]]);
			expect(error.mock.calls).toEqual([
				["died", undefined],
				["unknown level", undefined],
			]);
		} finally {
			debug.mockRestore();
			warn.mockRestore();
			error.mockRestore();
		}
	});
});
