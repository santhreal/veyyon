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

use std::{
	collections::HashMap,
	path::PathBuf,
	time::{Duration, Instant},
};

use veyyon_desktop::{
	AssetPaths, Repaint, SessionIndex, StartupBundle, load_startup_bundle, project, request_frame,
};
use veyyon_desktop_model::{
	ConnectionState, ContentBlock, EntryId, HostEvent, MessageRole, SessionId, Store,
	StreamingMessageState, TranscriptEntry, reduce,
};
use veyyon_desktop_scene::{HeadlessSession, RenderOptions, RgbaFrame, headless_context};
use veyyon_desktop_surface::{
	ShellState, ShellView,
	damage::{Region, regions_changed},
	install_tokens,
};
use veyyon_gpui::{AppContext, Bounds, Pixels};

const SEED: u64 = 0x5eed_cafe;
const DELTAS: usize = 48;
const PRIOR_ENTRIES: usize = 5;
/// A frame of this corpus, event to drawn, on a workstation GPU. Generous by
/// an order of magnitude, so a hang shows as a failure and a slow machine
/// does not.
const FRAME_BUDGET: Duration = Duration::from_secs(2);

const WORDS: [&str; 16] = [
	"the",
	"walker",
	"caches",
	"every",
	"entry",
	"it",
	"visits",
	"and",
	"prunes",
	"ignored",
	"directories",
	"before",
	"descending",
	"so",
	"a",
	"search",
];

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
	damage:              Option<Bounds<Pixels>>,
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

fn entry(id: &str, role: MessageRole, text: &str, revision: u64) -> TranscriptEntry {
	TranscriptEntry {
		id: EntryId::from(id),
		parent: None,
		revision,
		timestamp_ms: 1_000 + revision,
		role,
		content: vec![ContentBlock::Text { text: text.to_string() }],
		meta: None,
		raw_discriminator: "text".to_string(),
		raw: serde_json::json!({}),
	}
}

/// The corpus: the events a host sends while one assistant turn streams,
/// after five settled entries. Deterministic in `SEED`; both arms replay
/// exactly this sequence.
fn corpus() -> Vec<HostEvent> {
	let mut lcg = SEED;
	let mut next = move || {
		lcg = lcg
			.wrapping_mul(6_364_136_223_846_793_005)
			.wrapping_add(1_442_695_040_888_963_407);
		(lcg >> 33) as usize
	};

	let prior = (0..PRIOR_ENTRIES)
		.map(|index| {
			let role = if index % 2 == 0 {
				MessageRole::User
			} else {
				MessageRole::Assistant
			};
			let text = (0..12 + next() % 30)
				.map(|i| WORDS[(i + index) % WORDS.len()])
				.collect::<Vec<_>>();
			entry(&format!("prior-{index}"), role, &text.join(" "), index as u64 + 1)
		})
		.collect();

	let mut events = vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "bench".to_string(),
			protocol: 1,
		}),
		HostEvent::TranscriptAppended { revision: PRIOR_ENTRIES as u64, entries: prior },
	];

	let mut accumulated = String::new();
	for delta in 0..DELTAS {
		for _ in 0..=(next() % 4) {
			if !accumulated.is_empty() {
				accumulated.push(' ');
			}
			accumulated.push_str(WORDS[next() % WORDS.len()]);
		}
		let revision = PRIOR_ENTRIES as u64 + 1 + delta as u64;
		events.push(HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry: EntryId::from("streaming"),
			tool: None,
			accumulating: entry("streaming", MessageRole::Assistant, &accumulated, revision),
			revision,
		})));
	}
	let final_revision = PRIOR_ENTRIES as u64 + 2 + DELTAS as u64;
	events.push(HostEvent::StreamingChanged(None));
	events.push(HostEvent::TranscriptAppended {
		revision: final_revision,
		entries:  vec![entry("streaming", MessageRole::Assistant, &accumulated, final_revision)],
	});
	events
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
		let now_ms = 10_000 + batch as u64;
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
		let scale = f64::from(options.scale_factor);
		let repainted_device_px = damage.map_or_else(
			|| device_area(f64::from(viewport.width) * f64::from(viewport.height), scale),
			|rect| device_area(f64::from(rect.size.width) * f64::from(rect.size.height), scale),
		);
		let raster = session.frame().expect("rasterise the drawn frame").frame;
		samples.push((
			Sample {
				repainted_device_px,
				elapsed,
				damage,
				entry_box_before,
				entry_box_after,
				composer_box,
			},
			raster,
		));
	}
	samples
}

fn device_area(logical_area: f64, scale: f64) -> u64 {
	(logical_area * scale * scale).round() as u64
}

/// The device pixels that differ between two rasters of equal size.
fn differing_pixels(before: &RgbaFrame, after: &RgbaFrame) -> Vec<(u32, u32)> {
	assert_eq!((before.width(), before.height()), (after.width(), after.height()));
	let width = before.width() as usize;
	before
		.as_bytes()
		.as_chunks::<4>()
		.0
		.iter()
		.zip(after.as_bytes().as_chunks::<4>().0)
		.enumerate()
		.filter(|(_, (a, b))| a != b)
		.map(|(i, _)| ((i % width) as u32, (i / width) as u32))
		.collect()
}

/// Whether a device pixel lies inside a logical rectangle at `scale`. The
/// rectangle is widened to whole device pixels, which is what the renderer's
/// scissor does with a fractional edge.
fn inside(rect: &Bounds<Pixels>, scale: f32, x: u32, y: u32) -> bool {
	let left = (f32::from(rect.origin.x) * scale).floor();
	let top = (f32::from(rect.origin.y) * scale).floor();
	let right = ((f32::from(rect.origin.x) + f32::from(rect.size.width)) * scale).ceil();
	let bottom = ((f32::from(rect.origin.y) + f32::from(rect.size.height)) * scale).ceil();
	let (x, y) = (x as f32, y as f32);
	x >= left && x < right && y >= top && y < bottom
}

fn contains(outer: &Bounds<Pixels>, inner: &Bounds<Pixels>) -> bool {
	inner.origin.x >= outer.origin.x
		&& inner.origin.y >= outer.origin.y
		&& inner.origin.x + inner.size.width <= outer.origin.x + outer.size.width + Pixels::from(0.01)
		&& inner.origin.y + inner.size.height
			<= outer.origin.y + outer.size.height + Pixels::from(0.01)
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

	// Parity: the off arm is the pre-P5 baseline, one viewport per frame.
	for (batch, (sample, _)) in off.iter().enumerate() {
		assert_eq!(
			sample.damage, None,
			"off arm, batch {batch}: an unscoped notify repaints the viewport"
		);
		assert_eq!(sample.repainted_device_px, viewport_px);
	}
	// Both arms draw the same pixels: the diff changes when a frame is
	// requested, never what it contains.
	for (batch, ((_, on_frame), (_, off_frame))) in on.iter().zip(&off).enumerate() {
		assert_eq!(
			on_frame.as_bytes(),
			off_frame.as_bytes(),
			"batch {batch}: the arms drew different frames"
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
