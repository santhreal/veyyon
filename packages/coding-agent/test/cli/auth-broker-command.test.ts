/**
 * `veyyon auth-broker` offline e2e: status without a broker, the provider
 * catalog listing, and bearer-token stability (same token across calls,
 * new token only with --regenerate).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const cliPath = path.resolve(import.meta.dir, "../../src/cli.ts");

function makeEnv(home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...process.env, HOME: home, NO_COLOR: "1" };
	delete env.VEYYON_AUTH_BROKER_URL;
	delete env.VEYYON_AUTH_BROKER_URL;
	for (const key of ["VEYYON_CODING_AGENT_DIR", "VEYYON_CONFIG_DIR", "VEYYON_PROFILE"]) {
		delete env[key];
	}
	return env;
}

async function runBroker(
	env: Record<string, string | undefined>,
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["bun", cliPath, "auth-broker", ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("veyyon auth-broker offline", () => {
	it("status without a configured broker explains how to enable one", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-broker-home-")));
		const { stdout, exitCode } = await runBroker(env, ["status"]);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("No auth-broker configured");
		expect(stdout).toContain("VEYYON_AUTH_BROKER_URL");
	}, 30_000);

	it("list --json returns the OAuth provider catalog", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-broker-home-")));
		const { stdout, exitCode } = await runBroker(env, ["list", "--json"]);
		expect(exitCode).toBe(0);
		const providers = JSON.parse(stdout) as { id: string; name: string }[];
		expect(providers.length).toBeGreaterThan(10);
		const ids = providers.map(provider => provider.id);
		expect(ids).toContain("anthropic");
		expect(ids).toContain("openai-codex");
		for (const provider of providers) {
			expect(typeof provider.id).toBe("string");
			expect(typeof provider.name).toBe("string");
		}
	}, 30_000);

	it("token is stable across calls and --regenerate mints a new one", async () => {
		const env = makeEnv(mkdtempSync(path.join(tmpdir(), "veyyon-broker-home-")));
		const first = await runBroker(env, ["token"]);
		expect(first.exitCode).toBe(0);
		const token = first.stdout.trim();
		expect(token.length).toBeGreaterThan(20);
		const second = await runBroker(env, ["token"]);
		expect(second.stdout.trim()).toBe(token);
		const regenerated = await runBroker(env, ["token", "--regenerate"]);
		expect(regenerated.exitCode).toBe(0);
		expect(regenerated.stdout.trim()).not.toBe(token);
	}, 30_000);
});
