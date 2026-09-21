//! WHY THIS SUITE EXISTS:
//! P5 keeps the previous frame's pixels outside the rectangle a frame
//! declares. The window's event loop projects each batch of host events,
//! diffs the result against the state it drew last (`regions_changed`), and
//! requests a frame inside the boxes the changed regions were laid out in
//! (`request_frame`). This is the bench §11 asks for: frame time and
//! repainted pixel count for a streaming turn, damage on versus off, same
//! corpus and seed. The off arm is the pre-P5 path, `cx.notify()` per batch,
//! and reproduces its baseline exactly: every frame repaints the viewport.
//!
//! THE CLASS THIS CLOSES: a scoped frame that under-declares. For every frame
//! of the corpus, every device pixel that differs from the previous full
//! render must lie inside the damage the frame declared. The corpus reaches
//! every transition a stream produces: a delta that keeps the entry's height,
//! a delta that grows it and slides every earlier turn up, the end of the
//! stream, and the appended final entry.
//!
//! WHAT IT DOES NOT CATCH: what the wgpu renderer does with the rect, which
//! `gpui_wgpu` proves on its own; a state change these events never produce;
//! a hover or a resize, which gpui invalidates itself, unscoped.

mod support;

use std::{
	collections::HashMap,
	path::PathBuf,
	time::{Duration, Instant},
};

use support::{
	raster::{contains, device_area, differing_pixels, inside},
	streaming_corpus::{DELTAS, SEED, corpus},
};
use veyyon_desktop::{
	AssetPaths, Repaint, SessionIndex, StartupBundle, load_startup_bundle, project, request_frame,
};
use veyyon_desktop_model::{SessionId, Store, reduce};
use veyyon_desktop_scene::{HeadlessSession, RenderOptions, RgbaFrame, headless_context};
use veyyon_desktop_surface::{
	ShellState, ShellView,
	damage::{Region, regions_changed},
	install_tokens,
};
use veyyon_gpui::{AppContext, Bounds, Pixels};

/// A frame of this corpus, event to drawn, on a workstation GPU. Generous by
/// an order of magnitude, so a hang shows as a failure and a slow machine
/// does not.
const FRAME_BUDGET: Duration = Duration::from_secs(2);
/// One display frame between batches, so the streaming caret blinks.
const FRAME: Duration = Duration::from_millis(16);

/// Which invalidation path a run drives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arm {
	/// The event loop's path: diff, then a frame scoped to what changed.
	DamageOn,
	/// The pre-P5 path: an unscoped notify per batch.
	DamageOff,
}

/// One frame's measurements.
#[derive(Debug, Clone, Copy)]
struct Sample {
	repainted_device_px: u64,
	elapsed:             Duration,
	/// What the batch asked the window to repaint.
	declared:            Repaint,
	/// What the window resolved the frame to, `None` for the whole viewport.
	damage:              Option<Bounds<Pixels>>,
	/// What the frame BEHIND it resolved to. A surface that animates arms the
	/// next frame while painting this one, so the repaint an animation costs
	/// lands here and nowhere else.
	armed_damage:        Option<Bounds<Pixels>>,
	entry_box_before:    Option<Bounds<Pixels>>,
	entry_box_after:     Option<Bounds<Pixels>>,
	composer_box:        Option<Bounds<Pixels>>,
}

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("load startup bundle")
}

/// Replays the corpus through the production path under one arm, one event
/// per batch, and returns a sample per frame beside the full raster drawn
/// after it.
fn replay(arm: Arm, options: &RenderOptions) -> Vec<(Sample, RgbaFrame)> {
	let mut cx = headless_context().expect("headless context must be available on the GPU host");
	let bundle = startup_assets();
	let (tokens, theme, surface_path) = (bundle.tokens, bundle.theme, bundle.surface_path);
	let mut session = HeadlessSession::open(&mut cx, options, move |_, cx| {
		let installed = install_tokens(cx, &tokens, &theme, &surface_path).expect("install tokens");
		cx.new(|_| ShellView::new(installed, ShellState::default()))
	})
	.expect("open the shell headlessly");

	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("bench-session"));
	let mut index = SessionIndex::new();
	let mut drawn = ShellState::default();
	let mut samples = Vec::with_capacity(DELTAS + 4);

	for (batch, event) in corpus().into_iter().enumerate() {
		// One display frame per batch. The clock a motion sampler reads is the
		// harness's: a replay that leaves it still reports the streaming
		// caret and every spring as settled, so the transcript never animates
		// and the arm never sees what an animating frame declares.
		session.advance(FRAME);
		let now_ms = 10_000 + (batch as u64 * FRAME.as_millis() as u64);
		let started = Instant::now();
		let (repaint, entry_box_before, last_turn) = session
			.update(|view, _, cx| {
				let last_turn = view.state().transcript.len().saturating_sub(1);
				let before = view.laid_out().bounds(Region::Turn(last_turn));
				reduce(&mut store, event);
				project(&store, &mut index, &HashMap::new(), now_ms, view.state_mut());
				let repaint = match arm {
					Arm::DamageOn => {
						let invalidation = regions_changed(&drawn, view.state());
						drawn.clone_from(view.state());
						request_frame(view, &invalidation, cx)
					},
					Arm::DamageOff => {
						cx.notify();
						Repaint::Full
					},
				};
				(repaint, before, view.state().transcript.len().saturating_sub(1))
			})
			.expect("reduce, project and request a frame");
		let elapsed = started.elapsed();
		assert!(elapsed < FRAME_BUDGET, "batch {batch}: {elapsed:?} exceeds {FRAME_BUDGET:?}");
		assert_ne!(
			repaint,
			Repaint::Nothing,
			"batch {batch}: every event in the corpus changes pixels"
		);

		// The batch's own draw already ran: marking the view dirty wakes the
		// window and the executor delivers that frame before `update`
		// returns, so the damage read here is what the batch repainted. The
		// vsync below is the frame the batch's own armed -- an animation
		// re-arming itself -- which has to stay inside the same entry. The
		// raster comes last, because a capture renders the window whole to
		// read its pixels back and the damage of the frame it draws states
		// what a readback costs rather than what the batch asked for.
		let (damage, viewport, entry_box_after, composer_box) = session
			.update(|view, window, _| {
				(
					window.last_frame_damage(),
					window.viewport_size(),
					view.laid_out().bounds(Region::Turn(last_turn)),
					view.laid_out().bounds(Region::Composer),
				)
			})
			.expect("read the frame's damage");
		session.vsync().expect("deliver the armed frame");
		let armed_damage = session
			.update(|_, window, _| window.last_frame_damage())
			.expect("read the armed frame's damage");
		let raster = session.frame().expect("rasterise the drawn frame").frame;
		let scale = f64::from(options.scale_factor);
		let repainted_device_px = damage.map_or_else(
			|| device_area(f64::from(viewport.width) * f64::from(viewport.height), scale),
			|rect| device_area(f64::from(rect.size.width) * f64::from(rect.size.height), scale),
		);
		samples.push((
			Sample {
				repainted_device_px,
				elapsed,
				declared: repaint,
				damage,
				armed_damage,
				entry_box_before,
				entry_box_after,
				composer_box,
			},
			raster,
		));
	}
	samples
}

#[test]
fn a_streaming_turn_repaints_inside_its_own_entry_and_the_bench_reports_the_delta() {
	let options = RenderOptions::default();
	let scale = options.scale_factor;
	let on = replay(Arm::DamageOn, &options);
	let off = replay(Arm::DamageOff, &options);
	assert_eq!(on.len(), off.len());
	let viewport_px =
		device_area(f64::from(options.width) * f64::from(options.height), f64::from(scale));

	// Parity: the off arm is the pre-P5 baseline, one viewport per frame. A
	// frame repaints the window whole under two spellings -- no damage at
	// all, and damage that is the viewport rectangle, which is what a motion
	// that cannot scope declares so the frame after it is scoped again. The
	// area either one repaints is the baseline, and it is one viewport.
	for (batch, (sample, _)) in off.iter().enumerate() {
		assert_eq!(
			sample.repainted_device_px, viewport_px,
			"off arm, batch {batch}: an unscoped notify repaints the viewport, and this frame \
			 repainted {:?}",
			sample.damage
		);
	}
	// Both arms draw the same pixels: the diff changes when a frame is
	// requested, never what it contains.
	for (batch, ((sample, on_frame), (_, off_frame))) in on.iter().zip(&off).enumerate() {
		if on_frame.as_bytes() == off_frame.as_bytes() {
			continue;
		}
		let differing = differing_pixels(off_frame, on_frame);
		let (x0, y0, x1, y1) = differing
			.iter()
			.fold((u32::MAX, u32::MAX, 0u32, 0u32), |(x0, y0, x1, y1), (x, y)| {
				(x0.min(*x), y0.min(*y), x1.max(*x), y1.max(*y))
			});
		panic!(
			"batch {batch}: the arms drew different frames. {} device pixels differ, in x \
			 {x0}..={x1}, y {y0}..={y1}; the scoped arm declared {:?} and the window resolved {:?}",
			differing.len(),
			sample.declared,
			sample.damage
		);
	}

	// A batch that scoped its frame has to reach the window scoped. Anything
	// that notifies without bounds in the same frame -- an animation callback
	// re-arming itself, a listener repainting on a state read -- widens the
	// frame back to the viewport, and the arm still passes a pixel comparison
	// against the unscoped baseline because both then repaint everything. The
	// caret blinks for the length of every streamed reply, so one such call
	// costs the whole mechanism.
	for (batch, (sample, _)) in on.iter().enumerate() {
		let Repaint::Within(declared) = sample.declared else {
			continue;
		};
		let Some(resolved) = sample.damage else {
			panic!(
				"batch {batch}: the batch declared {declared:?} and the window repainted the whole \
				 viewport"
			);
		};
		assert!(
			contains(&resolved, &declared),
			"batch {batch}: the window resolved {resolved:?}, which does not cover the declared \
			 {declared:?}"
		);
	}

	// Coverage: every pixel that changed lies inside the declared damage.
	let mut contained_frames = 0usize;
	let mut layout_moved_frames = 0usize;
	let mut previous_moved = true;
	for batch in 1..on.len() {
		let (sample, frame) = &on[batch];
		let (_, previous) = &on[batch - 1];
		let changed = differing_pixels(previous, frame);
		if let Some(damage) = sample.damage {
			let outside = changed
				.iter()
				.filter(|(x, y)| !inside(&damage, scale, *x, *y))
				.count();
			assert_eq!(
				outside,
				0,
				"batch {batch}: {outside} of {} changed device pixels lie outside the declared damage \
				 {damage:?}",
				changed.len()
			);
		}
		let moved = sample.entry_box_before != sample.entry_box_after;
		if moved {
			layout_moved_frames += 1;
		} else if !previous_moved {
			// Neither this frame nor the last moved the entry: the frame is the
			// M3 gate, a `TranscriptUpdated` for one entry damaging only the
			// surfaces that entry can reach: its own box and the composer's
			// float, whose backdrop blur reads the transcript's tail.
			let (Some(damage), Some(entry_box)) = (sample.damage, sample.entry_box_after) else {
				panic!("batch {batch}: a scoped frame without a damage rect or an entry box");
			};
			let reachable = sample
				.composer_box
				.map_or(entry_box, |float| entry_box.union(&float));
			assert!(
				contains(&reachable, &damage),
				"batch {batch}: damage {damage:?} escapes what the entry reaches {reachable:?}"
			);
			// The frame this one armed. A transcript that animates -- the
			// caret of a streaming reply, a scroll spring -- asks for the next
			// frame while painting this one, and asking without bounds widens
			// that frame to the viewport however tightly this one was scoped.
			// The caret blinks for the length of every streamed reply, so an
			// unscoped ask there repaints the window continuously through a
			// turn while the arm still reports a saving, because the frame it
			// samples is the one before the damage. A frame that moved layout
			// is exempt: a remeasure slides every turn under the one that
			// grew, and the boxes they vacate are not this frame's to name.
			assert!(
				sample.armed_damage.is_some(),
				"batch {batch}: the batch scoped its frame to {damage:?} and the frame it armed \
				 repainted the whole viewport"
			);
			contained_frames += 1;
		}
		previous_moved = moved;
	}
	assert!(contained_frames > 0, "the corpus never produced a delta inside one entry's box");
	assert!(layout_moved_frames > 0, "the corpus never grew the entry by a line");

	// The bench. Exact parity on corpus, inputs and seed; the delta is P5's.
	let on_total: u64 = on.iter().map(|(s, _)| s.repainted_device_px).sum();
	let off_total: u64 = off.iter().map(|(s, _)| s.repainted_device_px).sum();
	let on_time: Duration = on.iter().map(|(s, _)| s.elapsed).sum();
	let off_time: Duration = off.iter().map(|(s, _)| s.elapsed).sum();
	println!(
		"P5 streaming-turn bench: {} frames at {}x{}@{scale}, seed {SEED:#x}",
		on.len(),
		options.width,
		options.height
	);
	println!("batch  on_px      off_px     on_ms   off_ms  damage");
	for (batch, ((on_s, _), (off_s, _))) in on.iter().zip(&off).enumerate() {
		println!(
			"{batch:>5}  {:>9}  {:>9}  {:>6.2}  {:>6.2}  {}",
			on_s.repainted_device_px,
			off_s.repainted_device_px,
			on_s.elapsed.as_secs_f64() * 1e3,
			off_s.elapsed.as_secs_f64() * 1e3,
			on_s
				.damage
				.map_or_else(|| "viewport".to_string(), |d| format!("{d:?}")),
		);
	}
	println!(
		"totals: on {on_total} px in {:.1} ms, off {off_total} px in {:.1} ms, contained frames \
		 {contained_frames}, layout-moved frames {layout_moved_frames}",
		on_time.as_secs_f64() * 1e3,
		off_time.as_secs_f64() * 1e3,
	);
	assert!(
		on_total < off_total,
		"damage on repainted {on_total} device pixels, off repainted {off_total}: P5 saved nothing"
	);
}
