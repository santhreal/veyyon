<system-reminder>
Review the code this turn changed before finalizing.
{{#if pathsMarkdown}}
Changed here, with the edits above in this turn:
{{pathsMarkdown}}
{{/if}}
{{#if unreadablePathsMarkdown}}
Changed earlier in this turn, with the edits no longer in your context. Read each one before judging it:
{{unreadablePathsMarkdown}}
{{/if}}
{{#if omittedNote}}
{{omittedNote}}
{{/if}}

Evaluate:
1. Correctness & Intent: Does the implementation solve the requirement cleanly end-to-end without regressions or missed cases?
2. Maintainability & Idioms: Is the code structured simply, without unnecessary abstractions, leftover comments, or temporary scaffolding?
3. Invariants & Boundaries: Are edge cases, nullability, error propagation, and cross-file contract assumptions preserved across all callers?

If a concrete defect or cleanup is identified, apply the fix directly; otherwise, state what was verified and conclude.
</system-reminder>
