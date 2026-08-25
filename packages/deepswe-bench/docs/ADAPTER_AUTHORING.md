# Authoring DeepSWE System Adapters

This guide specifies how to author and register a new agent system adapter in the `@veyyon/deepswe-bench` evaluation harness.

## Architecture

A system adapter bridges two layers:

1. **TypeScript Runner Layer (`src/systems/`)**: Handles CLI dispatch, preflight verification, asset staging, and Pier configuration generation.
2. **Python Container Layer (`pier_agent/`)**: Runs inside the Docker container spawned by Pier, translates task instructions into agent executions, and collects metadata.

```
+-------------------------------------------------------------+
| TypeScript Runner (src/systems/ & src/runner/)             |
|  - validatePreflight({ system, model, args, dryRun })       |
|  - stageAssets({ system, assetsDir, outRoot, binarySha })   |
|  - buildJobConfigKwargs({ system, task, repeat, ... })      |
+------------------------------+------------------------------+
                               |
                               | mounts assets & invokes Pier
                               v
+-------------------------------------------------------------+
| Pier Container Execution (pier_agent/)                      |
|  - SystemAgentClass(BaseAgent)                              |
|    - run(task) -> executes agent CLI/runtime                |
|    - extract_patch() -> saves /logs/artifacts/model.patch   |
|    - populate_context_post_run() -> records session metrics |
+-------------------------------------------------------------+
```

## Existing adapters

| Adapter | Binary | Pier agent | Replay | Compaction | Arm attachments |
|---|---|---|---|---|---|
| veyyon | `vey` | `veyyon_agent:VeyyonAgent` | yes | yes | yes |
| omp | `cli.js` | `omp_agent:OmpAgent` | no | no | no |
| factory | `droid` | `factory_agent:FactoryAgent` | yes | yes | no |
| hermes | (native) | `hermes_agent:HermesAgent` | yes | yes | no |

## Step 1: Implement the TypeScript Adapter

Create `src/systems/adapters/<name>.ts` implementing the `SystemAdapter` interface from `src/systems/types.ts`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import type {
    SystemAdapter,
    SystemJobConfigContext,
    SystemPreflightContext,
    SystemPreflightResult,
    SystemStageContext,
} from "../types";

export class MySystemAdapter implements SystemAdapter {
    readonly name = "mysystem";
    readonly displayName = "My System";
    readonly pierAgentImport = "mysystem_agent:MySystemAgent";
    readonly description = "Adapter for MySystem evaluation";
    readonly supportsReplay = false;
    readonly supportsCompaction = false;
    readonly supportsArmAttachments = false;
    readonly defaultModel = "my-provider/my-model";
    readonly containerAssetsDir = "/opt/mysystem-assets";

    validatePreflight(context: SystemPreflightContext): SystemPreflightResult {
        const errors: string[] = [];
        const warnings: string[] = [];
        // Check required binaries or environment credentials
        return { valid: errors.length === 0, errors, warnings };
    }

    stageAssets(context: SystemStageContext): void {
        // Copy binary, config, or credential files into context.assetsDir
    }

    buildJobConfigKwargs(context: SystemJobConfigContext): Record<string, unknown> {
        const kwargs: Record<string, unknown> = {
            assets_dir: context.assetsDir,
            binary_sha: context.binarySha ?? "nosha",
        };
        if (context.replayPath) {
            kwargs.replay_path = context.replayPath;
        }
        if (context.promptTemplatePath) {
            kwargs.prompt_template_path = context.promptTemplatePath;
        }
        return kwargs;
    }
}

export const mySystemAdapter = new MySystemAdapter();
```

### SystemAdapter interface fields

| Field | Type | Purpose |
|---|---|---|
| `name` | `string` | Unique identifier used in `--arms` |
| `displayName` | `string` | Human-readable name for reports |
| `pierAgentImport` | `string` | Python import path (`module:Class`) |
| `description` | `string` | One-line description |
| `supportsReplay` | `boolean` | Whether the adapter supports replay manifests |
| `supportsCompaction` | `boolean` | Whether the adapter supports compaction replay |
| `supportsArmAttachments` | `boolean` | Whether the adapter accepts arm attachment files |
| `defaultModel` | `string` | Default model if `--model` is not specified |
| `containerAssetsDir` | `string` | Path inside the container where assets are mounted |

### SystemStageContext fields

| Field | Type | Purpose |
|---|---|---|
| `assetsDir` | `string` | Host directory for staged assets |
| `outRoot` | `string` | Run output root directory |
| `binarySha` | `string \| null` | SHA256 of the pinned binary |
| `args` | `Record<string, unknown>` | CLI arguments |
| `model` | `string` | Model selector (e.g. `opencode-go/deepseek-v4-flash`) |

## Step 2: Implement the Python Pier Agent

Create `pier_agent/<name>_agent.py` subclassing `BaseInstalledAgent`:

```python
from __future__ import annotations
import shlex
from pathlib import Path
from typing import ClassVar

from model_catalog_bootstrap import build_status_preserving_tee_command
from pier.agents.installed.base import BaseInstalledAgent
from pier.agents.network import allowlist_from_urls
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.install import AgentInstallSpec, InstallStep

CONTAINER_ASSETS_DIR = "/opt/mysystem-assets"


class MySystemAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str:
        return "mysystem"

    def __init__(self, *args, assets_dir: str = "", binary_sha: str = "nosha", **kwargs):
        self._assets_dir = assets_dir
        self._binary_sha = binary_sha
        super().__init__(*args, **kwargs)

    def install_spec(self) -> AgentInstallSpec:
        return AgentInstallSpec(
            agent_name="mysystem",
            cache_key=f"mysystem-{self._binary_sha[:16]}",
            steps=[InstallStep(user="agent", run="true")],
        )

    def network_allowlist(self):
        return allowlist_from_urls([], default_domains=[".my-provider.com"])

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name:
            raise ValueError("MySystemAgent requires --model (provider/model-id)")
        instruction = self.render_instruction(instruction)
        await environment.exec(command=f"mkdir -p {CONTAINER_ASSETS_DIR}", user="root")
        # Upload assets, invoke agent CLI, capture session
        agent_command = f"{CONTAINER_ASSETS_DIR}/myagent --model {shlex.quote(self.model_name)} --print {shlex.quote(instruction)}"
        logged = build_status_preserving_tee_command(agent_command, "/logs/agent/mysystem.txt")
        await self.exec_as_agent(environment, command=logged)

    def populate_context_post_run(self, context: AgentContext) -> None:
        # Parse session JSONL for token usage, cost, and tool calls
        # Set context.n_input_tokens, context.n_output_tokens, context.cost_usd, context.metadata
        pass
```

### Network allowlists

Agents run inside Docker containers with egress proxies. The `network_allowlist()` method returns a list of allowed domains. Common patterns:

- `.opencode.ai` — OpenCode API and models.dev metadata
- `.models.dev` — Model metadata overlay
- `.github.com` — Git operations (clone, fetch)
- `public.ecr.aws` — Docker image pulls for task environments

### Model resolution

For dynamically-discovered models not in the agent's bundled catalog, the adapter's `stageAssets()` method can generate a static model definition file. The omp adapter demonstrates this pattern: it uses the veyvon binary's `models refresh --json` output (which includes the models.dev overlay) to generate a `models.yml` with full metadata (contextWindow, maxTokens, reasoning), then stages it into the container. See `src/systems/adapters/omp.ts` `buildModelsYml()` for the implementation.

## Step 3: Register the Adapter

Register in `src/systems/registry.ts`:

```typescript
import { mySystemAdapter } from "./adapters/mysystem";

REGISTRY.set(mySystemAdapter.name, mySystemAdapter);
```

Also export it from `src/systems/index.ts`:

```typescript
export * from "./adapters/mysystem";
```

## Step 4: Verification

1. Run TypeScript unit tests: `bash scripts/test-sandbox/run.sh bun test packages/deepswe-bench`
2. Run Python unit tests: `python3 -m unittest discover -s packages/deepswe-bench/pier_agent -p "*_test.py"`
3. Execute dry run: `bun run.ts --arms veyyon,mysystem --dry-run`
4. Run a smoke test: `bun run.ts --arms mysystem --tasks tasks/smoke.txt --jobs 1`
