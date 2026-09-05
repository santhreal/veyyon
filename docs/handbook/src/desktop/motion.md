# Motion

Motion definitions are in `crates/veyyon-desktop-motion`. Defaults are configured
in `crates/veyyon-desktop-tokens/tokens/motion.toml`.

## Palette transitions

The model picker and slash palette use the `float` role. Opening combines a
four-pixel vertical rise with a 90 ms opacity transition. The position uses a
spring with stiffness 300, damping 24, and mass 1.

Closing retains the overlay until both position and opacity settle. Pointer
activation is blocked on the retained closing content. Reopening during a
transition starts from its sampled position rather than restarting at the hidden
position. The spring also retains its sampled velocity.

Animation state persists separately from the rendered element tree. The shell
requests another frame while the transition is active and stops requesting
animation frames after it settles.

## Role table

The shared token table defines these timing models. A role definition does not
by itself animate a surface; the surface must evaluate and apply it.

| Role | Default model | Reduced-motion resolution |
| --- | --- | --- |
| `tint` | 120 ms, ease out | Instant |
| `reveal` | Spring: stiffness 220, damping 26, mass 1 | 60 ms opacity only |
| `float` | Spring plus rise and fade | 60 ms opacity only |
| `panel` | Direct interaction, then spring: stiffness 180, damping 22, mass 1 | Instant |
| `shift` | 200 ms layout transition, ease out | Instant |
| `scroll` | 240 ms, ease in and out | Instant |
| `caret` | 900 ms two-step period | Steady on |

`resolve_motion` selects the reduced variant. For palette floats, reduced motion
sets vertical displacement to zero and applies the 60 ms opacity transition.

## Evaluation and interruption

`AnimatorRegistry` indexes animations by surface, role, and slot. Position and
opacity use separate slots. Redirecting a target samples the active animation at
the interruption time and uses that value as the new starting value. Spring
models use the sampled velocity; duration models evaluate their easing curve from
the new starting value.

The spring implementation evaluates a closed-form damped oscillator using
elapsed time. Rest requires both a position difference below 0.001 and an absolute
velocity below 0.01 in the animated value's units. Palette position is normalized
before conversion to pixels.

## Capture

Use the [native interaction scene](surfaces.md#record-native-interactions) to
record palette opening, closing, and repeated interruption on the private X11
display. The scene includes sustained transitions so idle pauses do not constitute
the entire motion sample.

Follow the [capture requirements](../foundations/verification.md) for paired
animated clips. A still image does not establish transition timing.
