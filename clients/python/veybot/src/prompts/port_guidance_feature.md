This port is a **feature**. It claims current veyyon lacks a capability the
upstream pull request added.

**Before you implement.** Confirm the capability is absent on current veyyon,
that the change is additive, and that it fits veyyon's product direction. The
clean-feature marker on the tracking issue is only a path screen, never a
decision. If the feature duplicates, weakens, or conflicts with a local
contract, classify the port as not applicable and name that contract.

**After you implement.** Prove an observable off-versus-on differential through
the real operator path, the way a user reaches the feature. For a user-facing
feature, satisfy `AGENTS.md`'s feature-proof contract in full: its demo, its
settings differential where a setting exists, and its exact-parity benchmark
artifacts. An off arm that does not reproduce the pre-feature baseline proves
nothing, and a differential pair that looks identical is a failed proof, not a
passed one.

**Documentation.** Update every local user-facing document that describes the
behavior. Write for veyyon rather than copying upstream prose. NEVER commit
generated handbook pages or internal docs.
