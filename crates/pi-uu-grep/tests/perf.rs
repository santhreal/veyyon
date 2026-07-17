//! Ignored deterministic timing harness for the in-process rg builtin.
//!
//! Run with:
//! PI_UU_GREP_PERF_ROOT=/path/to/large/repo cargo test --profile ci -p
//! pi-uu-grep --test perf -- --ignored --nocapture --test-threads=1

use std::{
	ffi::OsString,
	hint::black_box,
	path::PathBuf,
	process::{Command, Stdio},
	time::{Duration, Instant},
};

const MEASURED_ITERATIONS: usize = 5;

/// Full-corpus search throughput: walk + read + regex over a real tree, for a
/// pattern with (almost) no matches so print cost stays out of the number.
/// Differential twin runs the system `rg` binary on the same query when it is
/// installed, so the builtin's gap to upstream stays measured.
#[test]
#[ignore = "run with: PI_UU_GREP_PERF_ROOT=/path/to/large/repo cargo test --profile ci -p \
            pi-uu-grep --test perf -- --ignored --nocapture --test-threads=1"]
fn perf_rg_real_corpus() {
	let Some(root) = std::env::var_os("PI_UU_GREP_PERF_ROOT") else {
		println!("BENCH perf_rg_real_corpus: SKIPPED — set PI_UU_GREP_PERF_ROOT=/path/to/large/repo to run");
		return;
	};
	let root = PathBuf::from(root);
	assert!(root.is_dir(), "PI_UU_GREP_PERF_ROOT must name an existing directory: {}", root.display());
	let queries: [(&str, &[&str]); 3] = [
		("rare_literal", &["zzqqxxjjkkvvbbnnww"]),
		("files_with_match", &["-l", "SPDX-License"]),
		("regex_word", &["-c", r"\bunreachable\b"]),
	];
	for (name, args) in queries {
		let mut code = 0;
		run_bench(&format!("perf_rg_builtin_{name}"), || {
			let mut argv: Vec<OsString> = vec!["rg".into()];
			argv.extend(args.iter().map(OsString::from));
			argv.push(root.clone().into());
			code = pi_uu_grep::run_rg(argv);
			code as usize
		});
		assert!(code == 0 || code == 1, "rg builtin should exit 0/1, got {code}");
		if Command::new("rg").arg("--version").stdout(Stdio::null()).status().is_ok() {
			run_bench(&format!("perf_rg_system_{name}"), || {
				let status = Command::new("rg")
					.args(args)
					.arg(&root)
					.stdout(Stdio::null())
					.stderr(Stdio::null())
					.status()
					.expect("system rg should spawn");
				status.code().unwrap_or(2) as usize
			});
		} else {
			println!("BENCH perf_rg_system_{name}: SKIPPED — no system rg on PATH");
		}
	}
}

fn run_bench(name: &str, mut run: impl FnMut() -> usize) {
	black_box(run());

	let mut timings = [Duration::ZERO; MEASURED_ITERATIONS];
	for timing in &mut timings {
		let started = Instant::now();
		let observed = run();
		let elapsed = started.elapsed();
		black_box(observed);
		*timing = elapsed;
	}

	timings.sort_unstable();
	let median_ms = timings[MEASURED_ITERATIONS / 2].as_secs_f64() * 1_000.0;
	println!("BENCH {name}: {median_ms:.3} ms");
}
