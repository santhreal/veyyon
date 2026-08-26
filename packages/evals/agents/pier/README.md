# Pier Agent Runtime Environment

Python agent adapters invoked inside Docker containers by Pier during DeepSWE evaluations. Each adapter subclasses `BaseInstalledAgent` from `pier.agents.installed.base` and implements the agent execution lifecycle for its target binary.

## Adapters

| File | Agent | Binary | Output file |
|---|---|---|---|
| `veyyon_agent.py` | VeyyonAgent | `vey` | `veyyon.txt` |
| `omp_agent.py` | OmpAgent | `cli.js` (via Bun) | `omp.txt` (NDJSON stream) |
| `factory_agent.py` | FactoryAgent | `droid` | `factory.txt` |
| `hermes_agent.py` | HermesAgent | (native) | `hermes.txt` |

## Common Interface

Every Pier agent subclasses `BaseInstalledAgent`:

```python
class MyAgent(BaseInstalledAgent):
    SUPPORTS_ATIF: ClassVar[bool] = False

    @staticmethod
    def name() -> str: ...

    def install_spec(self) -> AgentInstallSpec: ...
    def network_allowlist(self): ...

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        """Execute the agent on the given task instruction within the container."""

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Collect session metrics, token usage, and tool distribution after execution."""
```

## Network Allowlists

Agents run inside Docker containers with egress proxies. Each adapter declares its allowed domains via `network_allowlist()`. Common domains:

| Domain | Purpose |
|---|---|
| `.googleapis.com` | Google AI API |
| `.google.com` | Google services |
| `.anthropic.com` | Anthropic API |
| `.openai.com` | OpenAI API |
| `.openrouter.ai` | OpenRouter API |
| `.opencode.ai` | OpenCode API gateway |
| `.models.dev` | Model metadata overlay |

Missing domains cause DNS resolution failures inside the container. If a new API provider is added, its domain must be added to the allowlist of every adapter that might use it.

## Model Resolution

### Veyvon

The veyvon binary has a synchronous model discovery fallback: when an explicit `--model` pattern does not resolve against the static catalog, it runs a cache-aware discovery pass before model resolution. This handles dynamically-discovered models (not in the bundled catalog) without requiring a `models refresh` before the agent starts.

The `model-catalog-bootstrap.py` module runs `vey models refresh <provider> --json` before the agent starts, writing model metadata to a cache the agent reads at startup.

### Omp

Omp's release binary does not have the synchronous discovery fallback. For dynamically-discovered models, the omp adapter's `stageAssets()` method generates a `models.yml` with full metadata using the veyvon binary's `models.dev` overlay. The omp agent copies this to `~/.omp/agent/models.yml` before starting the agent, which adds the model to omp's static catalog at startup.

The `models.yml` includes:

- `apiKey`: The actual OpenCode API key (not a variable reference).
- `baseUrl`: The provider's API gateway URL (e.g. `https://opencode.ai/zen/go/v1`).
- `api`: The API type (e.g. `openai-completions`).
- `models`: A list with `id`, `name`, `contextWindow`, `maxTokens`, `reasoning`, `input`, and `cost`.

## Output Formats

### Veyvon (`veyyon.txt`)

Plain text with `[veyyon] warning:` lines for native addon issues, then `Working...` while the agent runs. The session JSONL is captured separately.

### Omp (`omp.txt`)

NDJSON event stream (`--mode json`), with one JSON object per line:

- `{"type":"session",...}` — session start
- `{"type":"turn_start"}` / `{"type":"turn_end"}` — turn boundaries
- `{"type":"message_start",...}` / `{"type":"message_end",...}` — message boundaries
- `{"type":"auto_retry_start",...}` / `{"type":"auto_retry_end",...}` — retry events

Each assistant message includes `usage` (input, output, cache tokens, cost) and `stopReason` (e.g. `end_turn`, `error`, `tool_use`).

## Session Capture

After the agent finishes, each adapter copies session JSONL files to `/logs/agent/sessions/` for post-run analysis. The `populate_context_post_run()` method parses these to extract:

- `context.n_input_tokens` — total input tokens
- `context.n_output_tokens` — total output tokens
- `context.cost_usd` — total cost in USD
- `context.metadata` — tool call distribution and other metadata

## Running Unit Tests

```bash
cd packages/evals && python3 -m unittest discover -s agents -p "*_test.py"
```

Test files follow the `*_test.py` naming convention. Tests use `unittest.mock` to mock the Pier environment and agent context, avoiding Docker dependencies.
