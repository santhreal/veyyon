# Upstream and fork credits

Veyyon is a source fork of **oh-my-pi** (`can1357/oh-my-pi`), MIT licensed.

```
Veyyon     https://github.com/santhreal/veyyon.git
oh-my-pi   https://github.com/can1357/oh-my-pi.git
```

## Where the legal notices live

- `LICENSE` — Veyyon's license (MIT), which is also the license under which
  oh-my-pi's incorporated MIT code is used.
- `NOTICE` — third-party attribution for code vendored or adapted under
  licenses other than plain MIT-via-`LICENSE` (Apache-2.0 wire types,
  Apache-2.0 generated bundles), plus pointers to crate-level notices.
- `natives/shell/NOTICE` — crate-scoped attribution for an adapted
  algorithm (RTK, MIT), next to the code it describes.
- `natives/vendor/*/LICENSE` — per-crate upstream license files for vendored
  Rust dependencies, authoritative for that code.
- `docs/handbook/src/acknowledgements.md` — the credits page for handbook
  readers.

What was forked, what diverged since, the port pipeline, and how to review a
candidate port: [porting guide](docs/internal/porting-from-pi-mono.md).
