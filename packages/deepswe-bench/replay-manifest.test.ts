import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadReplayManifest } from "./replay-manifest";
import { COMPARISON_MODEL } from "./system-comparison";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function manifestFile(change: Record<string, unknown> = {}): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "deepswe-replay-"));
	roots.push(root);
	const file = path.join(root, "trial.json");
	fs.writeFileSync(path.join(root, "source.jsonl"), "{}\n");
	fs.mkdirSync(path.join(root, "worktree"));
	const manifest = {
		schema_version: 1,
		model: COMPARISON_MODEL,
		source_session_id: "real-session-1",
		source_session_artifacts: [path.join(root, "source.jsonl")],
		repository_checkpoint: path.join(root, "worktree"),
		repository_checkpoint_sha256: "a".repeat(64),
		compaction_checkpoint: {
			after_user_turn: 2,
			source_boundary_id: "compact-42",
			source_threshold_tokens: 100_000,
			source_context_tokens: 100_500,
		},
		user_turns: [
			{ id: "u1", content: "first real user turn" },
			{ id: "u2", content: "second real user turn" },
		],
		held_out_continuation: { id: "u3", content: "held-out original continuation" },
		...change,
	};
	fs.writeFileSync(file, JSON.stringify(manifest));
	return file;
}

describe("real-session replay manifest", () => {
	test("loads exact absolute-path bytes and a 1-based compaction boundary", () => {
		const file = manifestFile();
		const loaded = loadReplayManifest(file);

		expect(loaded.path).toBe(file);
		expect(loaded.bytes).toEqual(fs.readFileSync(file));
		expect(loaded.sha256).toHaveLength(64);
		expect(loaded.manifest.compaction_checkpoint.after_user_turn).toBe(2);
		expect(loaded.manifest.held_out_continuation.id).toBe("u3");
	});

	test("rejects assistant/tool transcript imports rather than filtering them", () => {
		const file = manifestFile({
			user_turns: [{ id: "u1", content: "user", role: "assistant", tool_calls: [] }],
			compaction_checkpoint: {
				after_user_turn: 1,
				source_boundary_id: "compact-42",
				source_threshold_tokens: 100_000,
				source_context_tokens: 100_500,
			},
		});

		expect(() => loadReplayManifest(file)).toThrow(/unsupported key "role"/);
		expect(() => loadReplayManifest(file)).toThrow(/unsupported key "tool_calls"/);
	});

	test("rejects relative artifacts, model fallback, and a non-boundary checkpoint", () => {
		const file = manifestFile({
			model: "fallback-model",
			source_session_artifacts: ["relative/session.jsonl"],
			repository_checkpoint: "relative/worktree",
			compaction_checkpoint: {
				after_user_turn: 3,
				source_boundary_id: "compact-42",
				source_threshold_tokens: 100_000,
				source_context_tokens: 90_000,
			},
		});

		expect(() => loadReplayManifest(file)).toThrow(/model must be exactly/);
		expect(() => loadReplayManifest(file)).toThrow(/absolute path/);
		expect(() => loadReplayManifest(file)).toThrow(/meet or exceed the actual compaction threshold/);
		expect(() => loadReplayManifest(file)).toThrow(/must equal the frozen replay prefix length/);
	});
});
