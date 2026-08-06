import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { APP_NAME, getPythonGatewayDir, setAgentDir } from "@veyyon/utils/dirs";
import { Snowflake } from "@veyyon/utils/snowflake";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "./helpers/isolated-config-root";

describe("python gateway directory", () => {
	let tempRoot = "";
	let isolated: IsolatedConfigRoot;
	let originalXdgStateHome: string | undefined;

	beforeEach(async () => {
		originalXdgStateHome = process.env.XDG_STATE_HOME;
		// `enterIsolatedConfigRoot` rather than a hand-rolled VEYYON_CONFIG_DIR plus
		// `setAgentDir(original)` restore, which is what this suite used to do.
		// `setAgentDir` WRITES `VEYYON_CODING_AGENT_DIR`, and restoring through it
		// cannot restore "the variable was unset": the suite exported the
		// developer's real agent dir to every file that ran after it in the same
		// process. `scripts/test-sandbox/find-test-leaks.ts` reported it.
		isolated = enterIsolatedConfigRoot("dirs-python-gateway", { defaultProfile: true });
		tempRoot = path.join(isolated.root, "gateway-fixture", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(() => {
		if (originalXdgStateHome === undefined) {
			delete process.env.XDG_STATE_HOME;
		} else {
			process.env.XDG_STATE_HOME = originalXdgStateHome;
		}
		// Restores every managed variable to the value it had, deletes the root, and
		// re-derives the resolver from the restored environment.
		isolated.restore();
	});

	it("uses XDG state for the default agent profile", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, APP_NAME), { recursive: true });

		// The default profile's agent dir inside the isolated root, which is what the
		// resolver itself would answer with no override in force.
		const defaultAgentDir = path.join(isolated.root, "profiles", "default", "agent");
		setAgentDir(defaultAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(process.env.XDG_STATE_HOME, APP_NAME, "python-gateway"));
	});

	it("keeps custom agent profiles isolated from XDG shared state", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
		await fs.mkdir(path.join(process.env.XDG_STATE_HOME, APP_NAME), { recursive: true });
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getPythonGatewayDir()).toBe(path.join(customAgentDir, "python-gateway"));
	});
});
