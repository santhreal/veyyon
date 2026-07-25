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
 * This suite covers the families unified so far:
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
 *    needed. Both are shared across package
 *    boundaries, so the owner is the package that already owns the concept: `@veyyon/wire` for the
 *    envelope, beside the header length it reads, and `@veyyon/utils` for the byte coercion.
 *  - `buildTreePrefix`, drawn by three renderers, one of which had drifted to the opposite argument
 *    order; `isThenable`, whose two copies came with a comment justifying one of them; and the CLI
 *    model-runtime bootstrap, whose copies both had to close the credential store on failure.
 *
 * Each family gets its behaviour asserted at the new owner AND a source check that the copies are gone,
 * because the behaviour tests alone would keep passing if someone reintroduced a copy.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryReadHeadSha } from "@veyyon/coding-agent/autoresearch/git";
import { canonicalProjectDir } from "@veyyon/coding-agent/launch/paths";
import { formatProviderName } from "@veyyon/coding-agent/slash-commands/helpers/format";
import { buildTreePrefix } from "@veyyon/coding-agent/tui/utils";
import { branch } from "@veyyon/coding-agent/utils/git";
import { parseJsonOrYamlByExtension, TempDir } from "@veyyon/utils";

const SRC = path.join(import.meta.dir, "../../src");

async function source(relative: string): Promise<string> {
	return await Bun.file(path.join(SRC, relative)).text();
}

/** A source file in a sibling package, for the families shared across package boundaries. */
async function packageSource(relative: string): Promise<string> {
	return await Bun.file(path.join(SRC, "../..", relative)).text();
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

	it("is defined once, and the two launch callers import it", async () => {
		const paths = await source("launch/paths.ts");
		expect(paths.match(/export async function canonicalProjectDir/g)).toHaveLength(1);

		for (const file of ["launch/client.ts", "launch/presence.ts"]) {
			const text = await source(file);
			expect(text).not.toContain("async function canonicalProjectDir(");
			expect(text).toContain("canonicalProjectDir");
			expect(text).toContain('from "./paths"');
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

	it("is what both config readers call, and neither defines its own", async () => {
		for (const file of ["lsp/config.ts", "dap/config.ts"]) {
			const text = await source(file);
			expect(text).toContain("parseJsonOrYamlByExtension(");
			expect(text).not.toContain("function parseConfigContent(");
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

	it("is defined once and imported by all three surfaces", async () => {
		const format = await source("slash-commands/helpers/format.ts");
		expect(format.match(/export function formatProviderName/g)).toHaveLength(1);

		for (const file of [
			"slash-commands/helpers/usage-report.ts",
			"cli/usage-cli.ts",
			"modes/controllers/command-controller.ts",
		]) {
			const text = await source(file);
			expect(text).not.toContain("function formatProviderName(provider: string)");
			expect(text).toContain("formatProviderName");
		}
	});
});

describe("assertUniqueCanonicalPaths", () => {
	/**
	 * The hashline patcher owns it, because it owns `PreparedSection`. The coding agent's edit path had a
	 * byte-identical copy, message and all, so the two could have disagreed about whether a patch naming
	 * one file twice is an error, and the second write would have silently discarded the first.
	 */
	it("lives in the hashline package, not in the coding agent's copy", async () => {
		const patcher = await Bun.file(path.join(SRC, "../../hashline/src/patcher.ts")).text();
		const execute = await source("edit/hashline/execute.ts");

		expect(patcher.match(/export function assertUniqueCanonicalPaths/g)).toHaveLength(1);
		expect(execute).not.toContain("function assertUniqueCanonicalPaths(");
		expect(execute).toContain("assertUniqueCanonicalPaths");
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
	it("goes through the shared owner, and no private copy remains", async () => {
		for (const file of ["dap/client.ts", "dap/session.ts"]) {
			const text = await source(file);
			expect(text).not.toContain("function toErrorMessage(");
			expect(text).toContain("errorMessage(");
			expect(text).toContain('from "@veyyon/utils"');
		}
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

	it("is defined once in autoresearch/git.ts and imported by both experiment tools", async () => {
		const git = await source("autoresearch/git.ts");
		expect(git.match(/export async function tryReadHeadSha/g)).toHaveLength(1);

		for (const file of ["autoresearch/tools/init-experiment.ts", "autoresearch/tools/log-experiment.ts"]) {
			const text = await source(file);
			expect(text).not.toContain("async function tryReadHeadSha(");
			expect(text).toContain("tryReadHeadSha");
			expect(text).toContain('from "../git"');
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
			const text = await source(file);
			expect(text).not.toContain("async function getCurrentBranch(");
			expect(text).toContain("git.branch.currentOrHead(");
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
	it("is defined once in render-utils, and the LSP renderer imports it", async () => {
		const renderUtils = await source("tools/render-utils.ts");
		const lspRender = await source("lsp/render.ts");

		expect(renderUtils.match(/export function sanitizeDiagnosticDisplayText/g)).toHaveLength(1);
		expect(lspRender).not.toContain("function sanitizeDiagnosticDisplayText(");
		expect(lspRender).toContain("sanitizeDiagnosticDisplayText,");
	});
});

describe("the browser tab target id", () => {
	/**
	 * The supervisor hands the worker a target id and the worker matches its own targets against it, so
	 * the two sides MUST derive it identically: one reading puppeteer's private field while the other
	 * asked CDP would let a tab be addressed under two ids, and a command would land on no tab at all.
	 * Both had a private copy of both functions.
	 */
	it("is derived by one module that both sides import", async () => {
		const owner = await source("tools/browser/target-id.ts");
		expect(owner.match(/export async function targetIdForTarget/g)).toHaveLength(1);
		expect(owner.match(/export async function targetIdForPage/g)).toHaveLength(1);

		for (const file of ["tools/browser/tab-supervisor.ts", "tools/browser/tab-worker.ts"]) {
			const text = await source(file);
			expect(text).not.toContain("async function targetIdForTarget(");
			expect(text).not.toContain("async function targetIdForPage(");
			expect(text).toContain('from "./target-id"');
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
	it("is coded by @veyyon/wire, which both the host and the browser guest re-export", async () => {
		const wire = await packageSource("wire/src/index.ts");
		expect(wire.match(/export function packEnvelope/g)).toHaveLength(1);
		expect(wire.match(/export function unpackEnvelope/g)).toHaveLength(1);
		expect(wire.match(/export function rewriteEnvelopePeer/g)).toHaveLength(1);

		for (const file of ["coding-agent/src/collab/protocol.ts", "collab-web/src/lib/link.ts"]) {
			const text = await packageSource(file);
			expect(text).not.toContain("export function packEnvelope(");
			expect(text).not.toContain("export function unpackEnvelope(");
			expect(text).not.toContain("export function rewriteEnvelopePeer(");
			expect(text).toContain('export { packEnvelope, rewriteEnvelopePeer, unpackEnvelope } from "@veyyon/wire";');
		}
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
	it("is defined once in @veyyon/utils, and every crypto call site imports it", async () => {
		const owner = await packageSource("utils/src/bytes.ts");
		expect(owner.match(/export function asStrictBytes/g)).toHaveLength(1);

		// The two collab modules that used to need it are no longer call sites: their sealing moved to
		// `@veyyon/wire`, which is dependency-free, and the copies both slices there need are
		// unconditional (neither spans its own buffer), so a plain `new Uint8Array` is identical.
		for (const file of ["ai/src/providers/aws-sigv4.ts", "ai/src/auth-broker/snapshot-cache.ts"]) {
			const text = await packageSource(file);
			expect(text).not.toContain("function asStrict(");
			expect(text).toContain("asStrictBytes");
		}
	});

	/**
	 * Where it IS imported outside a Bun-only graph, it must come from the submodule rather than the
	 * barrel: the `@veyyon/utils` barrel re-exports Bun-only modules, and pulling it into a browser
	 * bundle fails that build outright. `packages/utils/test/browser-safe-barrel.test.ts` enforces this
	 * for every browser-graph root; this pins the one call site that reaches it from a signing path.
	 */
	it("is reached through the submodule where the barrel would be wrong", async () => {
		const sigv4 = await packageSource("ai/src/providers/aws-sigv4.ts");

		expect(sigv4).toContain('import { asStrictBytes } from "@veyyon/utils/bytes";');
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
	it("is implemented once in @veyyon/wire, with each side binding only its frame type", async () => {
		const wire = await packageSource("wire/src/index.ts");
		expect(wire.match(/export async function sealFrame/g)).toHaveLength(1);
		expect(wire.match(/export async function openFrame/g)).toHaveLength(1);
		expect(wire.match(/export const SEAL_IV_BYTES/g)).toHaveLength(1);

		for (const file of ["coding-agent/src/collab/crypto.ts", "collab-web/src/lib/codec.ts"]) {
			const text = await packageSource(file);
			expect(text).not.toContain("AES-GCM");
			expect(text).not.toContain("crypto.subtle");
			expect(text).not.toContain("getRandomValues");
			expect(text).toContain('from "@veyyon/wire"');
		}
	});

	/**
	 * `@veyyon/wire` has no dependencies, which is what lets the browser guest import it directly. The
	 * seal was the one thing that looked like it needed `@veyyon/utils`, so this fails if a dependency
	 * appears rather than waiting for a browser build to break.
	 */
	it("did not give @veyyon/wire a dependency", async () => {
		const manifest = JSON.parse(await packageSource("wire/package.json")) as {
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

	it("has one definition, and the two other renderers import it", async () => {
		const owner = await source("tui/utils.ts");
		expect(owner.match(/export function buildTreePrefix/g)).toHaveLength(1);

		for (const file of ["task/render.ts", "tools/json-tree.ts"]) {
			const text = await source(file);
			expect(text).not.toContain("function buildTreePrefix(");
			expect(text).toContain("buildTreePrefix");
		}
	});

	/** It takes a readonly array, so a caller holding one does not copy it to call the owner. */
	it("accepts a readonly ancestor list", async () => {
		const owner = await source("tui/utils.ts");

		expect(owner).toContain("ancestors: readonly boolean[]");
	});
});

describe("isThenable", () => {
	/**
	 * The IPC `send()` sites and the MCP stdio transport each had a copy, and the one in `ipc.ts`
	 * carried a comment claiming the other was justified because it was "battle-tested there". A
	 * five-line predicate is not battle-tested separately, and only one of the two had a test at
	 * all. Both now call the guard in `@veyyon/utils`, where its tests moved with it.
	 */
	it("is imported from utils by both send paths, and defined in neither", async () => {
		for (const file of ["utils/ipc.ts", "mcp/transports/stdio.ts"]) {
			const text = await source(file);

			expect(text).not.toContain("function isThenable(");
			expect(text).toContain("isThenable");
			expect(text).toContain("@veyyon/utils");
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
	it("has one owner that closes the credential store when the bootstrap fails", async () => {
		const owner = await source("cli/model-runtime.ts");

		expect(owner.match(/export async function createCliModelRuntime/g)).toHaveLength(1);
		expect(owner).toContain("authStorage.close();\n\t\tthrow error;");
	});

	it("is what both CLIs default to, and neither builds its own", async () => {
		for (const file of ["cli/bench-cli.ts", "cli/dry-balance-cli.ts"]) {
			const text = await source(file);

			expect(text).not.toContain("async function createDefaultRuntime(");
			expect(text).toContain("deps.createRuntime ?? createCliModelRuntime");
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
	it("has one owner that both supervisors import", async () => {
		const owner = await source("subprocess/worker-log.ts");
		expect(owner.match(/export function logWorkerMessage/g)).toHaveLength(1);

		for (const file of ["eval/js/context-manager.ts", "tools/browser/tab-supervisor.ts"]) {
			const text = await source(file);

			expect(text).not.toContain("function logWorkerMessage(");
			expect(text).toContain('from "../../subprocess/worker-log"');
		}
	});

	/**
	 * The owner takes a structural message rather than one worker's union, because the two
	 * supervisors define their own `WorkerOutbound`. An unrecognised level logs as an error
	 * rather than vanishing: a line worth sending is worth seeing.
	 */
	it("maps each level to its logger method and defaults to error", async () => {
		const owner = await source("subprocess/worker-log.ts");

		expect(owner).toContain('if (msg.level === "debug") logger.debug(msg.msg, msg.meta);');
		expect(owner).toContain('else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);');
		expect(owner).toContain("else logger.error(msg.msg, msg.meta);");
	});
});
