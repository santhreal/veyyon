import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runOllamaLane } from "../scripts/bench-title-models";
import { TempDir } from "@veyyon/utils";

const roots: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map(root => root.remove()));
});

async function fixture(replacement: string, marker: string) {
	const root = TempDir.createSync("title-bench-provider-boundary-");
	roots.push(root);
	const cwd = root.join("project");
	const agentDir = root.join("profile", "agent");
	const globalConfigRoot = root.join("global");
	await Promise.all([fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true }), fs.mkdir(agentDir, { recursive: true })]);
	const declarations = path.join(cwd, ".veyyon", "secrets.yml");
	const writeDeclaration = (nextReplacement: string) =>
		fs.writeFile(
			declarations,
			`- type: plain\n  content: ${marker}\n  mode: replace\n  replacement: ${nextReplacement}\n`,
		);
	await writeDeclaration(replacement);
	return {
		writeDeclaration,
		runtime: { cwd, agentDir, globalConfigRoot, enabled: true },
	};
}

describe("title-model benchmark provider boundary", () => {
	it("reloads the live runtime and sanitizes before middle truncation for every Ollama attempt", async () => {
		// The long marker crosses preprocessTinyMessage's 2/3 head boundary. Sanitizing afterward
		// would leave its distinctive start/end fragments on the wire; replacing it first also makes
		// the prompt short enough that the current replacement survives whole.
		const marker = `BENCH_BOUNDARY_START_${"R".repeat(700)}_BENCH_BOUNDARY_END`;
		const raw = `${"a".repeat(1_200)}${marker}${"b".repeat(400)}`;
		const { runtime, writeDeclaration } = await fixture("BENCH_FIRST_PLACEHOLDER", marker);
		const bodies: string[] = [];
		spyOn(globalThis, "fetch").mockImplementation(
			(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(String(init?.body));
				if (bodies.length === 1) await writeDeclaration("BENCH_CURRENT_PLACEHOLDER");
				return new Response(JSON.stringify({ message: { content: "<title>Safe title</title>" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}) as unknown as typeof fetch,
		);

		await runOllamaLane(
			"http://ollama.invalid",
			"test-model",
			[
				{ id: 1, raw, input: "local-only-input" },
				{ id: 2, raw, input: "local-only-input" },
			],
			runtime,
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain("BENCH_FIRST_PLACEHOLDER");
		expect(bodies[1]).toContain("BENCH_CURRENT_PLACEHOLDER");
		for (const body of bodies) {
			expect(body).not.toContain(marker);
			expect(body).not.toContain("BENCH_BOUNDARY_START");
			expect(body).not.toContain("BENCH_BOUNDARY_END");
		}
	});

	it("does not quote an Ollama response body in provider errors", async () => {
		const marker = "BENCH_ERROR_SECRET_RESPONSE_94721";
		const { runtime } = await fixture("BENCH_ERROR_PLACEHOLDER", marker);
		spyOn(globalThis, "fetch").mockResolvedValue(new Response(marker, { status: 500 }));

		let message = "";
		try {
			await runOllamaLane(
				"http://ollama.invalid",
				"test-model",
				[{ id: 1, raw: marker, input: marker }],
				runtime,
			);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toBe("Ollama request failed with status 500");
		expect(message).not.toContain(marker);
	});
});
