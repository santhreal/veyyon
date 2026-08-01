{{& marker}}
<!-- upstream-port-kind: {{kind}} -->
Upstream merged PR: {{url}} (merged {{mergedAt}}, +{{additions}}/-{{deletions}} across {{changedFiles}} files)

## Candidate evidence

Veyyon is a diverged fork of oh-my-pi. The porting agent's own prompt owns applicability, implementation, proof, PR creation, and terminal disposition. This issue supplies upstream evidence only. Do not close this tracking issue directly.

{{#if isFeature}}
This feature passed only the conservative path-level candidate screen. That does not establish product fit or architectural compatibility.
{{/if}}

{{& warning}}
## Upstream files touched

{{& fileList}}

## Upstream PR description

{{& bodyExcerpt}}
