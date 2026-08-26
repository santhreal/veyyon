# Authoring a harness adapter

A harness is one member of the harness axis: an agent system that executes tasks. Adding one means
writing a TypeScript adapter, registering it, and — for a harness that runs on the Pier or Harbor
backend — writing the Python agent class that backend imports inside the container.

## The two layers

```
+-------------------------------------------------------------+
| TypeScript adapter (src/harnesses/adapters/<name>.ts)       |
|  - preflight(HarnessPreflightContext) -> PreflightVerdict   |
|  - stageAssets(HarnessStageContext | SystemStageContext)    |
|  - backends: which backends it runs on, and how             |
+------------------------------+------------------------------+
                               |
                               | stages assets, writes the job config
                               v
+-------------------------------------------------------------+
| Container agent (agents/pier/<name>_agent.py)               |
|  - run(instruction, environment, context)                   |
|  - populate_context_post_run(context)                       |
+-------------------------------------------------------------+
```

`packages/evals/src/core/types.ts` declares `HarnessAdapter`. `packages/evals/src/harnesses/index.ts`
holds the registration list. `packages/evals/agents/pier/` and `packages/evals/agents/harbor/` hold
the container agents.

## Registered harnesses

| Harness | Capabilities | Pier import path | Harbor agent |
|---|---|---|---|
| `veyyon` | replay, compaction, arm attachments, prompt overrides | `veyyon_agent:VeyyonAgent` | `veyyon` |
| `omp` | none | `omp_agent:OmpAgent` | — |
| `factory` | replay, compaction | `factory_agent:FactoryAgent` | — |
| `hermes` | replay, compaction | `hermes_agent:HermesAgent` | — |

## Step 1: the TypeScript adapter

Create `packages/evals/src/harnesses/adapters/<name>.ts`:

```typescript
import type {
	HarnessAdapter,
	HarnessCapabilities,
	HarnessPreflightContext,
	HarnessStageContext,
	PreflightVerdict,
} from "../../core/types";
import { type SystemJobConfigContext, type SystemStageContext, sanitizeVariantName } from "../types";

export class MyHarnessAdapter implements HarnessAdapter {
	readonly name = "myharness";
	readonly displayName = "My Harness";
	readonly description = "MyHarness CLI execution in an isolated container.";
	readonly defaultModel = "my-provider/my-model";

	readonly capabilities: HarnessCapabilities = {
		replay: false,
		compaction: false,
		armAttachments: false,
		promptOverrides: false,
	};

	readonly backends = {
		pier: {
			agentImportPath: "myharness_agent:MyHarnessAgent",
			containerAssetsDir: "/opt/myharness-assets",
		},
	} as const;

	async preflight(context: HarnessPreflightContext): Promise<PreflightVerdict> {
		const missing: string[] = [];
		// Resolve binaries and credentials the harness needs; name each one that is absent.
		if (missing.length > 0) {
			return { ok: false, reason: `myharness is not runnable: ${missing.join(", ")}`, missingRequirements: missing };
		}
		return { ok: true };
	}

	async stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> {
		// A HarnessStageContext carries `targetDir` and a variant; keep staged paths variant-keyed
		// so two variants of the same harness never overwrite each other.
		if ("targetDir" in context) {
			const destDir = path.join(context.targetDir, sanitizeVariantName(context.variant.name));
			fs.mkdirSync(destDir, { recursive: true });
			return;
		}
		// A SystemStageContext carries the DeepSWE run's `assetsDir`, `outRoot` and `binarySha`.
	}

	buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
		return { assets_dir: context.assetsDir, binary_sha: context.binarySha ?? "nosha" };
	}
}

export const myHarnessAdapter = new MyHarnessAdapter();
```

### HarnessAdapter

| Member | Type | Purpose |
|---|---|---|
| `name` | `string` | Identifier used in `--arms` and `--harnesses` |
| `displayName` | `string` | Label used in reports |
| `description` | `string` | One-line description |
| `defaultModel` | `string \| null` | Model used when a run names none; `null` requires `--model` |
| `capabilities` | `HarnessCapabilities` | `replay`, `compaction`, `armAttachments`, `promptOverrides`; all four are stated, and `armAttachments`/`promptOverrides` decide whether a run may vary those axes |
| `backends` | `Partial<Record<BackendId, HarnessBackendBinding>>` | The backends this harness runs on |
| `preflight` | `(HarnessPreflightContext) => Promise<PreflightVerdict>` | Refuses before a run when the harness is not runnable |
| `stageAssets` | `(HarnessStageContext \| SystemStageContext) => void` | Writes binaries, configs and credentials the container reads |
| `validatePreflight` | optional `(SystemPreflightContext) => SystemPreflightResult` | The DeepSWE runner's per-arm preflight |
| `buildJobConfigKwargs` | optional `(SystemJobConfigContext) => Record<string, unknown>` | kwargs written into the Pier job config |

A harness that declares no `defaultModel` rejects a run that names no model rather than measuring an
unstated one.

### HarnessBackendBinding

| Field | Purpose |
|---|---|
| `agentImportPath` | `module:Class` the backend imports. Required for the Pier backend: the DeepSWE runner rejects a Pier run of a harness that states none |
| `agentName` | Name a backend's CLI selects the harness by (`harbor run --agent <name>`); defaults to `name` |
| `containerAssetsDir` | Path inside the container where staged assets are mounted |
| `envVars`, `cliFlags`, `extra` | Backend-specific extras |

The binding is the only declaration of these facts. A run plan for a (harness, suite) pair whose
backend is absent from `backends` fails with `UnboundHarnessBackendError` naming all three.

### Staging contexts

`HarnessStageContext` is the generic path: `variant`, `targetDir`, `backend`, `options`.
`SystemStageContext` is the DeepSWE runner's path: `system`, `assetsDir`, `outRoot`, `binarySha`,
`args`, `model`. Discriminate on `"targetDir" in context`.

## Step 2: the container agent

Create `packages/evals/agents/pier/<name>_agent.py` subclassing `BaseInstalledAgent`:

```python
from __future__ import annotations

import shlex
from typing import ClassVar

from model_catalog_bootstrap import build_status_preserving_tee_command
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

CONTAINER_ASSETS_DIR = "/opt/myharness-assets"


class MyHarnessAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str:
        return "myharness"

    def __init__(self, *args, assets_dir: str = "", binary_sha: str = "nosha", **kwargs):
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        super().__init__(*args, **kwargs)

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name=self.name(),
            cache_key=f"myharness-{self._binary_sha[:16]}",
            steps=[InstallStep(user="agent", run="true")],
        )

    def network_allowlist(self):
        return allowlist_from_urls([], default_domains=[".my-provider.com"])

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name:
            raise ValueError("MyHarnessAgent requires --model (provider/model-id)")
        instruction = self.render_instruction(instruction)
        command = f"{CONTAINER_ASSETS_DIR}/myharness --model {shlex.quote(self.model_name)} --print {shlex.quote(instruction)}"
        logged = build_status_preserving_tee_command(command, "/logs/agent/myharness.txt")
        await self.exec_as_agent(environment, command=logged)

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Parse the session log for token usage, cost and tool calls, then set
        # context.n_input_tokens, context.n_output_tokens, context.cost_usd and context.metadata.
        ...
```

The kwargs the constructor accepts are exactly the keys `buildJobConfigKwargs` returns.

### Network allowlists

Agents run inside containers behind an egress proxy. `network_allowlist()` returns the allowed
domains. The ones already in use:

- `.opencode.ai` — OpenCode API and models.dev metadata
- `.models.dev` — model metadata overlay
- `.github.com` — git clone and fetch
- `public.ecr.aws` — container image pulls for task environments

### Model resolution

A model the harness's bundled catalog does not carry is supplied as a staged file. `stageAssets` in
`src/harnesses/adapters/omp.ts` runs `vey models refresh --json`, which includes the models.dev
overlay, and writes a `models.yml` carrying `contextWindow`, `maxTokens` and reasoning metadata into
the container assets directory. `buildModelsYml` in that file is the implementation.

## Step 3: registration

Add the adapter to `packages/evals/src/harnesses/index.ts`:

```typescript
import { myHarnessAdapter } from "./adapters/myharness";

export * from "./adapters/myharness";

export const builtinHarnesses = [veyyonAdapter, ompAdapter, factoryAdapter, hermesAdapter, myHarnessAdapter] as const;
```

`registerBuiltinHarnesses()` registers every entry of `builtinHarnesses` in the shared registry, and
is idempotent. Registration is a list in source, never a directory scan.

## Step 4: verification

```sh
bash scripts/test-sandbox/run.sh bun test packages/evals/test/harnesses
python3 -m unittest discover -s packages/evals/agents/pier -p "*_test.py"
bun packages/evals/src/suites/deep-swe/run.ts --arms veyyon,myharness --dry-run
bun packages/evals/src/suites/deep-swe/run.ts --arms myharness --tasks datasets/deep-swe/tasks/pilot-10.txt --jobs 1
```

`test/harnesses/every-harness-states-which-backends-it-runs-on.test.ts` sweeps the registry at run
time: a new harness turns it red until its (harness, suite) backend decisions are recorded there.
