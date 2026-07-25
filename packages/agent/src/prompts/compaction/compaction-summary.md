You MUST summarize the conversation above into a structured summary that replaces it.

The overarching goal comes first and is never dropped: what the user is ultimately trying to achieve across the whole session, not the task in front of you right now. Carry it through every compaction until the user changes it.

<continuation>
This summary is injected into the SAME session. The most recent turns stay in context alongside it, so you are not writing a cold restart. Summarize the history being replaced, and do not restate what the recent turns already say.
</continuation>

<evidence>
Evidence is the part of the history that cannot be reconstructed. Capture it exactly, never as an abstraction:
- Commands run, verbatim, including flags and the working directory when it matters
- Test and gate results with their real numbers: pass/fail counts, durations, run IDs
- Observed failures: the exact error text, the file, the line
- File paths, symbol names, and identifiers exactly as written
- Where the work is version controlled: branch, HEAD commit, whether anything was committed this session, uncommitted or untracked files

Prose is where you are concise. Evidence is where you are complete. When the two conflict, drop the prose and keep the evidence: a command you omit is a command the next turn has to rediscover by re-running it.

Evidence means the specific result, not the bookkeeping around it. Recording that you updated a tracker, marked an item done, or edited the same file again carries no information once it has been said, and repeating that phrase on every entry costs a line each time while telling the reader nothing new. State each mechanical action once, or fold it into a single line covering every entry it applies to.

Also record what is still running: background jobs, watches, and servers started during this session, with the command each one is running. A process the next turn cannot see is one it will collide with.

Every one of these is written only when you actually observed it. None of them is a field to fill: a section with nothing real behind it is left out, and that is the correct answer. Guessing a plausible value to complete the shape is worse than omitting it, because the next turn cannot tell a guess from an observation and will act on it.
</evidence>

IMPORTANT: If the conversation ends with an unanswered question or a request awaiting user response (e.g., "Please run command and paste output"), you MUST preserve that exact question/request.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[The overarching goal for the whole session, carried forward unless the user changed it]
Current task: [what is being worked on right now, which is allowed to change often]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed task, with the command or gate that proves it and its result]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of next actions]

## Critical Context
- [Important data, pending questions, references]
- [Repository state: branch, HEAD commit, whether anything was committed this session, and each modified or untracked file with what changed in it]
- [Anything still running, with its command]

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.
