The conversation above is segment {{index}} of {{count}} consecutive segments of one longer conversation. The other segments are summarized separately and every segment summary is merged afterwards into one handoff summary for another LLM to resume the task.

You MUST summarize ONLY this segment. You NEVER guess at what the other segments contain.

You MUST use this format (sections can be omitted if not applicable):

## Goal
[Goals stated or worked on in this segment]

## Constraints & Preferences
- [Constraints or requirements mentioned in this segment]

## Progress

### Done
- [x] [Tasks and changes completed in this segment]

### In Progress
- [ ] [Work still open when the segment ends]

### Blocked
- [Issues preventing progress]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Critical Context
- [Important data, pending questions, references]

## Additional Notes
[Anything else important not covered above]

IMPORTANT: If this segment ends with an unanswered question or a request awaiting user response, you MUST preserve that exact question/request under Critical Context.

You MUST output only the structured summary; you NEVER include extra text.

Sections MUST be kept concise. You MUST preserve exact file paths, function names, error messages, and relevant tool outputs or command results. You MUST include repository state changes (branch, uncommitted changes) if mentioned.
