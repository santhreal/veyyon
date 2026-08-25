//! Pure Windows Job Object `CpuRate` conversion.
//!
//! Lives outside `windows.rs` so the conversion is compiled and tested on
//! every host. `CpuRate` is a fraction of TOTAL machine capacity (`10_000` =
//! every logical processor). Using this process's affinity mask as the
//! denominator is the conversion bug: a 2-core budget inside a 2-of-16 slice
//! becomes `10_000` = 100% of the host. The Windows backend asks
//! `GetActiveProcessorCount` for the host count, then these helpers for the
//! rate.

#![cfg_attr(
	not(windows),
	allow(
		dead_code,
		reason = "the Windows backend is cfg'd out; this module exists so Linux CI tests the \
		          conversion"
	)
)]

/// Whether rate control is on, and if so the `CpuRate` in `1..=10_000`.
///
/// Zero, negative, or non-finite cores must DISABLE the cap (`ControlFlags =
/// 0`). Flooring those inputs to `CpuRate` 1 with `HARD_CAP` left `/cpu-limit
/// remove` and `session.cpuLimitCores: 0` throttling the job to 0.01% of the
/// machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CpuRateControl {
	pub enabled: bool,
	pub rate:    u32,
}

/// The `CpuRate` value for a **positive** budget of `cores` cores on a machine
/// with `cpus` logical processors.
///
/// `CpuRate` is cycles per `10_000` cycles of TOTAL machine capacity, so a core
/// count has to be expressed as a fraction of the whole machine first: 4 cores
/// on 16 processors is `2_500`, not `40_000`. The three edges each have a
/// reason:
///
/// - Clamped at the top, because a budget at or past the machine's core count
///   means the whole machine and a `CpuRate` above `10_000` is rejected
///   outright by `SetInformationJobObject`, which would leave the job with NO
///   cap.
/// - Clamped at the bottom against negative or NaN input.
/// - Floored at 1, because `CpuRate` 0 with `HARD_CAP` set is also rejected,
///   and a tiny-but-nonzero budget must round to the smallest cap the API can
///   express rather than to "no cap at all".
///
/// Callers that mean "no cap" must go through [`cpu_rate_control`], not this.
pub(super) fn cpu_rate_per_10k(cores: f64, cpus: f64) -> u32 {
	let cpus = if cpus.is_finite() && cpus > 0.0 {
		cpus
	} else {
		1.0
	};
	let fraction = (cores / cpus).clamp(0.0, 1.0);
	(fraction * 10_000.0).round().max(1.0) as u32
}

pub(super) fn cpu_rate_control(cores: f64, cpus: f64) -> CpuRateControl {
	if cores.is_finite() && cores > 0.0 {
		CpuRateControl { enabled: true, rate: cpu_rate_per_10k(cores, cpus) }
	} else {
		CpuRateControl { enabled: false, rate: 0 }
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Using the affinity/container slice as the denominator grants the host.
	///
	/// A 2-core budget inside a 2-of-16 slice is `1_250` (12.5% of the machine),
	/// not `10_000`. `apply_rate` has to ask `GetActiveProcessorCount`, not
	/// `available_parallelism`, for this reason.
	#[test]
	fn a_budget_equal_to_an_affinity_slice_is_still_a_fraction_of_the_host() {
		assert_eq!(cpu_rate_per_10k(2.0, 16.0), 1_250);
		assert_eq!(
			cpu_rate_per_10k(2.0, 2.0),
			10_000,
			"the affinity-slice denominator is the bug: 2 of 2 looks like the whole machine"
		);
	}

	/// A core count becomes a fraction of the WHOLE MACHINE, not of one core.
	///
	/// This is the conversion the whole Windows backend rests on and the one
	/// place it differs in kind from the Linux backend, where `cpu.max` is
	/// expressed against a fixed period and the machine size never enters.
	/// Forgetting to divide by the processor count is the natural mistake, and
	/// its result is not a visible error: `CpuRate` `40_000` is out of range,
	/// the call is rejected, and the job runs with no cap while the settings
	/// row still says four cores. The exact expected values are computed by
	/// hand from the API contract (cycles per `10_000` of total capacity), not
	/// read back from the implementation.
	#[test]
	fn a_core_budget_becomes_a_fraction_of_total_machine_capacity() {
		assert_eq!(
			cpu_rate_per_10k(4.0, 16.0),
			2_500,
			"4 of 16 processors is a quarter of the machine"
		);
		assert_eq!(cpu_rate_per_10k(1.0, 8.0), 1_250);
		assert_eq!(cpu_rate_per_10k(0.5, 8.0), 625);
		assert_eq!(cpu_rate_per_10k(6.0, 32.0), 1_875);
		assert_ne!(cpu_rate_per_10k(4.0, 16.0), cpu_rate_per_10k(4.0, 8.0));
		assert_eq!(cpu_rate_per_10k(4.0, 8.0), 5_000);
	}

	#[test]
	fn a_budget_at_or_past_the_machine_size_saturates_at_the_whole_machine() {
		assert_eq!(cpu_rate_per_10k(8.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(9.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(1_000.0, 8.0), 10_000);
	}

	#[test]
	fn a_positive_budget_too_small_to_express_floors_at_the_smallest_cap_not_at_zero() {
		assert_eq!(cpu_rate_per_10k(0.001, 128.0), 1);
		assert_eq!(cpu_rate_control(0.001, 128.0), CpuRateControl { enabled: true, rate: 1 });
		assert_eq!(cpu_rate_control(1e-12, 128.0), CpuRateControl { enabled: true, rate: 1 });
		assert_eq!(cpu_rate_control(1e-10, 128.0), CpuRateControl { enabled: true, rate: 1 });
		assert_eq!(cpu_rate_control(4e-6, 128.0), CpuRateControl { enabled: true, rate: 1 });
		assert_eq!(cpu_rate_control(f64::MIN_POSITIVE, 128.0), CpuRateControl {
			enabled: true,
			rate:    1,
		});
		for step in 1..=20 {
			let cores = 10f64.powi(-step);
			assert!(cores > 0.0, "grid must stay a positive finite budget");
			let control = cpu_rate_control(cores, 128.0);
			assert!(control.enabled, "positive cores={cores:?} must enable rate control");
			assert!(
				control.rate >= 1,
				"positive cores={cores:?} must floor at rate >= 1, got {control:?}"
			);
		}
	}

	#[test]
	fn non_finite_and_non_positive_cores_disable_rate_control_not_a_freeze() {
		for cores in [0.0, -1.0, -4.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
			assert_eq!(
				cpu_rate_control(cores, 8.0),
				CpuRateControl { enabled: false, rate: 0 },
				"cores={cores:?} must disable rate control, never freeze"
			);
		}
		assert_eq!(cpu_rate_control(2.0, 8.0), CpuRateControl { enabled: true, rate: 2_500 });
	}

	#[test]
	fn cpu_rate_control_holds_for_a_grid_of_core_and_host_sizes() {
		for host in [1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0] {
			let mut previous = 0u32;
			for step in 1..=200 {
				let cores = step as f64 / 10.0;
				let control = cpu_rate_control(cores, host);
				assert!(control.enabled, "positive cores must enable rate control");
				assert!((1..=10_000).contains(&control.rate), "rate {} out of range", control.rate);
				assert!(control.rate >= previous, "rate must be monotonic in cores");
				previous = control.rate;
			}
			assert_eq!(cpu_rate_control(host, host).rate, 10_000);
			assert!(!cpu_rate_control(0.0, host).enabled);
		}
	}

	#[test]
	fn neighbouring_budgets_do_not_collapse_onto_the_same_rate() {
		assert_eq!(cpu_rate_per_10k(1.0, 32.0), 313, "1/32 is 312.5, rounded half away from zero");
		assert_eq!(cpu_rate_per_10k(1.5, 32.0), 469);
		assert_eq!(cpu_rate_per_10k(2.0, 32.0), 625);
	}

	/// WHY: Rate calculation must handle degenerate denominators (zero,
	/// negative, or non-finite cpus) safely by defaulting to 1.0 logical
	/// processor, and must disable rate control when the core budget is zero.
	#[test]
	fn rate_calculation_boundaries_zero_and_degenerate_cpus() {
		// When cpus is 0.0 or negative, cpu_rate_per_10k defaults to 1.0 cpu
		assert_eq!(cpu_rate_per_10k(1.0, 0.0), 10_000);
		assert_eq!(cpu_rate_per_10k(0.5, 0.0), 5_000);
		assert_eq!(cpu_rate_per_10k(1.0, -0.0), 10_000);
		assert_eq!(cpu_rate_per_10k(1.0, -8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(1.0, f64::NAN), 10_000);
		assert_eq!(cpu_rate_per_10k(1.0, f64::INFINITY), 10_000);

		// Zero core budget disables rate control for any host size
		for host in [0.0, 1.0, 4.0, 16.0, 128.0, f64::INFINITY] {
			assert_eq!(
				cpu_rate_control(0.0, host),
				CpuRateControl { enabled: false, rate: 0 },
				"0 cores on host {host} must disable rate control"
			);
			assert_eq!(
				cpu_rate_control(-0.0, host),
				CpuRateControl { enabled: false, rate: 0 },
				"-0.0 cores on host {host} must disable rate control"
			);
		}
	}

	/// WHY: Overflow and extreme inputs must saturate at the whole machine cap
	/// (`10_000`) without integer overflow, and negative/NaN inputs must
	/// disable rate control.
	#[test]
	fn rate_calculation_boundaries_saturating_and_overflow_inputs() {
		// Extreme positive core counts saturate at 10_000
		for extreme in [f64::MAX, 1e308, 1e20, 10_000.0] {
			assert_eq!(
				cpu_rate_control(extreme, 16.0),
				CpuRateControl { enabled: true, rate: 10_000 },
				"extreme core count {extreme} must saturate at 10_000"
			);
		}

		// Extreme negative core counts disable rate control
		for neg in [f64::MIN, -1e308, -1e20, f64::NEG_INFINITY] {
			assert_eq!(
				cpu_rate_control(neg, 16.0),
				CpuRateControl { enabled: false, rate: 0 },
				"negative core count {neg} must disable rate control"
			);
		}

		// Tiny positive subnormal cores floor at rate 1
		assert_eq!(cpu_rate_control(f64::MIN_POSITIVE, 16.0), CpuRateControl {
			enabled: true,
			rate:    1,
		});

		// Massive host sizes result in rate 1
		assert_eq!(cpu_rate_control(1.0, f64::MAX), CpuRateControl { enabled: true, rate: 1 });
	}

	/// WHY: When a budget is set exactly equal to the host core count, the rate
	/// must be exactly `10_000` (100% of host capacity), neither under-allocated
	/// nor clamped to a wrong limit.
	#[test]
	fn rate_calculation_boundaries_budget_exactly_at_limit() {
		for host in [0.5, 1.0, 2.0, 3.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0, 256.0, 1024.0] {
			assert_eq!(
				cpu_rate_per_10k(host, host),
				10_000,
				"budget matching host size {host} must produce exactly 10_000 rate"
			);
			assert_eq!(
				cpu_rate_control(host, host),
				CpuRateControl { enabled: true, rate: 10_000 },
				"budget matching host size {host} must enable rate control at 10_000"
			);
		}
	}

	/// WHY: Rate arithmetic must terminate for all IEEE 754 float inputs and
	/// strictly satisfy the rate invariants: rate in `1..=10_000` when enabled,
	/// rate == 0 when disabled.
	#[test]
	fn rate_accounting_terminates_and_satisfies_bounds() {
		let test_floats = [
			f64::NEG_INFINITY,
			f64::MIN,
			-1e100,
			-100.0,
			-1.0,
			-0.001,
			-0.0,
			0.0,
			f64::MIN_POSITIVE,
			1e-15,
			0.001,
			0.5,
			1.0,
			2.0,
			4.0,
			8.0,
			16.0,
			64.0,
			128.0,
			1e6,
			1e100,
			f64::MAX,
			f64::INFINITY,
			f64::NAN,
		];

		for &cores in &test_floats {
			for &cpus in &test_floats {
				let control = cpu_rate_control(cores, cpus);
				if control.enabled {
					assert!(
						control.rate >= 1 && control.rate <= 10_000,
						"enabled rate for cores={cores}, cpus={cpus} must be in 1..=10_000, got \
						 {control:?}"
					);
				} else {
					assert_eq!(
						control.rate, 0,
						"disabled rate for cores={cores}, cpus={cpus} must be 0, got {control:?}"
					);
				}
			}
		}
	}
}
