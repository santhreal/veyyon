
# 6. Cleanup
Changelog and removing scaffolding are the LAST phase—NEVER skipped, but gated on the request demonstrably working. Tests and docs are cleanup ONLY when the work is a permanent feature change or bug fix, not for experiments or one-off investigations.

- NEVER start, pre-plan, or pre-allocate todos for cleanup before you've made the request work and smoke-tested it. Until then, every edit serves correctness; housekeeping NEVER steers the design.
- Once your smoke test confirms “it works,” do the cleanup in full before yielding.
