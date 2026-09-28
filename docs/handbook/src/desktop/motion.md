# Motion

Easing curves, springs, keyed animators, and reduced-motion resolution are
`gpui::motion`, defined in the `motion` crate of Santh GPUI. The models every
transition in the window runs on are defined in
`crates/veyyon-desktop-ui/src/theme/motion.rs`.

## Models

| Model | Transition | Default |
| --- | --- | --- |
| `REGION` | The sidebar, right panel and terminal drawer opening, closing, and settling after a resize | Spring settling in about 0.26 s, damping ratio 0.92 |
| `LAYOUT` | A row moving to a new position, a section expanding or collapsing | Spring settling in about 0.30 s, damping ratio 0.86 |
| `REVEAL` | A transcript entry appearing, rising 6px while it fades in | 160 ms |
| `STREAM_FADE` | A run of streamed text fading in | 120 ms |
| `POPOVER_OPEN` | A palette, menu or popover opening, scaling up from 0.98 | 120 ms |
| `POPOVER_CLOSE` | A palette, menu or popover closing | 90 ms, decelerating |
| `HOVER` | A hover or press colour change | 80 ms, linear |

A spinner takes 0.8 s for one turn.

## Reduced motion

The window reduces motion when the operating system requests it:

| Platform | Setting |
| --- | --- |
| Linux | `org.freedesktop.appearance` `reduced-motion`, else `org.gnome.desktop.interface` `enable-animations`, read through the XDG desktop portal |
| Windows | Show animations in Windows (`SPI_GETCLIENTAREAANIMATION`) |
| macOS | Reduce motion (`accessibilityDisplayShouldReduceMotion`) |

Under reduced motion, position and scale land at once, and a fade lasts at most
80 ms. A spinner draws a static dot and requests no frame. On Linux the window
opens with full motion until the portal answers.

## Evaluation and interruption

Each transition runs its values on `Animator`s. Redirecting a target samples the
active animation at the interruption time and uses that value as the new
starting value. Spring models keep the sampled velocity; duration models
evaluate their easing curve from the new starting value. The window requests
frames only while a value moves.

## Capture

Use the [native recorder](surfaces.md#record-native-interactions) to record a
transition on a private display. Follow the
[capture requirements](../foundations/verification.md) for paired animated
clips. A still image does not establish transition timing.

`proof/scenes/desktop-motion.sh` records a control clip of the pointer crossing
the idle window's top edge, then the sidebar and the right panel closing and
opening. x11grab draws the pointer into every frame, so the control clip holds
the capture interval unless the recorder drops frames. The
[surface scenes](surfaces.md#surface-scenes) table lists the scene with the
commands that record its arms.
