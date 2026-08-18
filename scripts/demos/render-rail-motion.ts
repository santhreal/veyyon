/**
 * One frame of the rail's motion beside a real bash block.
 *
 * The rail is the line every tool block hangs its output from, and until now it had
 * two states and a hard cut between them: accent while the command runs, dim the
 * instant its output lands. So the questions a demo has to answer are whether a
 * waiting block reads as working, and whether the moment output arrives reads as
 * the block filling rather than as a colour swap.
 *
 * The block is the REAL `bashToolRenderer` output; the frame is the REAL
 * `paintRailMotion`, the same call `ToolExecutionComponent.render` makes.
 *
 * Run:
 *
 *     bun scripts/demos/render-rail-motion.ts --width 100 --idle 6 |
 *       bun scripts/demos/render-proof.ts --out /tmp/rail/idle-6 --width 100
 *
 * `--idle N` renders idle step N (the head has travelled N/2 rows).
 * `--settle N` renders settle frame N of RAIL_SETTLE_FRAMES; `--settle 0` is the
 * static settled block, which is also what the last frame renders.
 * `--running` renders the block WITHOUT its result, which is the shape the idle
 * motion plays over.
 */

import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { bashToolRenderer } from "../../packages/coding-agent/src/tools/bash";
import {
	paintRailMotion,
	RAIL_SETTLE_FRAMES,
	type RailMotion,
	railIdleHeadAt,
} from "../../packages/coding-agent/src/tui/rail-motion";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

const command =
	'export TMPDIR="$HOME/.cache/lurien-e2e" ORT_DYLIB_PATH=/usr/local/lib/sherpa-onnx/libonnxruntime.so; cargo test -p lurien-vision --test audio_transcription 2>&1 | grep -E "^error" | head -5';

const OUTPUT = [
	"   Compiling lurien-vision v0.4.1 (/src/lurien/crates/lurien-vision)",
	"    Finished `test` profile [unoptimized + debuginfo] target(s) in 41.02s",
	"     Running tests/audio_transcription.rs (target/debug/deps/audio_transcription-9f2c1d)",
	"running 6 tests",
	"test transcribes_a_16k_mono_wav ... ok",
	"test rejects_a_truncated_header ... ok",
	"test streams_partial_segments ... ok",
].join("\n");

const running = hasFlag("running");
const component = running
	? bashToolRenderer.renderCall({ command }, { expanded: false, isPartial: true }, theme)
	: bashToolRenderer.renderResult(
			// `BashToolDetails` carries the exit code only; the command and output reach the renderer
			// through the call args and the result content.
			{ content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0 } },
			{ expanded: false, isPartial: false },
			theme,
		);

const lines = component.render(width);
const idle = flag("idle", "");
const settle = flag("settle", "");
const motion: RailMotion | undefined =
	idle !== ""
		? { kind: "idle", head: railIdleHeadAt(Number(idle)) }
		: settle !== "" && Number(settle) > 0
			? { kind: "settle", frame: Math.min(Number(settle), RAIL_SETTLE_FRAMES) }
			: undefined;

const painted = motion ? paintRailMotion(lines, motion, theme) : lines;
process.stdout.write(`${painted.join("\n")}\n`);
