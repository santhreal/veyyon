import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	asRecord,
	errorMessage,
	getNonBlankStringProperty,
	getStringProperty,
	isRecord,
	toError,
} from "../src/type-guards";

describe("isRecord / asRecord", () => {
	it("accepts plain objects only", () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(Object.create(null))).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(42)).toBe(false);
	});

	it("asRecord returns the value or null", () => {
		const obj = { a: 1 };
		expect(asRecord(obj)).toBe(obj);
		expect(asRecord([1, 2])).toBeNull();
		expect(asRecord(undefined)).toBeNull();
	});
});

describe("toError / errorMessage", () => {
	it("toError passes Errors through and wraps everything else", () => {
		const err = new Error("boom");
		expect(toError(err)).toBe(err);
		expect(toError("oops").message).toBe("oops");
		expect(toError(7)).toBeInstanceOf(Error);
	});

	it("errorMessage extracts .message from Errors and stringifies the rest", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
		expect(errorMessage("plain string")).toBe("plain string");
		expect(errorMessage(404)).toBe("404");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});

describe("getStringProperty / getNonBlankStringProperty", () => {
	it("returns string values and rejects everything else", () => {
		expect(getStringProperty({ a: "x" }, "a")).toBe("x");
		expect(getStringProperty({ a: "" }, "a")).toBe("");
		expect(getStringProperty({ a: 1 }, "a")).toBeUndefined();
		expect(getStringProperty({}, "a")).toBeUndefined();
	});

	it("getNonBlankStringProperty treats blank strings as absent but keeps original whitespace", () => {
		expect(getNonBlankStringProperty({ a: " x " }, "a")).toBe(" x ");
		expect(getNonBlankStringProperty({ a: "" }, "a")).toBeUndefined();
		expect(getNonBlankStringProperty({ a: "   " }, "a")).toBeUndefined();
		expect(getNonBlankStringProperty({ a: 0 }, "a")).toBeUndefined();
	});
});

// Repo-wide source locks: these guards have exactly ONE owner,
// packages/utils/src/type-guards.ts. Local copies drift (the isRecord sweep
// found copies that accepted arrays; the errorMessage sweep found seven
// byte-identical copies). Convert a file, remove its entry — a stale entry
// fails the lock so each list can only shrink.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");
const OWNER = "utils/src/type-guards.ts";

// launch/protocol.ts is a deliberately dependency-free cross-process protocol
// module (zero imports) and keeps a self-contained guard. The rest are
// remaining local copies owned by in-flight work on those files — import
// isRecord from @veyyon/utils when that work lands. Shrink-only.
const ISRECORD_ALLOWED = new Set([
	"coding-agent/src/launch/protocol.ts",
	"agent/src/compaction/compaction-v2-streaming.ts",
	"ai/src/providers/openai-reasoning-fallback.ts",
	"ai/src/registry/oauth/xai-oauth.ts",
	"coding-agent/src/config/settings.ts",
	"coding-agent/src/discovery/claude-plugins.ts",
	"coding-agent/src/export/share.ts",
	"coding-agent/src/extensibility/plugins/legacy-pi-compat.ts",
	"coding-agent/src/harness/model-profile.ts",
	"coding-agent/src/mcp/startup-events.ts",
	"coding-agent/src/session/agent-session.ts",
	"coding-agent/src/task/executor.ts",
	"utils/src/runtime-install.ts",
]);

// Remaining local errorMessage copies, owned by in-flight work on these
// files; import errorMessage from @veyyon/utils when that work lands.
const ERRORMESSAGE_GRANDFATHERED = new Set([
	"coding-agent/src/cli/gc-cli.ts",
	"coding-agent/src/subprocess/worker-runtime.ts",
	"coding-agent/src/task/worktree.ts",
]);

// Inline `X instanceof Error ? X.message : String(X)` sites remaining after the
// 2026-07 codemod converted every settled file to errorMessage(). These are
// lane-hot files (plus hashline/collab-web, which have no @veyyon/utils dep and
// keep local ternaries deliberately). Convert a file, remove its entry. Shrink-only.
const INLINE_ERRORMESSAGE_GRANDFATHERED = new Set([
	"agent/src/agent-loop.ts",
	"agent/src/compaction/compaction-v2-streaming.ts",
	"ai/src/auth-gateway/server.ts",
	"ai/src/auth-storage.ts",
	"ai/src/providers/anthropic-messages-server.ts",
	"ai/src/providers/anthropic.ts",
	"ai/src/providers/gitlab-duo-workflow.ts",
	"ai/src/providers/openai-codex-responses.ts",
	"ai/src/providers/openai-responses-server.ts",
	"ai/src/providers/pi-native-server.ts",
	"ai/src/registry/oauth/xai-oauth.ts",
	"coding-agent/src/autoresearch/tools/init-experiment.ts",
	"coding-agent/src/autoresearch/tools/log-experiment.ts",
	"coding-agent/src/cli/auth-broker-cli.ts",
	"coding-agent/src/cli/auth-gateway-cli.ts",
	"coding-agent/src/cli/gc-cli.ts",
	"coding-agent/src/cli/grep-cli.ts",
	"coding-agent/src/cli/shell-cli.ts",
	"coding-agent/src/cli/ssh-cli.ts",
	"coding-agent/src/cli.ts",
	"coding-agent/src/cli/update-cli.ts",
	"coding-agent/src/cli/worktree-cli.ts",
	"coding-agent/src/commands/gallery.ts",
	"coding-agent/src/commands/profile.ts",
	"coding-agent/src/commands/say.ts",
	"coding-agent/src/commit/agentic/index.ts",
	"coding-agent/src/debug/log-viewer.ts",
	"coding-agent/src/debug/raw-sse.ts",
	"coding-agent/src/eval/agent-bridge.ts",
	"coding-agent/src/eval/jl/kernel.ts",
	"coding-agent/src/eval/js/context-manager.ts",
	"coding-agent/src/eval/rb/kernel.ts",
	"coding-agent/src/exa/mcp-client.ts",
	"coding-agent/src/export/share.ts",
	"coding-agent/src/extensibility/custom-commands/bundled/review/index.ts",
	"coding-agent/src/extensibility/custom-commands/loader.ts",
	"coding-agent/src/extensibility/custom-tools/loader.ts",
	"coding-agent/src/extensibility/hooks/loader.ts",
	"coding-agent/src/extensibility/legacy-pi-coding-agent-shim.ts",
	"coding-agent/src/extensibility/plugins/manager.ts",
	"coding-agent/src/hindsight/state.ts",
	"coding-agent/src/internal-urls/issue-pr-protocol.ts",
	"coding-agent/src/internal-urls/local-protocol.ts",
	"coding-agent/src/internal-urls/mcp-protocol.ts",
	"coding-agent/src/internal-urls/vault-protocol.ts",
	"coding-agent/src/lsp/client.ts",
	"coding-agent/src/lsp/index.ts",
	"coding-agent/src/mcp/manager.ts",
	"coding-agent/src/modes/components/agent-hub.ts",
	"coding-agent/src/modes/components/session-selector.ts",
	"coding-agent/src/modes/components/settings-selector.ts",
	"coding-agent/src/modes/controllers/command-controller.ts",
	"coding-agent/src/modes/controllers/input-controller.ts",
	"coding-agent/src/modes/controllers/mcp-command-controller.ts",
	"coding-agent/src/modes/controllers/omfg-rule.ts",
	"coding-agent/src/modes/controllers/selector-controller.ts",
	"coding-agent/src/modes/controllers/todo-command-controller.ts",
	"coding-agent/src/modes/interactive-mode.ts",
	"coding-agent/src/modes/setup-wizard/scenes/sign-in.ts",
	"coding-agent/src/modes/setup-wizard/scenes/theme.ts",
	"coding-agent/src/modes/utils/context-usage.ts",
	"coding-agent/src/modes/utils/ui-helpers.ts",
	"coding-agent/src/repair/schema-repair.ts",
	"coding-agent/src/sdk.ts",
	"coding-agent/src/session/agent-session.ts",
	"coding-agent/src/session/agent-storage.ts",
	"coding-agent/src/slash-commands/builtin-registry.ts",
	"coding-agent/src/stt/recorder.ts",
	"coding-agent/src/stt/stt-controller.ts",
	"coding-agent/src/subprocess/worker-client.ts",
	"coding-agent/src/subprocess/worker-runtime.ts",
	"coding-agent/src/task/executor.ts",
	"coding-agent/src/task/index.ts",
	"coding-agent/src/task/worktree.ts",
	"coding-agent/src/tools/acp-bridge.ts",
	"coding-agent/src/tools/bash.ts",
	"coding-agent/src/tools/browser/tab-supervisor.ts",
	"coding-agent/src/tools/browser/tab-worker.ts",
	"coding-agent/src/tools/fetch.ts",
	"coding-agent/src/tools/grep.ts",
	"coding-agent/src/tools/output-meta.ts",
	"coding-agent/src/tools/read.ts",
	"coding-agent/src/tools/write.ts",
	"coding-agent/src/tts/models.ts",
	"coding-agent/src/tts/speech-enhancer.ts",
	"coding-agent/src/tts/streaming-player.ts",
	"coding-agent/src/tts/tts-client.ts",
	"coding-agent/src/utils/tools-manager.ts",
	"coding-agent/src/vibe/runtime.ts",
	"coding-agent/src/web/scrapers/hackernews.ts",
	"coding-agent/src/web/scrapers/spotify.ts",
	"coding-agent/src/web/scrapers/types.ts",
	"coding-agent/src/web/search/providers/ecosia.ts",
	"coding-agent/src/web/search/providers/google.ts",
	"coding-agent/src/web/search/providers/mojeek.ts",
	"collab-web/src/lib/client.ts",
	"hashline/src/patcher.ts",
	"metaharness/src/runner.ts",
	"mnemopi/src/diagnose.ts",
	"tui/src/desktop-notify.ts",
	"tui/src/terminal.ts",
	"utils/src/dirs.ts",
	"utils/src/ptree.ts",
	"utils/src/type-guards.ts",
]);
const INLINE_ERRORMESSAGE = /instanceof Error \? \w+\.message : String\(/;

const ISRECORD_DEF = /function\s+isRecord\s*\(/;
const ERRORMESSAGE_DEF = /function\s+errorMessage\s*\(/;

async function walk(dir: string, out: string[]): Promise<void> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walk(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

async function sourceFiles(): Promise<string[]> {
	const files: string[] = [];
	for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!pkg.isDirectory()) continue;
		try {
			await walk(path.join(PACKAGES_DIR, pkg.name, "src"), files);
		} catch {
			// Package without a src/ directory (assets-only) — nothing to scan.
		}
	}
	return files;
}

describe("type-guards source locks", () => {
	it("no production source defines a local isRecord or errorMessage outside the owner", async () => {
		const isRecordOffenders: string[] = [];
		const errorMessageOffenders: string[] = [];
		const isRecordSeen = new Set<string>();
		const errorMessageSeen = new Set<string>();
		const inlineOffenders: string[] = [];
		const inlineSeen = new Set<string>();
		for (const file of await sourceFiles()) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === OWNER) continue;
			const text = await readFile(file, "utf8");
			if (ISRECORD_DEF.test(text)) {
				isRecordSeen.add(rel);
				if (!ISRECORD_ALLOWED.has(rel)) isRecordOffenders.push(rel);
			}
			if (ERRORMESSAGE_DEF.test(text)) {
				errorMessageSeen.add(rel);
				if (!ERRORMESSAGE_GRANDFATHERED.has(rel)) errorMessageOffenders.push(rel);
			}
			if (INLINE_ERRORMESSAGE.test(text)) {
				inlineSeen.add(rel);
				if (!INLINE_ERRORMESSAGE_GRANDFATHERED.has(rel)) inlineOffenders.push(rel);
			}
		}
		// protocol.ts is permanently allowed; every other allowed entry must shrink away.
		const cleared = [
			...[...ERRORMESSAGE_GRANDFATHERED].filter(rel => !errorMessageSeen.has(rel)),
			...[...INLINE_ERRORMESSAGE_GRANDFATHERED].filter(rel => rel !== OWNER && !inlineSeen.has(rel)),
			...[...ISRECORD_ALLOWED].filter(
				rel => rel !== "coding-agent/src/launch/protocol.ts" && !isRecordSeen.has(rel),
			),
		];
		expect(isRecordOffenders, "new local isRecord copies — import it from @veyyon/utils instead").toEqual([]);
		expect(errorMessageOffenders, "new local errorMessage copies — import it from @veyyon/utils instead").toEqual([]);
		expect(
			inlineOffenders,
			"new inline `instanceof Error ? .message : String(...)` — call errorMessage from @veyyon/utils instead",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose local copy is gone — remove them from the list").toEqual([]);
	});
});
