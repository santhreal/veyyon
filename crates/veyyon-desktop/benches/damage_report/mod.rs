//! The measured half of the streaming-turn bench: per-frame samples folded
//! into an arm report, the two arms compared, and the summary printed as the
//! table the pull request carries.

use std::{fs, time::Duration};

use serde::Serialize;

#[derive(Debug, Clone, Copy)]
pub struct FrameSample {
	pub raster_time:         Duration,
	pub repainted_device_px: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ArmReport {
	pub arm: &'static str,
	pub frames_drawn: usize,
	pub total_repainted_device_pixels: u64,
	pub mean_repainted_device_pixels_per_frame: f64,
	pub total_frame_raster_time_ms: f64,
	pub mean_frame_raster_time_ms: f64,
	pub p95_frame_raster_time_ms: f64,
	pub min_frame_raster_time_ms: f64,
	pub max_frame_raster_time_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchComparison {
	pub pixel_savings_percent:            f64,
	pub pixel_reduction_device_px:        u64,
	pub raster_time_reduction_percent:    f64,
	pub raster_time_savings_ms:           f64,
	pub verified_damage_on_less_than_off: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BenchSummary {
	pub benchmark:              &'static str,
	pub seed:                   String,
	pub gpu:                    String,
	pub prior_entries:          usize,
	pub streaming_deltas:       usize,
	pub total_events:           usize,
	pub window_width:           u32,
	pub window_height:          u32,
	pub scale_factor:           f32,
	pub viewport_device_pixels: u64,
	pub warmup_iterations:      usize,
	pub measurement_iterations: usize,
	pub damage_on:              ArmReport,
	pub damage_off:             ArmReport,
	pub comparison:             BenchComparison,
}

pub fn compute_stats(arm_name: &'static str, runs: &[Vec<FrameSample>]) -> ArmReport {
	let frames_drawn = runs[0].len();
	let total_repainted_device_pixels: u64 = runs[0].iter().map(|s| s.repainted_device_px).sum();
	let mean_repainted_device_pixels_per_frame =
		total_repainted_device_pixels as f64 / frames_drawn as f64;
	let mut times: Vec<Duration> = runs
		.iter()
		.flat_map(|r| r.iter().map(|s| s.raster_time))
		.collect();
	times.sort();
	let n = times.len();
	let p95_idx = ((n as f64 * 0.95).round() as usize).min(n - 1);
	let sum_times: Duration = times.iter().copied().sum();
	let sum_run_times: Duration = runs
		.iter()
		.map(|r| r.iter().map(|s| s.raster_time).sum::<Duration>())
		.sum();

	ArmReport {
		arm: arm_name,
		frames_drawn,
		total_repainted_device_pixels,
		mean_repainted_device_pixels_per_frame,
		total_frame_raster_time_ms: (sum_run_times / runs.len() as u32).as_secs_f64() * 1e3,
		mean_frame_raster_time_ms: (sum_times / n as u32).as_secs_f64() * 1e3,
		p95_frame_raster_time_ms: times[p95_idx].as_secs_f64() * 1e3,
		min_frame_raster_time_ms: times[0].as_secs_f64() * 1e3,
		max_frame_raster_time_ms: times[n - 1].as_secs_f64() * 1e3,
	}
}

pub fn detect_gpu_name() -> String {
	fs::read_dir("/proc/driver/nvidia/gpus")
		.ok()
		.and_then(|mut entries| entries.next())
		.and_then(Result::ok)
		.and_then(|e| fs::read_to_string(e.path().join("information")).ok())
		.and_then(|info| {
			info.lines().find_map(|l| {
				l.strip_prefix("Model:")
					.map(|m| format!("{} (Vulkan)", m.trim()))
			})
		})
		.unwrap_or_else(|| "unknown GPU (Vulkan; /proc/driver/nvidia unreadable)".to_string())
}

pub fn fmt_k(n: u64) -> String {
	let s = n.to_string();
	let mut out = String::new();
	let rem = s.len() % 3;
	for (i, ch) in s.chars().enumerate() {
		if i > 0 && (i % 3 == rem || (rem == 0 && i % 3 == 0)) {
			out.push(',');
		}
		out.push(ch);
	}
	out
}

pub fn print_report(summary: &BenchSummary) {
	let BenchSummary {
		gpu,
		seed,
		prior_entries,
		streaming_deltas,
		total_events,
		window_width,
		window_height,
		scale_factor,
		viewport_device_pixels,
		warmup_iterations,
		measurement_iterations,
		damage_on: on,
		damage_off: off,
		comparison: cmp,
		benchmark: _,
	} = summary;
	let sep = "-".repeat(80);
	println!("\n{}", "=".repeat(80));
	println!("VEYYON DESKTOP §11 FORK BENCHMARK: STREAMING TURN DAMAGE-SCOPED REPAINT");
	println!("{}", "=".repeat(80));
	println!("Host GPU          : {gpu}");
	println!("Seed              : {seed}");
	println!(
		"Corpus            : {prior_entries} prior entries, {streaming_deltas} streaming deltas \
		 ({total_events} events)"
	);
	println!(
		"Window            : {window_width}x{window_height} @ {scale_factor:.1}x (Viewport: {} \
		 device px)",
		fmt_k(*viewport_device_pixels)
	);
	println!(
		"Harness           : {warmup_iterations} warmup, {measurement_iterations} measurement ({} \
		 frames/arm)",
		measurement_iterations * total_events
	);
	println!("Summary written   : .internal/bench/fork-damage.json\n{sep}");
	println!(
		"{:<33} {:>18} {:>18} {:>18}\n{sep}",
		"Metric", "Damage ON (Scoped)", "Damage OFF (Full)", "Delta / Savings"
	);

	let p95_delta = (on.p95_frame_raster_time_ms - off.p95_frame_raster_time_ms)
		/ off.p95_frame_raster_time_ms
		* 100.0;
	let rows = [
		(
			"Total Repainted Pixels / Turn",
			format!("{} px", fmt_k(on.total_repainted_device_pixels)),
			format!("{} px", fmt_k(off.total_repainted_device_pixels)),
			format!("{:.2}%", -cmp.pixel_savings_percent),
		),
		(
			"Mean Repainted Pixels / Frame",
			format!("{} px", fmt_k(on.mean_repainted_device_pixels_per_frame.round() as u64)),
			format!("{} px", fmt_k(off.mean_repainted_device_pixels_per_frame.round() as u64)),
			format!("{:.2}%", -cmp.pixel_savings_percent),
		),
		(
			"Total Frame Raster Time (turn)",
			format!("{:.2} ms", on.total_frame_raster_time_ms),
			format!("{:.2} ms", off.total_frame_raster_time_ms),
			format!(
				"{:.2} ms ({:.2}%)",
				-cmp.raster_time_savings_ms, -cmp.raster_time_reduction_percent
			),
		),
		(
			"Mean Frame Raster Time",
			format!("{:.2} ms", on.mean_frame_raster_time_ms),
			format!("{:.2} ms", off.mean_frame_raster_time_ms),
			format!("{:.2}%", -cmp.raster_time_reduction_percent),
		),
		(
			"p95 Frame Raster Time",
			format!("{:.2} ms", on.p95_frame_raster_time_ms),
			format!("{:.2} ms", off.p95_frame_raster_time_ms),
			format!("{p95_delta:.2}%"),
		),
		(
			"Min Frame Raster Time",
			format!("{:.2} ms", on.min_frame_raster_time_ms),
			format!("{:.2} ms", off.min_frame_raster_time_ms),
			"-".into(),
		),
		(
			"Max Frame Raster Time",
			format!("{:.2} ms", on.max_frame_raster_time_ms),
			format!("{:.2} ms", off.max_frame_raster_time_ms),
			"-".into(),
		),
	];
	for (name, o, f, d) in rows {
		println!("{name:<33} {o:>18} {f:>18} {d:>18}");
	}
	println!("{sep}");
	if cmp.verified_damage_on_less_than_off {
		println!(
			"VERDICT: PASS (Damage ON repainted strictly fewer pixels: {} < {})\n{}",
			fmt_k(on.total_repainted_device_pixels),
			fmt_k(off.total_repainted_device_pixels),
			"=".repeat(80)
		);
	} else {
		println!(
			"VERDICT: FAIL (Damage ON repainted {} >= OFF {})\n{}",
			on.total_repainted_device_pixels,
			off.total_repainted_device_pixels,
			"=".repeat(80)
		);
		std::process::exit(1);
	}
}
