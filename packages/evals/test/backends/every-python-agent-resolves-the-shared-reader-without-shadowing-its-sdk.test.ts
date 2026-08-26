/**
 * WHY THIS SUITE EXISTS.
 *
 * The defect it closes: an agent module reaching the shared attachment reader by putting the
 * agents root at the front of `sys.path`. Each backend directory under `agents/` is named
 * after the SDK that backend imports -- `agents/pier` and the `pier` distribution,
 * `agents/harbor` and the `harbor` distribution -- and both directories are Python packages.
 * A prepended agents root therefore resolves `import pier` to `agents/pier`, and the agent
 * runs against a directory of adapters instead of the SDK. Harbor's SDK import sits in a
 * `try` block with local fallbacks, so that substitution produces an agent that imports,
 * reports nothing wrong, and is not driving the harness at all.
 *
 * The class, not the incident: this suite does not check one module's import line. It sweeps
 * every `*_agent.py` under every backend directory in `agents/`, imports it the way its
 * run-time import root does, and asserts three properties of whatever it loaded -- the SDK
 * came from outside the agents tree, the shared reader came from `agents/common`, and nothing
 * came from another backend's directory. A new backend directory or a new agent module joins
 * the sweep with no edit here, and an agent that cannot be imported at all is a failure rather
 * than a skip.
 *
 * The SDK is not installed in this tree, so it is generated per case as a stub whose shape is
 * parsed out of the agent module's own import statements, and appended to `sys.path` where the
 * interpreter would find an installed distribution. That is a substitute for the SDK, never for
 * the module under test: the agent file imported is the shipped one.
 *
 * What it does not catch: that the SDK surface the agent calls exists in the real
 * distribution, and anything past import time -- a stub class satisfies `except` and
 * subclassing but runs no SDK behavior.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentsDir } from "../../src/paths";

const AGENTS_ROOT = agentsDir();
const SHARED_READER = path.join(AGENTS_ROOT, "common", "arm_attachments.py");
const IMPORT_TIMEOUT_MS = 60_000;

/**
 * Imports one agent module against a generated SDK, and reports where each module it pulled in
 * came from. The stub tree is written from the module's own `from <sdk>.… import …` statements,
 * so it tracks the SDK surface the module actually names.
 */
const DRIVER = `
import ast, json, pathlib, sys, tempfile

target = pathlib.Path(sys.argv[1])
sdk = sys.argv[2]
agent_dir = str(target.parent)

wanted: dict[str, set[str]] = {}
for node in ast.walk(ast.parse(target.read_text(encoding="utf-8"))):
    if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
        if node.module.split(".")[0] == sdk:
            wanted.setdefault(node.module, set()).update(alias.name for alias in node.names)
    elif isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name.split(".")[0] == sdk:
                wanted.setdefault(alias.name, set())

stub_root = pathlib.Path(tempfile.mkdtemp(prefix="sdk-stub-"))
PREAMBLE = (
    "class _Stub:\\n"
    "    def __init__(self, *a, **k):\\n        pass\\n"
    "    def __call__(self, *a, **k):\\n        return self\\n"
)
for module, names in sorted(wanted.items()):
    directory = stub_root
    for part in module.split("."):
        directory = directory / part
        directory.mkdir(exist_ok=True)
        init = directory / "__init__.py"
        if not init.exists():
            init.write_text(PREAMBLE, encoding="utf-8")
    init = directory / "__init__.py"
    body = init.read_text(encoding="utf-8")
    for name in sorted(names):
        body += f'{name} = type("{name}", (_Stub, Exception), {{}})\\n'
    init.write_text(body, encoding="utf-8")

# The order an agent is imported in: its own directory first, as the runner's PYTHONPATH puts
# it, then the distributions. A bootstrap that prepends the agents root lands ahead of both.
sys.path.insert(0, agent_dir)
sys.path.append(str(stub_root))

__import__(target.stem)

loaded = {
    name: getattr(module, "__file__", None)
    for name, module in sorted(sys.modules.items())
    if getattr(module, "__file__", None)
}

# Where the SDK name resolves for the rest of this process, asked of the path itself rather
# than the import cache: an agent that already loaded the SDK cannot see its own sys.path
# edits, but every later import in the same interpreter can.
from importlib.machinery import PathFinder

found = PathFinder.find_spec(sdk, sys.path)
locations = list(getattr(found, "submodule_search_locations", None) or [])
resolves_to = getattr(found, "origin", None) or (locations[0] if locations else None)

print(
    json.dumps(
        {
            "sdk": loaded.get(sdk),
            "sdkResolvesTo": resolves_to,
            "shared": loaded.get("common.arm_attachments"),
            "stubRoot": str(stub_root),
            "files": sorted(set(loaded.values())),
        }
    )
)
`;

interface ImportReport {
	readonly sdk: string | null;
	readonly sdkResolvesTo: string | null;
	readonly shared: string | null;
	readonly stubRoot: string;
	readonly files: readonly string[];
}

/** Every backend directory under `agents/`, and the agent modules each one ships. */
function agentModules(): readonly { readonly backend: string; readonly file: string }[] {
	const found: { backend: string; file: string }[] = [];
	for (const backend of fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })) {
		if (!backend.isDirectory() || backend.name === "common" || backend.name === "__pycache__") continue;
		const dir = path.join(AGENTS_ROOT, backend.name);
		for (const entry of fs.readdirSync(dir)) {
			if (entry.endsWith("_agent.py")) found.push({ backend: backend.name, file: path.join(dir, entry) });
		}
	}
	return found;
}

function importAgent(file: string, sdk: string): ImportReport {
	const result = spawnSync("python3", ["-c", DRIVER, file, sdk], {
		encoding: "utf8",
		timeout: IMPORT_TIMEOUT_MS,
	});
	// A missing interpreter is a hole in the sweep, not a reason to skip: these agents are the
	// only way this package reaches a container, and they are Python.
	if (result.error !== undefined) throw new Error(`python3 unavailable: ${result.error.message}`);
	expect(result.signal, `${path.basename(file)} import did not terminate`).toBeNull();
	if (result.status !== 0) throw new Error(`${path.basename(file)} failed to import:\n${result.stderr}`);
	return JSON.parse(result.stdout) as ImportReport;
}

describe("every python agent resolves the shared reader without shadowing its sdk", () => {
	const modules = agentModules();

	it("finds an agent module under every backend directory in the agents root", () => {
		const backends = [...new Set(modules.map((m) => m.backend))].sort();
		expect(backends).toEqual(["harbor", "pier"]);
		expect(modules.length).toBeGreaterThanOrEqual(backends.length);
	});

	for (const { backend, file } of modules) {
		const label = `${backend}/${path.basename(file)}`;

		it(`imports ${label} with its sdk resolved outside the agents tree`, () => {
			const report = importAgent(file, backend);
			// The SDK name and the backend directory name are the same string, so this is the
			// assertion a prepended agents root breaks.
			expect(report.sdk, `${label} did not import the ${backend} sdk at all`).not.toBeNull();
			expect(report.sdk?.startsWith(report.stubRoot)).toBe(true);
			expect(report.sdk?.startsWith(AGENTS_ROOT)).toBe(false);
		});

		it(`leaves the ${backend} sdk resolvable after importing ${label}`, () => {
			const report = importAgent(file, backend);
			// The module is imported before its own bootstrap can matter, so the cache hides a
			// prepended agents root from the agent itself and shows it to every later import.
			expect(report.sdkResolvesTo, `${backend} became unresolvable after ${label}`).not.toBeNull();
			expect(report.sdkResolvesTo?.startsWith(report.stubRoot)).toBe(true);
			expect(report.sdkResolvesTo?.startsWith(AGENTS_ROOT)).toBe(false);
		});

		it(`reads attachments in ${label} through the shared module, if it reads them`, () => {
			const report = importAgent(file, backend);
			if (report.shared === null) return;
			expect(report.shared).toBe(SHARED_READER);
		});

		it(`imports nothing in ${label} from another backend's directory`, () => {
			const report = importAgent(file, backend);
			const ownDir = path.join(AGENTS_ROOT, backend);
			const commonDir = path.join(AGENTS_ROOT, "common");
			const foreign = report.files.filter(
				(f) => f.startsWith(AGENTS_ROOT) && !f.startsWith(ownDir) && !f.startsWith(commonDir),
			);
			expect(foreign).toEqual([]);
		});
	}
});
