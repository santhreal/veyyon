Send and receive short text messages between the agents running in this process.

# Addressing
`Main` is the main agent; a subagent's ID is its task name (e.g. `AuthLoader`). `op: "list"` shows every peer with status, unread count, and recent activity. Address peers by their exact roster ID; NEVER invent names.

# Sending
- **Fire and forget.** `op: "send"` never blocks and returns a receipt (`delivered` or `failed`). A `failed` receipt means the peer is gone; do not retry.
- **A message is not free.** It WAKES an `idle` or `parked` peer: it stops what it was doing, spends a full turn reading you, and pays for that turn. `to: "all"` charges that to every peer at once.
- **Plain prose only.** NEVER send JSON status objects. Keep it terse and share payloads as `local://` or `artifact://` URLs, never pasted blobs.
- **Answering:** lead with the answer, NEVER quote the question, and set `replyTo` so the peer can correlate it.

# Waiting
- Blocked and unable to proceed without an answer: `op: "wait"`, or `await: true` on the send. It returns on a matching message, on the timeout, or on any IRC / steering interrupt (parent-agent IRC arrives with steering priority), and the next turn carries the reason. No need to alternate `wait`, `inbox`, and `job poll`.
- `op: "inbox"` drains your queue without blocking.

# What is worth a message
The test is whether the message changes what somebody DOES. Send when:
- You are about to edit a file another agent may hold, or you need one they hold. DM them before editing, not after.
- You hit an unexpected state (a missing file, a contract that does not match) or a decision that is not yours. Name the decision to `Main` or your spawner.
- You found something that makes a peer's current work wrong or wasted. Interrupting is cheaper than letting them finish it.
- A peer asked you a direct question.

NEVER send:
- **A bare acknowledgement.** "Understood", "noted", "will do", "thanks", "ack" carry no information and cost the reader a turn. Each also looks like traffic that deserves an ack, which is what a two-agent loop is made of. Silence IS the acknowledgement.
- A progress report, a plan, a restatement of your assignment, or "starting now". Your spawner reads your result when you yield.
- Anything a tool answers for you: a grep, a build, a file read. That includes what a peer is doing; ask them, or do not need to know, and never infer it from their files.
- The next line of a back-and-forth. Two agents that only answer each other never converge, and the bus refuses the message once a pair has traded 16 in a row with no one else involved. Long before that: decide with what you have, or tell your spawner the exact decision you are stuck on.
