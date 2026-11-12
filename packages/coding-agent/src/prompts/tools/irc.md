Send and receive short text messages between the agents running in this process.

# Addressing
`Main` is the main agent; a spawned agent's ID is its task name (e.g. `AuthLoader`). `op: "list"` shows every peer with status, unread count, and recent activity. Address peers by their exact roster ID; NEVER invent names.

# Sending
- **Fire and forget.** `op: "send"` never blocks and returns a receipt (`delivered` or `failed`). A `failed` receipt means the peer is gone; do not retry.
- **Delivery wakes the peer.** A message WAKES an `idle` or `asleep` peer, which starts a turn to read it; a busy peer reads it at its next step. `to: "all"` reaches every peer at once.
- **Plain prose only.** NEVER send JSON status objects. Keep it terse and share payloads as `local://` or `artifact://` URLs, never pasted blobs.
- **Answering:** lead with the answer, NEVER quote the question, and set `replyTo` so the peer can correlate it.

# Waiting
- Blocked and unable to proceed without an answer: `op: "wait"`, or `await: true` on the send. It returns on a matching message, on the timeout, or on any IRC / steering interrupt (parent-agent IRC arrives with steering priority), and the next turn carries the reason. No need to alternate `wait`, `inbox`, and `job poll`.
- `op: "inbox"` drains your queue without blocking.

# When to message
Message a peer whenever it moves the work forward: a question, an answer, a finding, a result they are waiting on, a decision you need from them, or a file you are about to touch. Send these:
- You are about to edit a file another agent may hold, or you need one they hold. DM them before editing, not after.
- You hit an unexpected state (a missing file, a contract that does not match) or a decision that is not yours. Name the decision to `Main` or your spawner.
- You found something that makes a peer's current work wrong or wasted. Interrupting is cheaper than letting them finish it.
- A peer asked you a direct question.

No reply is needed to acknowledge a message, and your spawner reads your result when you yield.

# Loops
The bus refuses a message once you and a peer have exchanged 8 in a row with no work by either of you in between and nobody else involved. Work is any tool call other than `irc`, `job` and `todo`. When refused, do the work the conversation is about, decide with what you have, or tell your spawner the exact decision you are stuck on.
