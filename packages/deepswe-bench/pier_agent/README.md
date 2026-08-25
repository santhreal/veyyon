# Pier Agent Runtime Environment

This directory contains the Python agent adapters invoked inside Docker containers by Pier during DeepSWE evaluations.

## Adapters

- `veyyon_agent.py`: Adapter for Veyyon coding agent (`vey` binary execution, session capture, prompt template rendering).
- `omp_agent.py`: Adapter for Oh-My-Pi coding agent (`omp` CLI execution, config injection, session JSONL parsing).
- `factory_agent.py`: Adapter for Droid / Factory agent execution and session capture.
- `hermes_agent.py`: Adapter for Hermes agent execution and session capture.

## Common Interface

Every Pier agent subclasses `BaseInstalledAgent` from `pier.agents.installed.base`:

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

## Running Unit Tests

To run all unit tests for the Pier agents:

```bash
python3 -m unittest discover -s packages/deepswe-bench/pier_agent -p "*test.py"
```
