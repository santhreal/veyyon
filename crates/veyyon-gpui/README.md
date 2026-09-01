# veyyon-gpui

Contains the GPUI renderer pin and patch extension interfaces for the veyyon desktop surface.

## Upstream and Fork Topology

GPUI is tracked as a fork of `zed-industries/zed` hosted at `santhreal/zed` on branch `veyyon`.
The dependency is pinned by commit revision in the workspace `Cargo.toml`.

## Rebase Policy

1. The `veyyon` branch contains upstream release tags plus the local patches, in series order, followed by any patch that carries a capability the series does not name.
2. The branch contains no merge commits and no squashed patch sequences.
3. Rebases occur on demand when upstream capabilities or fixes are required.
4. Each rebase reapplies the landed patches, in the order the status table below lists them, on top of the target upstream revision.
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

The workspace pins `4682106fc840da107787cd2e1722a280d0c8eefe`. Seven commits sit over upstream
`399258feeaf90ad8a3a208c99221ee87b6452f38`:

|series patch|commit|
|---|---|
|P1, affine transforms|`8253f6ed3b`|
|P2, animator identity|`d01551a128`|
|P3, spring integrator and native delay|`acd0490a45`|
|P6, backdrop material|`4682106fc8`|
|P10, headless deterministic surface|`9d4553735d`|
|(outside the series) inner shadow and inset hairline on a rounded rect|`c2518a463b`|
|(outside the series) per-corner radii on one quad primitive|`449fe47412`|

Three commit subjects on the branch state a patch number the series does not assign them:
`4682106fc8` says P4 and is P6, and the last two say P5 and P6 and are neither. Read the table
above, not the subject lines. A rebase reapplies the capabilities in this order and does not
reproduce those numbers.

P10 adds `WgpuContext::new_surfaceless`, `WgpuRenderer::new_offscreen`, `WgpuRenderer::read_pixels`
and `HeadlessAppContext::render_frame`, the last returning a `HeadlessFrame` of tightly-packed
straight-alpha RGBA8 at a given size and scale factor. Output is byte-identical across renders and
across processes: adapter selection scores discrete GPUs, the target is cleared to transparent
black before each frame, and wgpu's 256-byte row alignment is unpadded on readback. It also carries
the frame's text-run layouts and interactive hit rects in logical pixels, which is what lets an
offscreen frame answer which of its rectangles a click reaches.

The renderer is a process-wide resource: a third live `HeadlessAppContext` in one process aborts it
with SIGSEGV. `veyyon_desktop_scene::headless_context` hands back a context bound to a permit that
admits one at a time, and every consumer takes it from there.

P4, P5, P7, P8 and P9 are unwritten. This crate declares no patch extension module until the patch
it wraps exists on the branch. A module whose body is a comment describing an unwritten patch is
worse than an absent one, because it makes the crate look finished to a reader and to a grep.

## Build Requirements

GPUI is a required dependency, not a cargo feature. The renderer is wgpu, which reaches Vulkan
through ash's dynamically loaded entry point, so the build needs no Vulkan headers: `libvulkan-dev`
and `vulkan-tools` are not prerequisites. What is required:

- The Vulkan loader at run time, `libvulkan.so.1` (Debian/Ubuntu package `libvulkan1`).
- A Vulkan ICD, such as the NVIDIA proprietary driver or Mesa.
- Wayland and XKB common development libraries, which the windowing backend links
  (`libwayland-dev`, `libxkbcommon-dev`, `libxkbcommon-x11-dev`).
- Fontconfig and FreeType development libraries (`libfontconfig-dev`, `libfreetype-dev`).
