Send and receive short text messages between the agents running in this process.

# Addressing and Discovery
The main agent is always `Main`. Subagents inherit their task ID (e.g., `AuthLoader`). If you don't know who is currently running, use `op: "list"` to view all peers alongside their status, unread message count, and recent activity. Address peers by their exact ID from the roster; NEVER invent names.

# Messaging Rules
Use `op: "send"` to deliver a message to a specific peer or broadcast to `"all"`.
- **Fire and forget:** Sending NEVER blocks. You get delivery receipts immediately (`delivered` or `failed`). Do not wait around—send your message and keep working. If a receipt says `failed`, the peer is gone; do not retry.
- **A message is not free.** Sending to an `idle` or `parked` agent WAKES it: it stops what it was doing, spends a full turn reading you, and pays for that turn. `to: "all"` charges that to every peer on the roster at once. Send when the peer must act or must stop; not to keep anyone informed.
- **Answering:** When replying to a question, use `op: "send"`, lead directly with your answer (NEVER quote the original message), and set `replyTo` so the recipient can correlate it.
- **Format:** Messages MUST be plain prose. NEVER send JSON status objects. Keep it terse and share paths via `local://` or `artifact://` URLs, not pasted blobs.
- **NEVER send a bare acknowledgement.** "Understood", "noted", "will do", "thanks", and "ack" carry no information and cost the reader a turn. They are also what a two-agent loop is made of: each ack looks like traffic that deserves an ack. Silence IS the acknowledgement. Reply only when you carry a decision, a fact the peer cannot get from a tool, or a refusal.
- **Do not narrate.** Progress reports, plans, restatements of your assignment, and "starting now" belong in your own final output, not on the bus. Your spawner reads your result when you yield.

# Waiting and Inboxes
Messages only arrive when the peer actively sends one—do not interrogate a peer for status.
- If you are completely blocked and MUST wait for an answer, use `op: "wait"` (or `await: true` on a send). The wait returns when a matching message arrives, the timeout elapses, or any IRC / steering message interrupts the wait. Parent-agent IRC interrupts with steering-level priority.
- No need to alternate `irc wait`, `irc inbox`, and `job poll`: waits surface cross-channel interrupts promptly. The next turn includes the interrupt reason and message.
- To check for messages without blocking, use `op: "inbox"` to drain your queue.

# When to Coordinate
Message peers instead of guessing, duplicating work, or spying. The test is whether the message changes what somebody DOES. If it does not, do not send it.

Send when, and broadly only when:
- You are about to edit a file another agent may hold, or you need one they hold. DM them before editing, not after.
- You hit an unexpected state (missing files, a contract that does not match) or a decision that is not yours. DM `Main` or your spawner and name the decision.
- You found something that makes a peer's current work wrong or wasted. Interrupting is cheaper than letting them finish the wrong thing.
- A peer asked you a direct question.

Never send:
- A progress report, a receipt, a restatement of your assignment, an agreement, or an announcement of what you are starting. Those wake every reader for nothing.
- Anything a tool answers for you: grepping the codebase, running a build, reading a file.
- A question about what a peer is doing. You never infer it from shell tools or another session's files either; ask them, or do not need to know.
- The next line of a back-and-forth. Two agents that only answer each other never converge, and the bus refuses the message once a pair has traded 16 in a row with no one else involved. Long before that: decide with what you have, or tell your spawner the specific decision you are stuck on and let them settle it.
