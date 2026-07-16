import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const ENV_MODULE = path.resolve(import.meta.dir, "../src/env.ts");

/**
 * The VEYYON_/OMP_ → PI_ mirror runs at env-module import time, so each case
 * spawns a fresh bun that imports the module and prints the resolved values.
 */
async function resolveInSubprocess(
	env: Record<string, string>,
	keys: string[],
): Promise<Record<string, string | undefined>> {
	const script = `const { $env } = await import(${JSON.stringify(ENV_MODULE)}); console.log(JSON.stringify(${JSON.stringify(keys)}.map(k => $env[k])));`;
	const proc = Bun.spawn(["bun", "-e", script], {
		env: { ...process.env, ...env },
		cwd: import.meta.dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode, stderr).toBe(0);
	const values: (string | null)[] = JSON.parse(stdout.trim().split("\n").at(-1)!);
	return Object.fromEntries(keys.map((k, i) => [k, values[i] ?? undefined]));
}

describe("process-env VEYYON_/OMP_ → PI_ alias mirror", () => {
	it("mirrors a VEYYON_ process-env var onto its PI_ legacy name", async () => {
		const out = await resolveInSubprocess({ VEYYON_ALIAS_MIRROR_PROBE: "from-veyyon" }, [
			"VEYYON_ALIAS_MIRROR_PROBE",
			"PI_ALIAS_MIRROR_PROBE",
		]);
		expect(out.VEYYON_ALIAS_MIRROR_PROBE).toBe("from-veyyon");
		expect(out.PI_ALIAS_MIRROR_PROBE).toBe("from-veyyon");
	});

	it("mirrors an OMP_ process-env var onto its PI_ legacy name", async () => {
		const out = await resolveInSubprocess({ OMP_ALIAS_MIRROR_PROBE: "from-omp" }, ["PI_ALIAS_MIRROR_PROBE"]);
		expect(out.PI_ALIAS_MIRROR_PROBE).toBe("from-omp");
	});

	it("VEYYON_ wins over OMP_ and an explicit PI_ value when all are set", async () => {
		const out = await resolveInSubprocess(
			{
				VEYYON_ALIAS_MIRROR_PROBE: "from-veyyon",
				OMP_ALIAS_MIRROR_PROBE: "from-omp",
				PI_ALIAS_MIRROR_PROBE: "from-pi",
			},
			["PI_ALIAS_MIRROR_PROBE"],
		);
		expect(out.PI_ALIAS_MIRROR_PROBE).toBe("from-veyyon");
	});

	it("leaves a PI_-only var untouched", async () => {
		const out = await resolveInSubprocess({ PI_ALIAS_MIRROR_PROBE: "from-pi" }, [
			"PI_ALIAS_MIRROR_PROBE",
			"VEYYON_ALIAS_MIRROR_PROBE",
		]);
		expect(out.PI_ALIAS_MIRROR_PROBE).toBe("from-pi");
		expect(out.VEYYON_ALIAS_MIRROR_PROBE).toBeUndefined();
	});
});
