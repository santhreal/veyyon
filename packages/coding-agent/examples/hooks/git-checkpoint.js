export default function (pi) {
    const checkpoints = new Map();
    let currentEntryId;
    pi.on("tool_result", async (_event, ctx) => {
        const leaf = ctx.sessionManager.getLeafEntry();
        if (leaf)
            currentEntryId = leaf.id;
    });
    pi.on("turn_start", async () => {
        const { stdout, code } = await pi.exec("git", ["stash", "create"]);
        if (code !== 0)
            return;
        const ref = stdout.trim();
        if (ref && currentEntryId) {
            checkpoints.set(currentEntryId, ref);
        }
    });
    pi.on("session_before_branch", async (event, ctx) => {
        const ref = checkpoints.get(event.entryId);
        if (!ref)
            return;
        if (!ctx.hasUI) {
            return;
        }
        const status = await pi.exec("git", ["status", "--porcelain"]);
        const dirtyCount = status.code === 0 ? status.stdout.split("\n").filter(line => line.trim()).length : 0;
        const yes = dirtyCount > 0 ? `Yes, apply over my ${dirtyCount} uncommitted change(s)` : "Yes, restore code to that point";
        const question = dirtyCount > 0
            ? `Restore code state? You have ${dirtyCount} uncommitted change(s); restoring merges the checkpoint into them and may conflict.`
            : "Restore code state?";
        const choice = await ctx.ui.select(question, [yes, "No, keep current code"]);
        if (!choice?.startsWith("Yes"))
            return;
        const result = await pi.exec("git", ["stash", "apply", ref]);
        if (result.code !== 0) {
            ctx.ui.notify(`Could not restore checkpoint: ${result.stderr.trim() || `git exited ${result.code}`}`, "error");
            return;
        }
        ctx.ui.notify("Code restored to checkpoint", "info");
    });
    pi.on("agent_end", async () => {
        checkpoints.clear();
    });
}
