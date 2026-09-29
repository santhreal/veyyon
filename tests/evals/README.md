# @veyyon/evals

Benchmark suites, harness adapters and execution backends for measuring agents: DeepSWE,
Terminal-Bench, TypeScript edits, a browser suite of seeded local web applications, and MiniWoB++.
Arms (builds, settings, prompts, models, harnesses) run side by side on the same tasks and seeds, and
each run reports pass rates with their uncertainty, spend, and a paired comparison.

```sh
cd tests/evals
bun evals.ts --list
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash --dry-run
```

The manual is [`docs/`](docs/README.md).
