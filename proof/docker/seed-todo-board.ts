/**
 * Seed one resumable session whose plan is taller than the anchored board, so a
 * scene can photograph the board's overflow row with no model in the loop.
 *
 * Everything here goes through the product's own writer — `SessionManager.create`,
 * `setSessionFile`, `appendMessage`, `appendCustomEntry`, `flush` — so the file a
 * scene resumes is the file a session writes. The board is rebuilt from the last
 * `user_todo_edit` entry on load, which is the same path a plan takes when the
 * operator edits the board by hand, so nothing about the surface under capture is
 * faked.
 *
 * The plan is nine stages with the work sitting in the first one: collapsed, the
 * board draws the active stage, the tasks it previews, and four stages after it,
 * which is more rows than the anchored region spends on a short terminal. That
 * overflow is the row this exists to show.
 *
 * Run inside the recorder before veyyon starts, then resume with `--continue`:
 *   bun /repo/proof/docker/seed-todo-board.ts /sandbox/home/demo
 */
import * as path from "node:path";
import { SessionManager } from "../../packages/coding-agent/src/session/session-manager";
import { type TodoPhase, USER_TODO_EDIT_CUSTOM_TYPE } from "../../packages/coding-agent/src/tools/todo";

const cwd = path.resolve(process.argv[2] ?? "/sandbox/home/demo");

// Nine stages, and the plan is on the first: a stage with open work is the one the
// board expands, and every stage after it costs a row. Task text is the width a real
// plan writes at, since a row that clamps proves nothing about a row that folds.
const PHASES: TodoPhase[] = [
	{
		name: "Parser",
		tasks: [
			{ content: "Reject a focus string that is only whitespace", status: "in_progress" },
			{ content: "Keep the trimmed form of a valid string", status: "pending" },
			{ content: "Name the offending input in the error", status: "pending" },
			{ content: "Cover the empty string and the blank string apart", status: "pending" },
			{ content: "Run the parser suite against the fixture", status: "pending" },
			{ content: "Read the seeded parser and its suite", status: "completed" },
			{ content: "Write down what the parser guarantees today", status: "completed" },
		],
	},
	{
		name: "Rate limiter",
		tasks: [
			{ content: "Refill the bucket before the take, not after", status: "pending" },
			{ content: "Assert the boundary call is allowed", status: "pending" },
		],
	},
	{
		name: "Service",
		tasks: [
			{ content: "Route a rejected take to the retry path", status: "pending" },
			{ content: "Report the wait in the error the caller sees", status: "pending" },
		],
	},
	{
		name: "Storage",
		tasks: [
			{ content: "Persist the bucket state across a restart", status: "pending" },
			{ content: "Reject a stale snapshot rather than serving it", status: "pending" },
		],
	},
	{
		name: "Telemetry",
		tasks: [{ content: "Count refusals per caller", status: "pending" }],
	},
	{
		name: "Docs",
		tasks: [{ content: "State the refill rule where the limiter is documented", status: "pending" }],
	},
	{
		name: "Bench",
		tasks: [{ content: "Measure the take path against the seeded corpus", status: "pending" }],
	},
	{
		name: "Review",
		tasks: [{ content: "Read the diff against the contract it changes", status: "pending" }],
	},
	{
		name: "Verification",
		tasks: [{ content: "Run the suite the change is claimed against", status: "pending" }],
	},
];

const manager = SessionManager.create(cwd);
const sessionFile = path.join(SessionManager.getDefaultSessionDir(cwd), "plan.jsonl");
await manager.setSessionFile(sessionFile);

// One user turn, so the resumed session opens on a transcript rather than on chrome
// alone. No assistant message: a model reply carries the provider, api and model it
// came from, and inventing those would be seeding a turn no provider answered.
manager.appendMessage({ role: "user", content: "Plan the rate limiter work before touching it." });
manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: PHASES });

await manager.setSessionName("rate limiter plan", "user");
await manager.flush();
process.stdout.write(`seeded ${sessionFile}\n`);
