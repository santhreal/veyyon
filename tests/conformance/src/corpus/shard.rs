//! Deterministic routing of the corpus onto CI runners.
//!
//! Eight runners execute the whole corpus, and each has 180 seconds. Two things
//! have to be true for that to hold: a case must land on a runner that can
//! actually execute it, and the platform-agnostic bulk must be spread evenly,
//! so one runner is not still working while three sit idle.
//!
//! Routing is a pure function of the case id, not of iteration order, corpus
//! size or a counter. That means a runner can select its own share without
//! reading the other shards, a failing case can be reproduced by name on one
//! runner, and adding a case does not move the cases already routed.

use std::collections::BTreeMap;

use super::{ConformanceCase, Platform, TargetKind};

/// The runners, in id order.
///
/// Four Linux x64 machines share the `any` bulk; the other four platforms get
/// one each. The pool is Linux because that is where the platform-agnostic
/// cases run once rather than five times (see `manifest::PLATFORM_ALLOCATION`),
/// and it is four wide because that bulk is 96 % of the corpus.
pub const RUNNERS: [Runner; 8] = [
	Runner { id: 0, platform: Platform::LinuxX64, pool_slot: Some(0) },
	Runner { id: 1, platform: Platform::LinuxX64, pool_slot: Some(1) },
	Runner { id: 2, platform: Platform::LinuxX64, pool_slot: Some(2) },
	Runner { id: 3, platform: Platform::LinuxX64, pool_slot: Some(3) },
	Runner { id: 4, platform: Platform::LinuxArm64, pool_slot: None },
	Runner { id: 5, platform: Platform::MacosX64, pool_slot: None },
	Runner { id: 6, platform: Platform::MacosArm64, pool_slot: None },
	Runner { id: 7, platform: Platform::WindowsX64, pool_slot: None },
];

/// How many Linux x64 runners share the platform-agnostic bulk.
pub const POOL_WIDTH: u64 = 4;

/// Concurrent compiled-product launches allowed per runner.
///
/// A compiled case spawns a process, so it is bounded by memory and by the
/// filesystem rather than by CPU. Four is the measured point past which the
/// launches stop overlapping usefully on a two-core hosted runner; it is a
/// fixed budget rather than a function of core count so that a runner's wall
/// time does not change when the hosted machine class does.
pub const COMPILED_CONCURRENCY: usize = 4;

/// One CI runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Runner {
	pub id:        u8,
	/// The platform this runner is. A case is eligible only if it names this
	/// platform, or names no platform at all and this runner is in the pool.
	pub platform:  Platform,
	/// The runner's index within the platform-agnostic pool, or `None` when it
	/// only executes cases that name its platform.
	pub pool_slot: Option<u64>,
}

impl Runner {
	/// Whether this runner is allowed to execute `case`.
	///
	/// Separate from [`route`] on purpose: routing says where a case should go,
	/// eligibility says where it may go, and a router bug is only visible when
	/// the two are checked against each other.
	#[must_use]
	pub const fn may_execute(&self, case: &ConformanceCase) -> bool {
		match case.environment.platform {
			Platform::Any => self.pool_slot.is_some(),
			platform => matches_platform(platform, self.platform),
		}
	}
}

const fn matches_platform(wanted: Platform, runner: Platform) -> bool {
	// Matched on `wanted` exhaustively so that adding a platform to the enum
	// fails to compile here rather than routing to nothing at run time.
	match wanted {
		Platform::Any => false,
		Platform::LinuxX64 => matches!(runner, Platform::LinuxX64),
		Platform::LinuxArm64 => matches!(runner, Platform::LinuxArm64),
		Platform::MacosX64 => matches!(runner, Platform::MacosX64),
		Platform::MacosArm64 => matches!(runner, Platform::MacosArm64),
		Platform::WindowsX64 => matches!(runner, Platform::WindowsX64),
	}
}

/// The 64 bits of a case id used for pool selection.
///
/// The id is already a BLAKE3 digest, so its leading bytes are uniform and no
/// second hash is needed. A malformed id answers 0 rather than panicking: the
/// row is refused by `ConformanceCase::violations` long before it is routed,
/// and a router that panics turns one bad row into a runner with no results at
/// all.
fn id_entropy(case_id: &str) -> u64 {
	let hex = case_id.strip_prefix("blake3:").unwrap_or(case_id);
	let mut value = 0u64;
	for byte in hex.bytes().take(16) {
		let Some(digit) = (byte as char).to_digit(16) else {
			return 0;
		};
		value = (value << 4) | u64::from(digit);
	}
	value
}

/// The runner that executes `case`.
///
/// Total: every case has a runner. A platform-specific case goes to the one
/// runner that is that platform; a platform-agnostic case goes to the pool slot
/// its id selects.
#[must_use]
pub fn route(case: &ConformanceCase) -> Runner {
	if case.environment.platform == Platform::Any {
		let slot = id_entropy(&case.case_id) % POOL_WIDTH;
		return RUNNERS
			.into_iter()
			.find(|runner| runner.pool_slot == Some(slot))
			.expect("the pool is POOL_WIDTH wide and every slot below it exists");
	}
	RUNNERS
		.into_iter()
		.find(|runner| matches_platform(case.environment.platform, runner.platform))
		.expect("every platform in the enum has a runner")
}

/// How many cases each runner received.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Distribution {
	pub by_runner:          BTreeMap<u8, usize>,
	pub compiled_by_runner: BTreeMap<u8, usize>,
	pub total:              usize,
}

impl Distribution {
	/// Route every case and count the result.
	#[must_use]
	pub fn of<'a>(cases: impl IntoIterator<Item = &'a ConformanceCase>) -> Self {
		let mut distribution = Self::default();
		for runner in RUNNERS {
			distribution.by_runner.insert(runner.id, 0);
			distribution.compiled_by_runner.insert(runner.id, 0);
		}
		for case in cases {
			let runner = route(case);
			*distribution.by_runner.entry(runner.id).or_default() += 1;
			if case.target.kind == TargetKind::CompiledProduct {
				*distribution
					.compiled_by_runner
					.entry(runner.id)
					.or_default() += 1;
			}
			distribution.total += 1;
		}
		distribution
	}

	/// The pool runners' shares.
	#[must_use]
	pub fn pool_shares(&self) -> Vec<usize> {
		RUNNERS
			.into_iter()
			.filter(|runner| runner.pool_slot.is_some())
			.map(|runner| self.by_runner.get(&runner.id).copied().unwrap_or(0))
			.collect()
	}

	/// The pool's imbalance: the widest share's distance from the mean, as a
	/// fraction of the mean. 0 when the pool is empty.
	#[must_use]
	pub fn pool_skew(&self) -> f64 {
		let shares = self.pool_shares();
		let total: usize = shares.iter().sum();
		if total == 0 || shares.is_empty() {
			return 0.0;
		}
		let mean = ratio(total) / ratio(shares.len());
		let widest = shares
			.iter()
			.map(|share| (ratio(*share) - mean).abs())
			.fold(0.0f64, f64::max);
		widest / mean
	}
}

/// usize to f64 for the ratio arithmetic below.
///
/// Every count here is a case count — at most a few hundred thousand — which is
/// far below f64's exact-integer range, so the conversion loses nothing. The
/// exemption is stated once here rather than at each of the four call sites.
#[expect(
	clippy::cast_precision_loss,
	reason = "case counts are far below 2^53, so the conversion is exact"
)]
const fn ratio(count: usize) -> f64 {
	count as f64
}

/// How many standard deviations of hash noise the pool is allowed to show.
///
/// Six, because a false red here is expensive — it accuses the router of a bug
/// on a run that was fine — and the failure this bound exists to catch is not
/// subtle. A router that stopped hashing puts everything on one slot, which is
/// a skew of `POOL_WIDTH - 1`; that is hundreds of sigma at any corpus size, so
/// widening the gate from three sigma to six costs nothing in detection.
pub const POOL_SKEW_SIGMAS: f64 = 6.0;

/// The pool imbalance a run of `pool_total` agnostic cases tolerates.
///
/// This is not a fixed percentage, and the difference matters. Each case lands
/// on a slot independently with probability `1/W`, so a slot's share is
/// binomial: its standard deviation is `sqrt(n·p·(1-p))` and its mean is `n·p`,
/// which makes the RATIO of the two shrink as `1/sqrt(n)`. A flat 2 % bound is
/// therefore simultaneously too tight for a small run and too loose for a large
/// one — the first spelling of this function used one, and it failed a
/// perfectly even 4,000-case pool while it would have passed a 240,000-case
/// pool that had lost a whole generator family.
///
/// `sqrt((1-p)/(n·p))` is that ratio, times [`POOL_SKEW_SIGMAS`].
#[must_use]
pub fn max_pool_skew(pool_total: usize) -> f64 {
	let width = pool_width();
	if pool_total == 0 || width < 2 {
		return 0.0;
	}
	let slot_probability = 1.0 / ratio(width);
	POOL_SKEW_SIGMAS * ((1.0 - slot_probability) / (ratio(pool_total) * slot_probability)).sqrt()
}

/// How many runners share the platform-agnostic bulk.
///
/// Counted from [`RUNNERS`] rather than restated, so the pool cannot be widened
/// in one place and not the other. [`POOL_WIDTH`] is the same number as a `u64`
/// for the modulus; the two are pinned against each other in this module's
/// tests, because a modulus larger than the pool would select a slot no runner
/// owns.
#[must_use]
pub fn pool_width() -> usize {
	RUNNERS
		.into_iter()
		.filter(|runner| runner.pool_slot.is_some())
		.count()
}

/// Every reason a routed corpus cannot be executed as sharded.
#[must_use]
pub fn violations<'a>(cases: impl IntoIterator<Item = &'a ConformanceCase> + Clone) -> Vec<String> {
	let mut problems = Vec::new();

	for case in cases.clone() {
		let runner = route(case);
		if !runner.may_execute(case) {
			problems.push(format!(
				"case {} wants {} but routed to runner {} ({})",
				case.case_id, case.environment.platform, runner.id, runner.platform
			));
		}
	}

	let distribution = Distribution::of(cases);
	for runner in RUNNERS {
		if distribution.by_runner.get(&runner.id).copied().unwrap_or(0) == 0 {
			problems.push(format!("runner {} ({}) received no cases", runner.id, runner.platform));
		}
	}
	let skew = distribution.pool_skew();
	let allowed = max_pool_skew(distribution.pool_shares().iter().sum());
	if skew > allowed {
		problems.push(format!("pool skew {skew:.4} exceeds {allowed:.4}"));
	}
	problems
}

#[cfg(test)]
mod tests {
	use std::collections::{BTreeMap, BTreeSet};

	use super::{
		Distribution, POOL_WIDTH, RUNNERS, id_entropy, max_pool_skew, pool_width, ratio, route,
		violations,
	};
	use crate::{
		corpus::{
			ClockMode, ConformanceCase, Contract, Coverage, Environment, GeneratorInfo, Oracle,
			Platform, Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind,
		},
		rng::Rng,
	};

	fn a_case(index: u64, platform: Platform, kind: TargetKind) -> ConformanceCase {
		let clock = match kind {
			TargetKind::DirectRust => ClockMode::Virtual,
			TargetKind::CompiledProduct => ClockMode::RealBounded,
		};
		ConformanceCase {
			schema_version: SCHEMA_VERSION,
			case_id:        String::new(),
			generator:      GeneratorInfo { family: "shard-test".to_owned(), seed: index },
			subsystem:      Subsystem::CliEngineModes,
			contract:       Contract {
				id:                format!("cli.route.{index}"),
				expected_error_id: None,
			},
			target:         Target { kind, entry: "veyyon".to_owned() },
			dimensions:     BTreeMap::from([("index".to_owned(), index.to_string())]),
			environment:    Environment {
				platform,
				clock,
				filesystem_fixture: None,
				provider_fixture: None,
			},
			stimulus:       vec![Stimulus {
				kind:  "argv".to_owned(),
				value: format!("--version {index}"),
			}],
			oracle:         Oracle { exit_code: Some(0), ..Oracle::default() },
			coverage:       Coverage::default(),
			provenance:     Provenance::Generated,
		}
		.seal()
	}

	/// A corpus shaped like the manifest's partition but two orders of magnitude
	/// smaller: platform-agnostic bulk plus an equal slice of each platform, on
	/// both target kinds.
	fn a_corpus() -> Vec<ConformanceCase> {
		let mut cases = Vec::new();
		for index in 0..4_000 {
			cases.push(a_case(index, Platform::Any, TargetKind::DirectRust));
		}
		let specific = [
			Platform::LinuxX64,
			Platform::LinuxArm64,
			Platform::MacosX64,
			Platform::MacosArm64,
			Platform::WindowsX64,
		];
		for (offset, platform) in specific.into_iter().enumerate() {
			let slice = 10_000 + u64::try_from(offset).expect("five platforms fit") * 1_000;
			for index in 0..40 {
				cases.push(a_case(slice + index, platform, TargetKind::DirectRust));
				cases.push(a_case(slice + index + 500, platform, TargetKind::CompiledProduct));
			}
		}
		cases
	}

	/// WHY: the router is the only thing standing between "8 runners execute the
	/// corpus" and "a Windows case is handed to a Linux machine and reported as
	/// a product failure". Every case must land somewhere it can actually run.
	#[test]
	fn every_case_lands_on_a_runner_that_may_execute_it() {
		let corpus = a_corpus();
		for case in &corpus {
			let runner = route(case);
			assert!(
				runner.may_execute(case),
				"{} routed to runner {}",
				case.environment.platform,
				runner.id
			);
		}
		assert!(violations(corpus.iter()).is_empty());
	}

	/// WHY: routing must be a function of the case id alone. If it depended on
	/// iteration order or corpus size, a runner could not select its own share
	/// without reading the others, and adding one case would move cases that
	/// were already passing.
	#[test]
	fn routing_depends_on_the_case_id_and_nothing_else() {
		let corpus = a_corpus();
		let forward: Vec<u8> = corpus.iter().map(|case| route(case).id).collect();
		let mut shuffled: Vec<&ConformanceCase> = corpus.iter().collect();
		let mut rng = Rng::for_label(3, "shuffle");
		for index in (1..shuffled.len()).rev() {
			let swap = usize::try_from(rng.below(u64::try_from(index).expect("index fits") + 1))
				.expect("slot fits");
			shuffled.swap(index, swap);
		}
		let by_id: BTreeMap<&str, u8> = shuffled
			.iter()
			.map(|case| (case.case_id.as_str(), route(case).id))
			.collect();
		for (case, runner) in corpus.iter().zip(forward) {
			assert_eq!(by_id.get(case.case_id.as_str()).copied(), Some(runner));
		}
	}

	/// WHY: the bound catches a router that stopped hashing. This is the arm
	/// that would have to go red for a constant slot, a truncated id, or a
	/// modulus by the wrong width.
	#[test]
	fn the_agnostic_bulk_is_spread_across_the_whole_pool() {
		let distribution = Distribution::of(a_corpus().iter());
		let shares = distribution.pool_shares();
		let agnostic: usize = shares.iter().sum();
		assert_eq!(shares.len(), pool_width());
		assert!(shares.iter().all(|share| *share > 0), "{shares:?}");
		let allowed = max_pool_skew(agnostic);
		assert!(
			distribution.pool_skew() <= allowed,
			"skew {} allowed {allowed} shares {shares:?}",
			distribution.pool_skew()
		);
	}

	/// WHY: the pool modulus and the number of pool runners are two spellings of
	/// one number, in two places. If the modulus were the larger, `route` would
	/// select a slot no runner owns and panic on a case that is perfectly valid;
	/// if it were the smaller, a runner would sit idle and its share of the
	/// corpus would never be executed while the run stayed green.
	#[test]
	fn the_pool_modulus_is_the_number_of_pool_runners() {
		assert_eq!(u64::try_from(pool_width()).expect("pool width fits"), POOL_WIDTH);
		let slots: BTreeSet<u64> = RUNNERS
			.into_iter()
			.filter_map(|runner| runner.pool_slot)
			.collect();
		assert_eq!(slots, (0..POOL_WIDTH).collect::<BTreeSet<u64>>());
	}

	/// WHY: the tolerance is a function of run size, and the reason it has to be
	/// is that hash noise shrinks as 1/sqrt(n) while a flat percentage does not.
	/// A bound that stopped scaling would either accuse an even small pool or
	/// pass a large one that had lost a generator family; both have happened
	/// here, in that order. The collapsed case is far outside the bound at every
	/// size, which is what makes six sigma affordable.
	#[test]
	fn the_tolerance_tightens_as_the_run_grows() {
		let small = max_pool_skew(4_000);
		let full = max_pool_skew(240_000);
		assert!(full < small, "small {small} full {full}");
		assert!(small < 0.2, "a 4,000-case pool should tolerate hash noise, not 20%: {small}");
		assert!(full < 0.03, "a 240,000-case pool must be held tight: {full}");

		// A router that stopped hashing puts every case on one slot: the widest
		// share is the whole pool, so the skew is POOL_WIDTH - 1.
		let collapsed = ratio(pool_width()) - 1.0;
		assert!(collapsed > small && collapsed > full, "collapse must be caught at every size");

		assert_eq!(max_pool_skew(0), 0.0);
	}

	/// WHY: an empty runner is a silent hole — its share of the corpus was never
	/// executed and the run is still green. The report has to name it.
	#[test]
	fn a_runner_that_received_nothing_is_named() {
		let only_linux: Vec<ConformanceCase> = (0..64)
			.map(|index| a_case(index, Platform::Any, TargetKind::DirectRust))
			.collect();
		let problems = violations(only_linux.iter());
		let named: BTreeSet<u8> = RUNNERS
			.into_iter()
			.filter(|runner| runner.pool_slot.is_none())
			.map(|runner| runner.id)
			.collect();
		assert_eq!(problems.len(), named.len(), "{problems:?}");
		for id in named {
			assert!(
				problems
					.iter()
					.any(|line| line.contains(&format!("runner {id} "))),
				"{problems:?}"
			);
		}
	}

	/// WHY: a skewed pool must be reported as skew, not as a pass with an
	/// uneven-looking log. Every agnostic case is forced onto one slot by giving
	/// them all the same id entropy, which is what a broken hash looks like.
	#[test]
	fn a_pool_that_collapsed_onto_one_slot_is_reported_as_skew() {
		let mut cases = a_corpus();
		let collapsed = cases
			.iter()
			.find(|case| case.environment.platform == Platform::Any)
			.expect("the corpus has agnostic cases")
			.clone();
		for case in &mut cases {
			if case.environment.platform == Platform::Any {
				case.case_id = collapsed.case_id.clone();
			}
		}
		let problems = violations(cases.iter());
		assert!(problems.iter().any(|line| line.contains("pool skew")), "{problems:?}");
		assert!(
			problems
				.iter()
				.any(|line| line.contains("received no cases")),
			"{problems:?}"
		);
	}

	/// WHY: compiled cases are the expensive ones and they are also the ones a
	/// mis-shard would pile onto one machine. Each platform's compiled slice
	/// belongs to exactly one runner, and the launch budget is what keeps that
	/// runner inside its 180 seconds.
	#[test]
	fn compiled_cases_stay_on_the_runner_that_is_their_platform() {
		let corpus = a_corpus();
		let distribution = Distribution::of(corpus.iter());
		for runner in RUNNERS {
			let compiled = distribution
				.compiled_by_runner
				.get(&runner.id)
				.copied()
				.unwrap_or(0);
			if runner.pool_slot.is_some() && runner.platform != Platform::LinuxX64 {
				assert_eq!(compiled, 0);
			}
		}
		let launched: usize = distribution.compiled_by_runner.values().sum();
		let compiled: Vec<&ConformanceCase> = corpus
			.iter()
			.filter(|case| case.target.kind == TargetKind::CompiledProduct)
			.collect();
		assert_eq!(launched, compiled.len());

		// Each platform's compiled slice is indivisible: it belongs to the one
		// runner that is that platform, so a slice split across runners would
		// mean a machine launching a binary it cannot execute.
		for platform in Platform::all() {
			let slice: Vec<&&ConformanceCase> = compiled
				.iter()
				.filter(|case| case.environment.platform == platform)
				.collect();
			if slice.is_empty() {
				continue;
			}
			let owners: BTreeSet<u8> = slice.iter().map(|case| route(case).id).collect();
			assert_eq!(owners.len(), 1, "{platform} compiled slice spread across {owners:?}");
		}
	}

	/// WHY: the router must not panic on an id it cannot read. A malformed row
	/// is refused by `violations` on the case itself, and a router that
	/// panicked would turn one bad row into a runner that produced no results
	/// at all.
	#[test]
	fn an_unreadable_case_id_routes_instead_of_panicking() {
		assert_eq!(id_entropy("blake3:zzzz"), 0);
		assert_eq!(id_entropy(""), 0);
		assert_ne!(id_entropy("blake3:0123456789abcdef0123456789abcdef"), 0);

		let mut case = a_case(1, Platform::Any, TargetKind::DirectRust);
		case.case_id = "not-a-digest".to_owned();
		assert!(route(&case).pool_slot.is_some());
	}
}
