# Viewport travel

A scrolled viewport walks to its new offset instead of cutting to it. The plan
below is what the recording scrolls: every step is numbered so a frame taken
mid-travel names the rows it is passing.

## Why

Step 01 — A page down replaced the screen between two frames.
Step 02 — Nothing on screen said which direction the content went.
Step 03 — The scrollbar thumb was the only clue, and it arrived first.
Step 04 — A reader had to re-find their place after every notch.
Step 05 — The rest of the surface already travels: selections, bands, gauges.

## The value

Step 06 — One number, `SettleValue`, on the shared motion clock.
Step 07 — The curve is `MOTION.move`: spring 260/30/1, the selection curve.
Step 08 — The first offset a viewport is given lands. Nothing animates a mount.
Step 09 — Every later offset travels.
Step 10 — A target changed mid-flight keeps the velocity it already had.
Step 11 — A wheel notch held down is therefore one continuous travel.

## One value, two readings

Step 12 — `getScrollOffset()` answers with the TARGET.
Step 13 — The keyboard lives at the target: page down twice pages twice.
Step 14 — `render()` slices the rows at the TRAVELLED value, rounded.
Step 15 — The thumb reads the same travelled value.
Step 16 — So the bar can never report a scroll the rows have not made.
Step 17 — A thumb that leads its rows is the bug this ordering forbids.

## What travels and what lands

Step 18 — A wheel notch travels.
Step 19 — An arrow travels.
Step 20 — A page travels.
Step 21 — A jump to a section of the table of contents travels.
Step 22 — Both ends land: home, end, and the tail of a live transcript.
Step 23 — A viewport following its own tail must never lag behind the tail.
Step 24 — A re-layout lands: the content changed under the offset.
Step 25 — A change smaller than two rows lands: there is nothing to watch.
Step 26 — A jump further than two screens lands: a blur is not a reading.
Step 27 — A pre-windowed viewport lands: the caller slices its own rows.

## The hosts

Step 28 — The fullscreen agent transcript viewer.
Step 29 — The plan review overlay, which is the surface this file is shown in.
Step 30 — Both are the viewports that outlive a single render.
Step 31 — Each lends the viewport its own repaint and takes it back on dispose.
Step 32 — `display.transitions: off` paints byte for byte what it painted before.

## The suite

Step 33 — Travel and monotonicity: the offset never goes backwards en route.
Step 34 — Frame count pinned against a reference `MOTION.move` animation.
Step 35 — The thumb never leads the rows, sampled every frame of a travel.
Step 36 — Single row, both ends, and a jump too far all land in one frame.
Step 37 — A travel survives the renders that happen during it.
Step 38 — Content shrinking under a live travel clamps the painted value.
Step 39 — A mode switch mid-travel lands rather than paints a stale row.
Step 40 — Motion off is byte identity, and dispose returns the clock.

## The gate

Step 41 — Fourteen mutations, fourteen reds.
Step 42 — The rows paint the target again.
Step 43 — The thumb reads the target.
Step 44 — A render lands the travel it finds.
Step 45 — No jump is ever too far.
Step 46 — A pre-windowed viewport travels a value nobody reads.
Step 47 — The travel floor is gone.
Step 48 — The painted value is not clamped.
Step 49 — The offset paints unrounded.
Step 50 — The viewport travels on the gauge's curve.
Step 51 — The curve option is ignored.
Step 52 — Every one of them red, and the restore proven by checksum.

## The proof

Step 53 — Two arms of the same scene, recorded in a real terminal.
Step 54 — Before: the offset cuts, and consecutive frames share no rows.
Step 55 — After: the offset walks, and the frames between hold the rows between.
Step 56 — The strips below are eight consecutive frames of one page down.
Step 57 — Read them left to right and the rows slide.
Step 58 — Read the before strip and there are two states with nothing between.

## Notes

Step 59 — `MOTION.move` was in the curve table before anything used it.
Step 60 — `SettleValue` gained a curve option rather than a second spring owner.
Step 61 — One owner for a number that walks, two curves for two speeds.
Step 62 — The gauge keeps `MOTION.settle`, which is slower on purpose.
Step 63 — A scroll is a reading, not a report, so it is the faster of the two.
Step 64 — End of plan.
