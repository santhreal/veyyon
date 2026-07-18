import { afterAll, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient } from "@veyyon/coding-agent/modes/rpc/rpc-client";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

// The spawned CLI must never resolve the developer's real ~/.veyyon: a real
// defaultProfile or a legacy-layout conflict there aborts startup before the
// "Unknown provider" path under test. RpcClient merges options.env over
// Bun.env, so VEYYON_PROFILE is pinned to explicit-empty (forces default mode)
// rather than relying on deletion.
const spawnEnv = hermeticSpawnEnv({ VEYYON_PROFILE: "", VEYYON_NO_TITLE: "1" });
afterAll(() => spawnEnv.cleanup());

describe("RpcClient.start", () => {
	test("rejects when RPC process exits immediately", async () => {
		using client = new RpcClient({
			cliPath: path.join(import.meta.dir, "..", "src", "cli.ts"),
			cwd: path.join(import.meta.dir, ".."),
			provider: "__missing_provider__",
			model: "claude-sonnet-4-5",
			env: spawnEnv.env as Record<string, string>,
		});

		await expect(client.start()).rejects.toThrow(/Unknown provider.*__missing_provider__/);
	});
});
