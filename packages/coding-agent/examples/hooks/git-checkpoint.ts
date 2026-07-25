/**
 * Git Checkpoint Hook
 *
 * Records a git checkpoint at each turn so `/branch` can offer to restore the
 * code state from that point.
 *
 * Two things here are deliberate and worth copying if you write your own.
 *
 * It uses `git stash create`, NOT `git stash` or `git stash push`. `create`
 * builds a commit object holding the current state and prints its hash. It does
 * not touch your working tree and does not push anything onto the stash stack,
 * so taking a checkpoint can never move your files or interleave with a stash
 * you are managing yourself. Plain `git stash` would sweep the working tree on
 * every turn, which is the opposite of what a checkpoint should do.
 *
 * Restoring is the dangerous direction, because `git stash apply` writes to the
 * working tree and merges into whatever is already there. So it asks first, it
 * says plainly when you have uncommitted changes it could disturb, and it checks
 * whether the apply actually succeeded instead of assuming it did.
 */
import type { HookAPI } from "@veyyon/coding-agent";

export default function (pi: HookAPI) {
	const checkpoints = new Map<string, string>();
	let currentEntryId: string | undefined;

	// Track the current entry ID when user messages are saved
	pi.on("tool_result", async (_event, ctx) => {
		const leaf = ctx.sessionManager.getLeafEntry();
		if (leaf) currentEntryId = leaf.id;
	});

	pi.on("turn_start", async () => {
		// `stash create` records the current state as a commit object and prints
		// its hash. It leaves the working tree and the stash stack alone, so this
		// runs every turn without ever moving the user's files.
		const { stdout, code } = await pi.exec("git", ["stash", "create"]);
		// A clean tree has nothing to record and prints nothing. That is not an
		// error, there is simply no checkpoint for this turn.
		if (code !== 0) return;
		const ref = stdout.trim();
		if (ref && currentEntryId) {
			checkpoints.set(currentEntryId, ref);
		}
	});

	pi.on("session_before_branch", async (event, ctx) => {
		const ref = checkpoints.get(event.entryId);
		if (!ref) return;

		if (!ctx.hasUI) {
			// Nobody can answer, so nothing is written. Restoring code over a user's
			// files is not something to do on an assumed yes.
			return;
		}

		// Applying merges into what is already in the working tree. Count what is
		// at risk so the question names it, rather than asking for consent to
		// something the user cannot see.
		const status = await pi.exec("git", ["status", "--porcelain"]);
		const dirtyCount = status.code === 0 ? status.stdout.split("\n").filter(line => line.trim()).length : 0;

		const yes = dirtyCount > 0 ? `Yes, apply over my ${dirtyCount} uncommitted change(s)` : "Yes, restore code to that point";
		const question =
			dirtyCount > 0
				? `Restore code state? You have ${dirtyCount} uncommitted change(s); restoring merges the checkpoint into them and may conflict.`
				: "Restore code state?";

		const choice = await ctx.ui.select(question, [yes, "No, keep current code"]);
		if (!choice?.startsWith("Yes")) return;

		const result = await pi.exec("git", ["stash", "apply", ref]);
		if (result.code !== 0) {
			// Say what happened. Reporting success here regardless is how a user
			// ends up believing their code was restored when it was not, or when it
			// was left half-applied with conflict markers in it.
			ctx.ui.notify(`Could not restore checkpoint: ${result.stderr.trim() || `git exited ${result.code}`}`, "error");
			return;
		}
		ctx.ui.notify("Code restored to checkpoint", "info");
	});

	pi.on("agent_end", async () => {
		// Clear checkpoints after agent completes
		checkpoints.clear();
	});
}
