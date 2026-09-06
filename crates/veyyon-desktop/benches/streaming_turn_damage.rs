//! §11 Fork benchmark: frame time and repainted pixel count for a streaming
//! turn. Compares damage-scoped invalidation (ON) against full-window redraw
//! (OFF) across a deterministic streaming turn corpus rendered headlessly on
//! GPU.

mod damage_report;

use std::{collections::HashMap, fs, io::Write, path::PathBuf, time::Instant};

use damage_report::{
	BenchComparison, BenchSummary, FrameSample, compute_stats, detect_gpu_name, print_report,
};
use veyyon_desktop::{
	SessionIndex, StartupBundle, discover_asset_paths, load_startup_bundle, project, request_frame,
};
use veyyon_desktop_model::{
	ConnectionState, ContentBlock, EntryId, HostEvent, MessageRole, SessionId, Store,
	StreamingMessageState, TranscriptEntry, reduce,
};
use veyyon_desktop_scene::{Headless, HeadlessSession, RenderOptions, headless_context};
use veyyon_desktop_surface::{ShellState, ShellView, damage::regions_changed, install_tokens};
use veyyon_gpui::AppContext;

const SEED: u64 = 0x5eed_cafe;
const DELTAS: usize = 48;
const PRIOR_ENTRIES: usize = 5;
const WARMUP_RUNS: usize = 1;
const MEASURE_RUNS: usize = 5;
const WORDS: &str = "# Damage Scoped Invalidation The renderer fork keeps previous frame pixels \
                     outside the declared damage rectangle so streaming turns save GPU fill rate \
                     bandwidth";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arm {
	DamageOn,
	DamageOff,
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

fn build_corpus(seed: u64) -> Vec<HostEvent> {
	let words: Vec<&str> = WORDS.split_whitespace().collect();
	let mut lcg = seed;
	let mut next = move || {
		lcg = lcg
			.wrapping_mul(6_364_136_223_846_793_005)
			.wrapping_add(1_442_695_040_888_963_407);
		(lcg >> 33) as usize
	};

	let prior = (0..PRIOR_ENTRIES)
		.map(|idx| {
			let role = if idx % 2 == 0 {
				MessageRole::User
			} else {
				MessageRole::Assistant
			};
			let text = (0..10 + (next() % 20))
				.map(|i| words[(i + idx) % words.len()])
				.collect::<Vec<_>>()
				.join(" ");
			entry(&format!("prior-{idx}"), role, &text, idx as u64 + 1)
		})
		.collect::<Vec<_>>();

	let mut events = vec![
		HostEvent::ConnectionChanged(ConnectionState::Connected {
			endpoint: "bench-endpoint".to_string(),
			protocol: 1,
		}),
		HostEvent::TranscriptAppended { revision: PRIOR_ENTRIES as u64, entries: prior },
	];

	let mut text = String::new();
	for delta in 0..DELTAS {
		for _ in 0..=(next() % 4) {
			if !text.is_empty() {
				text.push(' ');
			}
			text.push_str(words[next() % words.len()]);
		}
		let revision = PRIOR_ENTRIES as u64 + 1 + delta as u64;
		events.push(HostEvent::StreamingChanged(Some(StreamingMessageState {
			entry: EntryId::from("streaming-reply"),
			tool: None,
			accumulating: entry("streaming-reply", MessageRole::Assistant, &text, revision),
			revision,
		})));
	}
	let final_rev = PRIOR_ENTRIES as u64 + 2 + DELTAS as u64;
	events.push(HostEvent::StreamingChanged(None));
	events.push(HostEvent::TranscriptAppended {
		revision: final_rev,
		entries:  vec![entry("streaming-reply", MessageRole::Assistant, &text, final_rev)],
	});
	events
}

fn replay_arm(
	cx: &mut Headless,
	arm: Arm,
	options: &RenderOptions,
	corpus: &[HostEvent],
	bundle: &StartupBundle,
) -> Vec<FrameSample> {
	let mut session = HeadlessSession::open(cx, options, move |_, cx| {
		let inst = install_tokens(cx, &bundle.tokens, &bundle.theme, &bundle.surface_path)
			.expect("install tokens");
		cx.new(|_| ShellView::new(inst, ShellState::default()))
	})
	.expect("open headless session");

	let mut store = Store::new();
	store.persisted.shell.active_session = Some(SessionId::from("bench-session"));
	let mut index = SessionIndex::new();
	let mut drawn = ShellState::default();
	let mut samples = Vec::with_capacity(corpus.len());

	for (batch, event) in corpus.iter().enumerate() {
		let now_ms = 10_000 + batch as u64;
		session
			.update(|view, _, cx| {
				reduce(&mut store, event.clone());
				project(&store, &mut index, &HashMap::new(), now_ms, view.state_mut());
				match arm {
					Arm::DamageOn => {
						let invalidation = regions_changed(&drawn, view.state());
						drawn.clone_from(view.state());
						request_frame(view, &invalidation, cx);
					},
					Arm::DamageOff => cx.notify(),
				}
			})
			.expect("update view state");

		let raster_start = Instant::now();
		let _ = session.frame().expect("rasterise frame");
		let raster_time = raster_start.elapsed();

		let (damage, viewport) = session
			.update(|_, window, _| (window.last_frame_damage(), window.viewport_size()))
			.expect("read frame damage");

		let scale = f64::from(options.scale_factor);
		let repainted_device_px = damage.map_or_else(
			|| device_area(f64::from(viewport.width) * f64::from(viewport.height), scale),
			|rect| device_area(f64::from(rect.size.width) * f64::from(rect.size.height), scale),
		);
		samples.push(FrameSample { raster_time, repainted_device_px });
	}
	samples
}

fn device_area(logical_area: f64, scale: f64) -> u64 {
	(logical_area * scale * scale).round() as u64
}

fn main() {
	let mut cx = headless_context().expect("headless context on GPU host");
	let opt = RenderOptions::default();
	let bundle = load_startup_bundle(discover_asset_paths()).expect("load startup bundle");
	let corpus = build_corpus(SEED);
	let gpu = detect_gpu_name();

	println!("Running {WARMUP_RUNS} warmup iterations...");
	for _ in 0..WARMUP_RUNS {
		let _ = replay_arm(&mut cx, Arm::DamageOn, &opt, &corpus, &bundle);
		let _ = replay_arm(&mut cx, Arm::DamageOff, &opt, &corpus, &bundle);
	}

	println!(
		"Running {MEASURE_RUNS} measurement iterations ({} frames/arm)...",
		MEASURE_RUNS * corpus.len()
	);
	let mut on_runs = Vec::with_capacity(MEASURE_RUNS);
	let mut off_runs = Vec::with_capacity(MEASURE_RUNS);
	for i in 0..MEASURE_RUNS {
		print!("  iteration {}/{MEASURE_RUNS}... ", i + 1);
		let _ = std::io::stdout().flush();
		on_runs.push(replay_arm(&mut cx, Arm::DamageOn, &opt, &corpus, &bundle));
		off_runs.push(replay_arm(&mut cx, Arm::DamageOff, &opt, &corpus, &bundle));
		println!("done");
	}

	let on = compute_stats("DamageOn", &on_runs);
	let off = compute_stats("DamageOff", &off_runs);
	let px_savings = off
		.total_repainted_device_pixels
		.saturating_sub(on.total_repainted_device_pixels);
	let px_pct = (px_savings as f64 / off.total_repainted_device_pixels as f64) * 100.0;
	let time_savings = off.total_frame_raster_time_ms - on.total_frame_raster_time_ms;
	let time_pct = (time_savings / off.total_frame_raster_time_ms) * 100.0;
	let verified = on.total_repainted_device_pixels < off.total_repainted_device_pixels;

	let cmp = BenchComparison {
		pixel_savings_percent:            px_pct,
		pixel_reduction_device_px:        px_savings,
		raster_time_reduction_percent:    time_pct,
		raster_time_savings_ms:           time_savings,
		verified_damage_on_less_than_off: verified,
	};

	let vp_px =
		device_area(f64::from(opt.width) * f64::from(opt.height), f64::from(opt.scale_factor));
	let summary = BenchSummary {
		benchmark: "streaming_turn_damage",
		seed: format!("{SEED:#x}"),
		gpu,
		prior_entries: PRIOR_ENTRIES,
		streaming_deltas: DELTAS,
		total_events: corpus.len(),
		window_width: opt.width,
		window_height: opt.height,
		scale_factor: opt.scale_factor,
		viewport_device_pixels: vp_px,
		warmup_iterations: WARMUP_RUNS,
		measurement_iterations: MEASURE_RUNS,
		damage_on: on,
		damage_off: off,
		comparison: cmp,
	};

	let summary_path =
		PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.internal/bench/fork-damage.json");
	if let Some(parent) = summary_path.parent() {
		fs::create_dir_all(parent).expect("create summary parent dir");
	}
	fs::write(&summary_path, serde_json::to_string_pretty(&summary).expect("serialize summary"))
		.expect("write summary");

	print_report(&summary);
}
