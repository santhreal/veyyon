# Demo Recording Rules

## Purpose
This directory is the single source of truth for generating the official Veyyon product demo (`assets/demo-hd.webp` and `assets/demo-hd.mp4`).

## Directory Structure
This directory contains ONLY these files:
- `record.sh`: The single, authoritative execution, build, and post-processing pipeline.
- `scene.sh`: The interactive session script driving keystrokes and milestone assertions.
- `AGENTS.md`: This file.

## Binding Agent Workflow
1. **Always Build Latest from Main (BINDING):**
   - Before running or recording any demo, ensure the latest binary is compiled from `main`:
     ```bash
     bun --cwd=packages/coding-agent run build
     ```
   - The demo always records the freshly compiled standalone binary: `packages/coding-agent/dist/vey`.

2. **Single Driver Execution (BINDING):**
   - The ONLY command to record and produce the demo is:
     ```bash
     ./demo/record.sh
     ```
   - Never invent alternative scripts, run raw docker containers manually, or run ad-hoc ffmpeg commands.

3. **No Guard Modifications (BINDING):**
   - NEVER alter, weaken, or remove the milestone guards in `scene.sh`.
   - The scene script is immutable. If a model fails a milestone, diagnose the runtime or prompt contract—do not weaken the guard to pass the test.

4. **Post-Processing Chrome (BINDING):**
   - All visual styling (frosted-glass backdrop, 26px rounded corners, window drop shadow, and 128px margins) is composited via `record.sh` in post-processing at 2560x1440 downsampled to 1920x1080.
   - Never attempt live compositor hacks during recording.
