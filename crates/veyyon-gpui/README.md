# veyyon-gpui

Contains the GPUI renderer pin and patch extension interfaces for the veyyon desktop surface.

## Upstream and Fork Topology

GPUI is tracked as a fork of `zed-industries/zed` hosted at `santhreal/zed` on branch `veyyon`.
The dependency is pinned by commit revision in the workspace `Cargo.toml`.

## Rebase Policy

1. The `veyyon` branch contains upstream release tags plus local patches P1 through P10 applied in order.
2. The branch contains no merge commits and no squashed patch sequences.
3. Rebases occur on demand when upstream capabilities or fixes are required.
4. Each rebase reapplies the patch series P1 through P10 in sequence on top of the target upstream revision.
5. The commit advancing the workspace `Cargo.toml` revision pin lists any patch adjustments required during the rebase.

## Patch Series Specification

- **P1**: 2×3 affine transform on primitives (quad, shadow, glyph run, image, path) composed down the element tree and applied in the vertex stage.
- **P2**: Animator identity with animation state keyed by a stable handle persisting across remounts, preserving velocity on interruption.
- **P3**: Spring integrator with stiffness, damping, and mass parameters, alongside native delay on `Animation`.
- **P4**: Animatable style properties supporting declared transitions on style modifications.
- **P5**: Frame driver with damage-scoped invalidation driven by state reducer damage bounds, scissored draw, and tile skipping.
- **P6**: Backdrop material primitive providing dual-Kawase blur, saturation matrix, ground mix, and noise sampling in a single pass.
- **P7**: Explicit z-order within layers independent of primitive kind.
- **P8**: Rounded rectangle and arbitrary path clipping on subtrees.
- **P9**: Text advance cache keyed by font, size, features, and text, exposed to the layout pass.
- **P10**: Headless deterministic surface rendering an element tree to RGBA buffers without a window at specified dimensions and device pixel ratio.

## Golden Assertions

Every patch has a corresponding golden test or invariant assertion in the repository tree to verify behavior across rebases:

- **P1**: Rasterization comparison of scaled and rotated subtrees against reference byte outputs at 1× and 2× DPR.
- **P2**: Interruption at 40% completion reverses from 40% with non-zero velocity; remounting mid-flight preserves progress.
- **P3**: Spring reaches rest within bounds without oscillating past declared damping; delayed animation maintains start value for the configured delay duration.
- **P4**: Hover transition generates a monotonic color ramp over declared duration; mid-transition state changes re-anchor without discontinuity.
- **P5**: `TranscriptUpdated` event generates damage rectangles bounded by the entry layout box; mounted animation damage is bounded by element bounds.
- **P6**: Blurred backdrop borders and dividers remain intact during hover repaints elsewhere in the window.
- **P7**: Primitive with higher z-order renders above lower z-order primitives regardless of kind.
- **P8**: Path-clipped subtree clips at path boundary at 1× and 2× DPR.
- **P9**: Layout fit calculation completes without secondary layout pass, verified via layout pass counter.
- **P10**: Identical scene produces identical RGBA byte output across multiple runs in one process and across separate processes.

## Patch Series Status

The `veyyon` branch is currently an exact ancestor of upstream: zero commits ahead. None of P1
through P10 is written. This crate therefore re-exports GPUI unmodified, and declares no patch
extension module until the patch it wraps exists on the branch. A module whose body is a comment
describing an unwritten patch is worse than an absent one, because it makes the crate look finished
to a reader and to a grep.

## Build Requirements

GPUI is a required dependency, not a cargo feature. Blade reaches Vulkan through ash's dynamically
loaded entry point, so the build needs no Vulkan headers: `libvulkan-dev` and `vulkan-tools` are not
prerequisites. What is required:

- The Vulkan loader at run time, `libvulkan.so.1` (Debian/Ubuntu package `libvulkan1`).
- A Vulkan ICD, such as the NVIDIA proprietary driver or Mesa.
- Wayland and XKB common development libraries, which the windowing backend links
  (`libwayland-dev`, `libxkbcommon-dev`, `libxkbcommon-x11-dev`).
- Fontconfig and FreeType development libraries (`libfontconfig-dev`, `libfreetype-dev`).
