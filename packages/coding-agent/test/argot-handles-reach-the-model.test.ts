/**
 * Does the handle table actually reach the model?
 *
 * Every other argot test certifies a PIECE of the path: `lexpack-integration`
 * proves that a handle table passed as `argotHandles` lands in the prompt under
 * its own banner, and `argot-cache` proves a repository resolves to a generated
 * vocabulary. Neither one joins the two, and the join is where the feature
 * actually lives.
 *
 * WHY THIS FILE EXISTS. The first interpretable bench run of the encode arm
 * (`deepswe-bench/runs/argot-smoke-0724`) loaded 551 handles and the model then
 * emitted ZERO of them. The recorded system prompt taught the notation and
 * carried no handle at all: the only section-sign bytes in 85kB of prompt
 * belonged to the preamble's invented `§dbconn` example. That prompt also tells
 * the model, in the same breath, to "never invent one that has not been defined
 * for you". A model shown notation, shown no handles, and forbidden to invent
 * any has exactly one compliant move, which is the one it made.
 *
 * That left one question that reading the code could not settle, because the
 * transcript only ever snapshots `session_init` (which is written BEFORE the
 * background arm completes): does the handle table reach the model on the
 * refresh, or never at all? These tests answer it by running the real arm
 * (`armArgotAfterStartup`) against a real git fixture and rebuilding the prompt
 * through the exact expression `sdk.ts` uses, rather than by asserting on a
 * hand-written fixture table that cannot expose a wiring gap.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { armArgotAfterStartup } from "@veyyon/coding-agent/lexpack-cache";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	ARGOT_HANDLES_BANNER,
	RUNTIME_SECTIONS,
	withSectionBanner,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-blocks";
import { TempDir } from "@veyyon/utils";
import { ArgotSession, renderPreamble } from "argot";
import { useIsolatedConfigRoot } from "./helpers/isolated-agent-dir";

useIsolatedConfigRoot();

const HANDLES_SECTION = RUNTIME_SECTIONS.find(section => section.id === "shorthand-handles");

/**
 * A repository whose repeated-token mass is the kind argot exists to compress:
 * long import paths an agent retypes constantly. Written across several files so
 * the generator sees genuine repetition rather than one file's local noise.
 */
const REPEATED = [
	"github.com/k14s/starlark-go/starlark",
	"github.com/vmware-tanzu/carvel-ytt/pkg/yamlmeta",
	"github.com/vmware-tanzu/carvel-ytt/pkg/template/core",
];

function makeRepo(root: string): void {
	for (let file = 0; file < 12; file++) {
		const body = REPEATED.flatMap(dep => [`import "${dep}"`, `// see ${dep} for details`, `use(${dep})`]).join("\n");
		fs.writeFileSync(path.join(root, `pkg${file}.go`), `package main\n\n${body}\n`);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "test");
	git("add", "-A");
	git("commit", "-qm", "fixture");
}

describe("the argot handle table reaches the model after the background arm", () => {
	let tempDir: TempDir;
	let root: string;
	let argot: ArgotSession;
	let handlesLoaded = 0;
	let armedPrompt: string[] = [];
	let onArmedFired = false;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@veyyon-argot-reaches-model-");
		root = tempDir.path();
		makeRepo(root);
		argot = new ArgotSession();

		// The real startup arm, with the same 16000-token budget the bench's encode
		// arm runs. `onArmed` rebuilds the prompt through the SAME expression
		// sdk.ts uses at its build site, so a wiring gap there shows up here.
		await armArgotAfterStartup({
			argot,
			cwd: root,
			tokenBudget: 16000,
			onResolved: vocab => {
				handlesLoaded = vocab.handles;
			},
			onArmed: async () => {
				onArmedFired = true;
				const built = await buildSystemPrompt({
					cwd: root,
					contextFiles: [],
					skills: [],
					rules: [],
					toolNames: [],
					workspaceTree: { rootPath: root, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
					argotPreamble: renderPreamble({ tools: true }),
					// Byte-for-byte the sdk.ts expression under test.
					argotHandles: argot.loaded ? argot.promptFragment() : undefined,
				});
				armedPrompt = built.systemPrompt;
			},
		});
	}, 120_000);

	afterAll(async () => {
		await tempDir.remove();
	});

	it("generates a non-empty vocabulary from the fixture repository", () => {
		// Guards every assertion below: with an empty dictionary the arm short
		// circuits before `onArmed`, and a green "no handles leaked" result would
		// mean nothing. This is the fixture's own health check.
		expect(handlesLoaded).toBeGreaterThan(0);
		expect(argot.loaded).toBe(true);
	});

	it("fires onArmed, which is what triggers the prompt refresh", () => {
		// `armArgotAfterStartup` only calls `onArmed` when `handles > 0`. In the
		// session this callback IS `refreshBaseSystemPrompt`, so if it never fires
		// the model keeps the unarmed startup prompt for the whole run.
		expect(onArmedFired).toBe(true);
	});

	it("promptFragment returns a real table, not an empty string", () => {
		// The load path could mark the vocabulary decode-only (`teach: false`), in
		// which case the session reports `loaded` and a positive handle count while
		// teaching nothing. That failure is invisible at the call site because
		// `argot.loaded` is still true, so it is pinned separately here.
		const fragment = argot.promptFragment();
		expect(fragment.length).toBeGreaterThan(0);
		expect(fragment).toContain("§");
	});

	it("puts the handle table in the rebuilt prompt under its own banner", () => {
		// The end-to-end claim: after the arm, the prompt the model receives
		// carries the table as a real section. Asserted through `withSectionBanner`
		// (the assembler's own owner) so it proves placement, not mere substring
		// presence somewhere in 85kB of text.
		expect(HANDLES_SECTION?.banner).toBe("SHORTHAND HANDLES\n==");
		expect(armedPrompt).toContain(withSectionBanner(HANDLES_SECTION as never, argot.promptFragment()));
	});

	it("teaches at least one handle the fixture repository actually produced", () => {
		// The regression the smoke run exposed, stated in its own terms: the
		// rebuilt prompt must contain a handle bound to one of the repeated import
		// paths. A prompt that teaches notation and zero real handles passes every
		// other argot test in the suite and is exactly the failure being locked out.
		const table = argot.vocabulary().handles;
		const taught = [...table].filter(([, expansion]) => REPEATED.includes(expansion));
		expect(taught.length).toBeGreaterThan(0);

		const joined = armedPrompt.join("\n\n");
		for (const [name, expansion] of taught) {
			expect(joined).toContain(name);
			expect(joined).toContain(expansion);
		}
	});

	it("is detectable by the exact banner constant the arm's probe tests for", () => {
		// The arm records whether teaching succeeded by searching the rebuilt prompt
		// for `ARGOT_HANDLES_BANNER`, and the bench reads that record to decide
		// whether a `0 encoded` run is a model result or a harness failure. If the
		// constant and the assembler's banner ever drift apart, the probe reports
		// "no handles taught" on a perfectly armed session and the bench blames the
		// harness for nothing. This pins the constant to the section that owns it
		// AND to the bytes that actually land in a real armed prompt.
		expect(ARGOT_HANDLES_BANNER).toBe(HANDLES_SECTION?.banner);
		expect(armedPrompt.join("\n\n")).toContain(ARGOT_HANDLES_BANNER);
	});

	it("teaches more section-sign occurrences than the preamble's example alone", () => {
		// The smoke run's prompt had exactly 4 section signs, all of them the
		// preamble's invented `§dbconn` illustration. That count is the signature
		// of the bug, so it is asserted directly: an armed prompt must carry
		// substantially more, because every taught handle contributes one.
		const joined = armedPrompt.join("\n\n");
		const sigils = (joined.match(/§/g) ?? []).length;
		const preambleSigils = (renderPreamble({ tools: true }).match(/§/g) ?? []).length;
		expect(sigils).toBeGreaterThan(preambleSigils);
		expect(sigils).toBeGreaterThanOrEqual(preambleSigils + handlesLoaded);
	});
});
