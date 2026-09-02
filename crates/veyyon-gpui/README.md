# veyyon-gpui

Contains the GPUI renderer snapshot and patch extension interfaces for the veyyon desktop surface.

## Upstream and Fork Topology

GPUI is tracked as a fork of `zed-industries/zed` hosted at `santhreal/zed` on branch `veyyon`.
The workspace consumes a snapshot of that branch: `scripts/vendor-gpui.ts` extracts the 23-crate
GPUI closure from one commit into `crates/vendor/<crate>` and records the commit in
`crates/vendor/GPUI_VENDOR_REV`. The vendored crates are excluded from the workspace and from
`cargo fmt --all`; their own suite runs in the fork. A renderer change is made in the fork, gated
there, pushed, and re-vendored. An edit made directly under `crates/vendor` is lost on the next run.

## Rebase Policy

1. The `veyyon` branch contains upstream release tags plus the local patches, in series order, followed by any patch that carries a capability the series does not name.
2. The branch contains no merge commits and no squashed patch sequences.
3. Rebases occur on demand when upstream capabilities or fixes are required.
4. Each rebase reapplies the landed patches, in the order the status table below lists them, on top of the target upstream revision.
5. The commit advancing the snapshot lists any patch adjustments required during the rebase.

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

- **P1**: Rasterization comparison of scaled and rotated subtrees against reference byte outputs at 1× and 2× DPR (`tests/a_scaled_and_rotated_subtree_rasterises_to_the_reference_at_1x_and_2x.rs`).
- **P2**: Interruption at 40% completion reverses from 40% with non-zero velocity; remounting mid-flight preserves progress (`tests/an_interrupted_animation_reverses_from_its_current_value_and_velocity.rs`).
- **P3**: Spring reaches rest within bounds without oscillating past declared damping; delayed animation maintains start value for the configured delay duration (`tests/a_spring_settles_within_its_bound_and_a_delay_holds_the_start_value.rs`).
- **P4**: Hover transition generates a monotonic color ramp over declared duration; mid-transition state changes re-anchor without discontinuity (`tests/a_hover_flip_ramps_monotonically_and_re_anchors_mid_ramp.rs`).
- **P5**: `TranscriptUpdated` event generates damage rectangles bounded by the entry layout box; mounted animation damage is bounded by element bounds (`tests/a_transcript_update_damages_only_its_own_entry.rs`).
- **P6**: Blurred backdrop borders and dividers remain intact during hover repaints elsewhere in the window (`tests/a_blurred_float_keeps_its_borders_across_a_repaint_elsewhere.rs`).
- **P7**: Primitive with higher z-order renders above lower z-order primitives regardless of kind (`tests/a_circle_declared_above_an_image_renders_above_it.rs`).
- **P8**: Path-clipped subtree clips at path boundary at 1× and 2× DPR (`tests/a_path_clipped_subtree_clips_at_the_path_boundary_at_1x_and_2x.rs`).
- **P9**: Layout fit calculation completes without secondary layout pass, verified via layout pass counter (`tests/a_row_that_fits_its_text_shapes_it_once.rs`).
- **P10**: Identical scene produces identical RGBA byte output across multiple runs in one process and across separate processes (`tests/the_headless_surface_renders_the_same_bytes_twice.rs`).

## Patch Series Status

The snapshot is `8a8c65c89c6cd92e1791f35f7d9a655ffac2e7e7`. Sixteen commits sit over upstream
`399258feeaf90ad8a3a208c99221ee87b6452f38`:

|series patch|commit|
|---|---|
|P10, headless deterministic surface|`32dbf750f6`, `86edfba9ba`, `9d4553735d`, `8a8c65c89c`|
|P1, affine transforms|`8253f6ed3b`|
|P2, animator identity|`d01551a128`|
|P3, spring integrator and native delay|`acd0490a45`|
|P4, animatable style properties|`95b7c37139`|
|P5, damage-scoped frame driver|`b1086a2089` (invalidation bounds), `dde119f7bb` (retained-frame scissored redraw)|
|P6, backdrop material|`4682106fc8`|
|P7, z-order within a layer|`bfdaa917b1`|
|P8, rounded and path clipping|`dde119f7bb`|
|P9, text advance cache|`5697924d66`|
|(outside the series) inner shadow and inset hairline on a rounded rect|`c2518a463b`|
|(outside the series) per-corner radii on one quad primitive|`449fe47412`|
|(outside the series) rustfmt pass over P5, P8 and P9|`717335f6b2`|

Three commit subjects on the branch state a patch number the series does not assign them:
`4682106fc8` says P4 and is P6, and `c2518a463b` and `449fe47412` say P5 and P6 and are neither.
Read the table above, not the subject lines. A rebase reapplies the capabilities in this order and
does not reproduce those numbers. P5 and P8 share `window.rs`, `scene.rs`, `shaders.wgsl` and
`wgpu_renderer.rs` and landed as one commit.

P5 renders every frame into a retained texture whenever the target accepts `COPY_DST`. A scene
that declares damage is drawn under a device-pixel scissor: the rectangle is cleared by a scissored
full-screen pipeline, only the affected primitives are drawn, and the retained frame is copied to
the acquired target. `Context::notify_within`, `Window::declare_damage`,
`Window::request_animation_frame_at_paint` and `Window::notify_at_paint` declare bounded
invalidation; `refresh`, plain `notify` and a resize repaint the whole viewport.

P8 gives `ContentMask` corner radii, so an `overflow_hidden` rounded element clips its children
with the same SDF as its border, and adds `Window::with_clip_path`, which rasterizes a path into an
intermediate texture and composites the clipped subtree through it.

P9 shapes each distinct (text, font size, runs) once and reuses the shaped line across frames
through a bounded LRU on `TextSystem`; `TextSystem::shaping_calls` counts the shapes a caller
observes.

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

The golden tests under `tests/` prove P1 (`a_scaled_and_rotated_subtree_rasterises_to_the_reference_at_1x_and_2x`),
P2 (`an_interrupted_animation_reverses_from_its_current_value_and_velocity`),
P3 (`a_spring_settles_within_its_bound_and_a_delay_holds_the_start_value`),
P4 (`a_hover_flip_ramps_monotonically_and_re_anchors_mid_ramp`),
P5 (`a_transcript_update_damages_only_its_own_entry`),
P6 (`a_blurred_float_keeps_its_borders_across_a_repaint_elsewhere`),
P7 (`a_circle_declared_above_an_image_renders_above_it`),
P8 (`a_path_clipped_subtree_clips_at_the_path_boundary_at_1x_and_2x`),
P9 (`a_row_that_fits_its_text_shapes_it_once`) and P10
(`the_headless_surface_renders_the_same_bytes_twice`) through the snapshot.

## Build Requirements

GPUI is a required dependency, not a cargo feature. The renderer is wgpu, which reaches Vulkan
through ash's dynamically loaded entry point, so the build needs no Vulkan headers: `libvulkan-dev`
and `vulkan-tools` are not prerequisites. What is required:

- The Vulkan loader at run time, `libvulkan.so.1` (Debian/Ubuntu package `libvulkan1`).
- A Vulkan ICD, such as the NVIDIA proprietary driver or Mesa.
- Wayland and XKB common development libraries, which the windowing backend links
  (`libwayland-dev`, `libxkbcommon-dev`, `libxkbcommon-x11-dev`).
- Fontconfig and FreeType development libraries (`libfontconfig-dev`, `libfreetype-dev`).
