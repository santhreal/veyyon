The <segment-summaries> above are summaries of consecutive segments of ONE conversation, in chronological order. Later segments happened after earlier ones. You MUST merge them into a single structured handoff summary for another LLM to resume the task.

RULES:
- MUST preserve every goal, decision, constraint, file path, function name, error message, and command result from every segment
- MUST resolve the timeline: a task "In Progress" in an earlier segment and "Done" in a later one is Done; a blocker cleared later is not a blocker
- MUST keep the LAST segment's open work as the current state
- MUST preserve all information from <previous-summary> when one is present, updated by what the segments add
- You MAY drop anything a later segment superseded

IMPORTANT: If the last segment ends with an unanswered question or a request awaiting user response, you MUST preserve that exact question/request under Critical Context.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[User goals; list multiple if the conversation covers different tasks.]

## Constraints & Preferences
- [Constraints or requirements mentioned]

## Progress

### Done
- [x] [Completed tasks/changes]

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

## Additional Notes
[Anything else important not covered above]

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. You MUST preserve exact file paths, function names, error messages, and relevant tool outputs or command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
