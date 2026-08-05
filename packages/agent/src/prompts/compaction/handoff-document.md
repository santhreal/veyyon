<critical>
Write a handoff document for another instance of yourself.
This starts a NEW session. Nothing from this conversation survives except the document you write, so anything you leave out is gone.
The overarching goal comes first and is never dropped: what the user is ultimately trying to achieve across the whole session, not just the task in front of you right now.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test and gate results with their real numbers: pass/fail counts, durations, run IDs
- Observed failures: the exact error text, the file, the line
- Decisions made
- Partial work affecting the next step
</instruction>

<restart>
The next session starts cold, in a fresh process, with no memory of this one. Record what it needs to resume work rather than re-derive it:
- Working directory, and where the work is version controlled: the branch, the HEAD commit it started from, whether anything has been committed during this session, and the uncommitted or untracked files
- Toolchain, environment, or wrapper commands this repository requires
- Session-owned async jobs are cancelled during this handoff. Record their last observed result or failure when useful, but NEVER say they remain running. List a watch, daemon, server, or detached process as still running only when you observed that it survives a session handoff.
- The exact next command to run, ready to paste
</restart>

<commands>
Write only what you observed. Every command must be one that was actually run in this conversation, copied as it was run, and the same holds for every other fact: a branch name, a file list, a test count, a running process.

You are recording history, not writing a script. If the next step needs a command nobody ran yet, describe the step in words and say what still has to be decided, rather than inventing a plausible command line. An invented command is worse than no command: it looks verified, the next session pastes it, and it can be wrong or destructive in ways this repository specifically forbids. Never invent git commands, and never propose staging or committing unless the user asked for it in this conversation.

This constrains how you write a step, never whether you write it. Next Steps stays a complete ordered list of everything the next session should pick up; a step with no command yet is written in words and still belongs there.

Nothing here is a field you must fill. A section or bullet with nothing real behind it is left out, and that is the correct answer, not a gap to patch. Guessing a plausible value to complete the shape is the single worst thing you can do, because the next session cannot tell a guess from an observation and will act on it.
</commands>

<repetition>
Record each mechanical action once. Noting that you updated a tracker, marked an item done, or touched the same file again tells the reader nothing after the first time, and repeating the phrase on every entry costs a line each while adding no information. State it once, or fold it into a single line covering every entry it applies to, and spend the space on the result instead.
</repetition>

<output>
Use exactly this structure:

## Goal
[The overarching goal for the whole session, carried forward unless the user changed it]
Current task: [what is being worked on right now, which is allowed to change often]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]

## Progress
### Done
- [x] [Completed tasks with specifics]

### In Progress
- [ ] [Current work if any]

### Pending
- [ ] [Tasks mentioned but not started]

### Blocked
- [What is stopping progress, and what would unblock it]

## Key Decisions
- **[Decision]**: [Rationale]

## Critical Context
- Code snippets, file paths, function/type names, error messages, data essential to continue
- Where the work is version controlled: working directory, branch, HEAD commit, whether anything was committed this session, and each modified or untracked file with what changed in it and why
- Only independently persistent processes observed to survive the handoff, with their command. Session-owned async jobs are cancelled and never belong here.

## Next Steps
1. [What should happen next]
</output>

{{#if additionalFocus}}
<instruction>
Additional focus: {{additionalFocus}}
</instruction>
{{/if}}
