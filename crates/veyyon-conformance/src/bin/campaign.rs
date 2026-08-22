//! The mutation campaign runner.
//!
//! Breaks one token of Rust source at a time, rebuilds, runs the owning
//! package's library suite, and records whether anything went red. The gate in
//! [`veyyon_conformance::mutation`] does the accounting; this binary spends the
//! CPU and appends to a resumable ledger.
//!
//! ```text
//! campaign [--limit N] [--deadline SECONDS] [--run-cap SECONDS] [--ledger PATH] [--report]
//! ```
//!
//! `--report` reads the ledger and prints the verdict without running anything.
//! Every other invocation attempts up to `--limit` mutants that the ledger does
//! not already carry, stopping early once `--deadline` seconds have elapsed, so
//! an interrupted campaign resumes instead of restarting and a chunk under a
//! wall-clock cap ends between mutants with the tree restored.
//!
//! `--run-cap` bounds one mutant's suite. A mutation that removes a loop's exit
//! makes the suite hang rather than fail, and an unbounded wait spends the
//! whole chunk on it; past the cap the run's process group is killed and the
//! mutant is recorded as killed.
//!
//! # What this campaign can and cannot cover
//!
//! It mutates the Rust that exists: this crate and `veyyon-natives`. Five of
//! the six [`CriticalPath`]s — credentials, path containment, artifact
//! checksums, authorization and tool completeness — have no Rust owner yet, so
//! no mutant can land on them and the gate reports each as uncovered. That is
//! the honest result and the reason the campaign is red: the shortfall is
//! migration debt, not a weak suite. Faking coverage by mutating a Rust
//! reimplementation of TypeScript is what issue #877 forbids.
//!
//! Inline `#[cfg(test)]` modules are excluded from planning. A mutant inside a
//! test mutates the oracle, and a suite that kills it has proved nothing.

use std::{
	collections::BTreeSet,
	env, fs,
	os::unix::process::CommandExt,
	path::{Path, PathBuf},
	process::{Child, Command, ExitStatus, Stdio},
	thread,
	time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use veyyon_conformance::mutation::{
	Campaign, CriticalPath, Gate, Mutant, Operator, Outcome, Record, plan,
};

/// Ledger row version. A row written by an older shape is refused rather than
/// read with today's meaning.
const LEDGER_SCHEMA: u32 = 1;

/// Where mutants are drawn from: a package and the source root it owns.
const SOURCES: [(&str, &str); 2] = [
	("veyyon-conformance", "crates/veyyon-conformance/src"),
	("veyyon-natives", "crates/veyyon-natives/src"),
];

/// One appended ledger row.
#[derive(Debug, Serialize, Deserialize)]
struct Row {
	schema:   u32,
	id:       String,
	operator: String,
	package:  String,
	file:     String,
	offset:   usize,
	before:   String,
	after:    String,
	outcome:  String,
	path:     Option<String>,
	seconds:  u64,
}

/// A mutant with the package whose suite decides its fate.
struct Candidate {
	package: &'static str,
	mutant:  Mutant,
}

/// Restores a file when the runner leaves the mutant behind, including on a
/// panic. A campaign that aborts mid-mutant must not leave broken source.
///
/// `Drop` cannot answer a `SIGKILL`, and a chunk running under a wall-clock cap
/// is killed rather than asked to stop: an interrupted run left `continue;` for
/// `break;` in `vclock/clock.rs`, where the next chunk would have compiled it
/// as if it were the tree's own code. So the original bytes are also written
/// beside the ledger before the mutation lands, and [`recover_pending`] puts
/// them back on the next start.
struct Restore {
	path:     PathBuf,
	original: String,
	pending:  PathBuf,
}

/// The file a mutant is currently applied to, and the bytes it displaced.
#[derive(Serialize, Deserialize)]
struct Pending {
	file:     String,
	original: String,
}

impl Restore {
	fn arm(path: PathBuf, original: String, pending: PathBuf, relative: &str) -> Self {
		let record = Pending { file: relative.to_owned(), original: original.clone() };
		if let Ok(text) = serde_json::to_string(&record) {
			let _ = fs::write(&pending, text);
		}
		Self { path, original, pending }
	}
}

impl Drop for Restore {
	fn drop(&mut self) {
		let _ = fs::write(&self.path, &self.original);
		let _ = fs::remove_file(&self.pending);
	}
}

/// Put back a mutation whose runner was killed before its guard could run.
///
/// Returns the file it repaired. A record naming a file that already holds the
/// original bytes is removed without a write, so a clean interruption is
/// silent.
fn recover_pending(root: &Path, pending: &Path) -> Option<String> {
	let text = fs::read_to_string(pending).ok()?;
	let record: Pending = serde_json::from_str(&text).ok()?;
	let target = root.join(&record.file);
	let repaired = match fs::read_to_string(&target) {
		Ok(current) if current == record.original => None,
		_ => fs::write(&target, &record.original)
			.ok()
			.map(|()| record.file.clone()),
	};
	let _ = fs::remove_file(pending);
	repaired
}

const fn outcome_id(outcome: Outcome) -> &'static str {
	match outcome {
		Outcome::Killed => "killed",
		Outcome::Survived => "survived",
		Outcome::NotViable => "not-viable",
	}
}

fn outcome_from_id(id: &str) -> Option<Outcome> {
	match id {
		"killed" => Some(Outcome::Killed),
		"survived" => Some(Outcome::Survived),
		"not-viable" => Some(Outcome::NotViable),
		_ => None,
	}
}

/// The workspace root, from this crate's manifest directory.
fn workspace_root() -> PathBuf {
	let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
	manifest
		.parent()
		.and_then(Path::parent)
		.unwrap_or(manifest)
		.to_path_buf()
}

/// The critical path a file sits on.
///
/// Attribution is explicit, never inferred from a name: a guessed attribution
/// would let the gate report coverage of a path nothing touched. Only the
/// corpus has a Rust owner today, and what it owns is the refusal of a
/// persisted record from another schema version.
fn critical_path(file: &str) -> Option<CriticalPath> {
	if file.starts_with("crates/veyyon-conformance/src/corpus/") {
		return Some(CriticalPath::PersistedVersionRejection);
	}
	None
}

/// Every `.rs` file under `root`, in sorted order.
fn sources_under(root: &Path) -> Vec<PathBuf> {
	let mut found = Vec::new();
	let mut stack = vec![root.to_path_buf()];
	while let Some(dir) = stack.pop() {
		let Ok(entries) = fs::read_dir(&dir) else {
			continue;
		};
		for entry in entries.flatten() {
			let path = entry.path();
			if path.is_dir() {
				stack.push(path);
			} else if path.extension().is_some_and(|extension| extension == "rs") {
				found.push(path);
			}
		}
	}
	found.sort();
	found
}

/// Whether a file is a test file, which is never mutated.
fn is_test_file(path: &Path) -> bool {
	path
		.file_name()
		.is_some_and(|name| name == "tests.rs" || name == "campaign.rs")
		|| path
			.components()
			.any(|component| component.as_os_str() == "tests")
}

/// The part of `source` that is not an inline test module.
fn production_prefix(source: &str) -> &str {
	source
		.find("#[cfg(test)]")
		.map_or(source, |cut| &source[..cut])
}

/// Every candidate mutant, interleaved so one hot file cannot dominate a
/// truncated run.
fn candidates(root: &Path) -> Vec<Candidate> {
	let mut buckets: Vec<Vec<Candidate>> = Vec::new();
	for (package, relative) in SOURCES {
		for path in sources_under(&root.join(relative)) {
			if is_test_file(&path) {
				continue;
			}
			let Ok(source) = fs::read_to_string(&path) else {
				continue;
			};
			let file = path
				.strip_prefix(root)
				.unwrap_or(&path)
				.to_string_lossy()
				.replace('\\', "/");
			for operator in Operator::all() {
				let mutants = plan(operator, &file, production_prefix(&source));
				if mutants.is_empty() {
					continue;
				}
				buckets.push(
					mutants
						.into_iter()
						.map(|mutant| Candidate { package, mutant })
						.collect(),
				);
			}
		}
	}

	// Round-robin across (file, operator) buckets: a first slice of the plan is
	// then spread over every file and every operator rather than exhausting the
	// largest file first.
	let mut interleaved = Vec::new();
	let mut index = 0;
	loop {
		let mut moved = false;
		for bucket in &mut buckets {
			if let Some(candidate) = bucket.get(index) {
				interleaved
					.push(Candidate { package: candidate.package, mutant: candidate.mutant.clone() });
				moved = true;
			}
		}
		if !moved {
			break;
		}
		index += 1;
	}
	interleaved
}

/// How long one mutant's suite may run before it is treated as detected.
///
/// The unmutated library suite finishes in about nine seconds and the rebuild
/// in front of it in tens of seconds, so a run still alive after four minutes
/// is not slow, it is stuck.
const RUN_CAP: Duration = Duration::from_mins(4);

/// Build and run `package`'s library suite, and say what became of the mutant.
///
/// A mutant is one token different from the tree that was just compiled, so the
/// run is dominated by rebuild cost rather than by the suite. The workspace
/// disables incremental compilation, which is right for a clean gate and wrong
/// here: it charged a full crate rebuild to every mutant and put the 4,012
/// planned mutants out of reach at about ninety seconds each. Incremental is
/// requested for the child alone, so the campaign pays for its own speed
/// without changing what any other build does.
///
/// The run is bounded. Several operators can remove a loop's exit — a
/// `break;` becoming `continue;` in the clock's deadline scan is one that
/// exists — and the suite then never returns. An unbounded wait turns one such
/// mutant into a stalled campaign: the first one observed here held a chunk for
/// eight minutes and was killed by hand. Non-termination is a behavioural
/// difference the original does not have, so a mutant whose suite must be
/// killed counts as killed, the same as one whose suite went red.
fn verdict(root: &Path, package: &str, cap: Duration) -> Outcome {
	// Child output goes to a file rather than a pipe: a pipe that fills while
	// nothing reads it deadlocks the very hang this cap exists to break.
	let log = env::temp_dir().join(format!("veyyon-campaign-{}.log", std::process::id()));
	let Ok(sink) = fs::File::create(&log) else {
		return Outcome::NotViable;
	};
	let Ok(errors) = sink.try_clone() else {
		return Outcome::NotViable;
	};
	let spawned = Command::new("cargo")
		.args(["test", "-p", package, "--lib", "-q"])
		.env("CARGO_INCREMENTAL", "1")
		.current_dir(root)
		.stdout(Stdio::from(sink))
		.stderr(Stdio::from(errors))
		// Its own process group, so the kill below reaches the test binary and
		// not only the cargo that spawned it.
		.process_group(0)
		.spawn();
	let Ok(mut child) = spawned else {
		return Outcome::NotViable;
	};
	let Some(status) = wait_bounded(&mut child, cap) else {
		println!("  suite did not finish within {}s; counted as killed", cap.as_secs());
		return Outcome::Killed;
	};
	if status.success() {
		return Outcome::Survived;
	}
	let text = fs::read_to_string(&log).unwrap_or_default();
	// A mutant that did not build was not executed. The distinction is the
	// whole reason `NotViable` exists: counting it would clear the floor
	// without testing anything.
	if text.contains("could not compile") || text.contains("error[E") {
		return Outcome::NotViable;
	}
	Outcome::Killed
}

/// Wait for `child`, killing its process group once `cap` elapses.
///
/// `None` means the wait ended without a status: the group was killed, or the
/// handle stopped answering. Either way the caller must not wait again.
fn wait_bounded(child: &mut Child, cap: Duration) -> Option<ExitStatus> {
	let started = Instant::now();
	loop {
		match child.try_wait() {
			Ok(Some(status)) => return Some(status),
			Ok(None) => {},
			Err(_) => return None,
		}
		if started.elapsed() >= cap {
			// Negative pid: the whole group, cargo and the test binary under it.
			// Through `sh` on purpose: util-linux `kill(1)` reads `-<pid>` as an
			// unknown option and refuses it, so the group survived the cap and
			// the wait below became the child's own lifetime instead of the
			// bound. The shell builtin takes a group id.
			let _ = Command::new("sh")
				.arg("-c")
				.arg(format!("kill -9 -{}", child.id()))
				.stdout(Stdio::null())
				.stderr(Stdio::null())
				.status();
			// The direct child too: if the group kill was refused for any other
			// reason, this still ends the wait rather than inheriting the
			// child's lifetime.
			let _ = child.kill();
			let _ = child.wait();
			return None;
		}
		thread::sleep(Duration::from_millis(100));
	}
}

/// Read the ledger, refusing a row this shape cannot read.
fn read_ledger(path: &Path) -> Vec<Row> {
	let Ok(text) = fs::read_to_string(path) else {
		return Vec::new();
	};
	let mut rows = Vec::new();
	for (number, line) in text.lines().enumerate() {
		if line.trim().is_empty() {
			continue;
		}
		match serde_json::from_str::<Row>(line) {
			Ok(row) if row.schema == LEDGER_SCHEMA => rows.push(row),
			Ok(row) => {
				eprintln!("ledger line {}: schema {} is not {LEDGER_SCHEMA}", number + 1, row.schema);
			},
			Err(error) => eprintln!("ledger line {}: {error}", number + 1),
		}
	}
	rows
}

/// Rebuild a campaign from ledger rows.
///
/// Sites are recovered by re-planning the file the row names and matching the
/// offset, so the `'static` rewrite tables supply the bytes. A row whose site
/// no longer exists is a stale row and is refused: the source moved under the
/// ledger, and attributing the outcome to whatever now sits at that offset
/// would report a kill for a mutant nobody ran.
fn campaign_from(root: &Path, rows: &[Row]) -> (Campaign, usize) {
	let mut campaign = Campaign::new();
	let mut stale = 0;
	for row in rows {
		let Some(operator) = Operator::from_id(&row.operator) else {
			stale += 1;
			continue;
		};
		let Some(outcome) = outcome_from_id(&row.outcome) else {
			stale += 1;
			continue;
		};
		let Ok(source) = fs::read_to_string(root.join(&row.file)) else {
			stale += 1;
			continue;
		};
		let found = plan(operator, &row.file, production_prefix(&source))
			.into_iter()
			.find(|mutant| mutant.id == row.id);
		let Some(mutant) = found else {
			stale += 1;
			continue;
		};
		let path = if let Some(id) = &row.path {
			let Some(resolved) = CriticalPath::from_id(id) else {
				stale += 1;
				continue;
			};
			Some(resolved)
		} else {
			None
		};
		if campaign.record(Record { mutant, outcome, path }).is_err() {
			stale += 1;
		}
	}
	(campaign, stale)
}

fn report(root: &Path, ledger: &Path) -> i32 {
	let rows = read_ledger(ledger);
	let (campaign, stale) = campaign_from(root, &rows);
	println!("ledger rows: {} ({stale} refused)", rows.len());
	println!(
		"executed {} killed {} survived {} not-viable {}",
		campaign.executed(),
		campaign.killed(),
		campaign.survived(),
		campaign.not_viable()
	);
	println!("kill ratio: {} basis points", campaign.kill_ratio_basis_points());
	for path in CriticalPath::all() {
		let covered = campaign.covered_paths().contains(&path);
		let survivors = campaign.survivors_on(path).len();
		println!("  {path}: covered={covered} survivors={survivors}");
	}
	let shortfalls = Gate::REQUIRED.shortfalls(&campaign);
	if shortfalls.is_empty() {
		println!("gate: PASS");
		return 0;
	}
	println!("gate: FAIL");
	for shortfall in shortfalls {
		println!("  {shortfall:?}");
	}
	1
}

fn main() {
	let mut limit = 1_200usize;
	let mut ledger = PathBuf::from(".internal/mutation-campaign.jsonl");
	let mut only_report = false;
	// A chunk runs under a wall-clock cap it does not control. Killed mid-mutant,
	// the restore guard never runs and the tree keeps the mutation: that is how a
	// `continue;` for a `break;` survived an interrupted run in `vclock/clock.rs`.
	// A deadline the runner enforces itself stops between mutants, with the tree
	// restored and the ledger complete.
	let mut deadline: Option<Duration> = None;
	let mut run_cap = RUN_CAP;
	let mut args = env::args().skip(1);
	while let Some(argument) = args.next() {
		match argument.as_str() {
			"--limit" => {
				limit = args
					.next()
					.and_then(|value| value.parse().ok())
					.expect("--limit takes a count");
			},
			"--ledger" => ledger = PathBuf::from(args.next().expect("--ledger takes a path")),
			"--deadline" => {
				deadline = Some(Duration::from_secs(
					args
						.next()
						.and_then(|value| value.parse().ok())
						.expect("--deadline takes seconds"),
				));
			},
			"--run-cap" => {
				run_cap = Duration::from_secs(
					args
						.next()
						.and_then(|value| value.parse().ok())
						.expect("--run-cap takes seconds"),
				);
			},
			"--report" => only_report = true,
			other => {
				eprintln!("unknown argument: {other}");
				std::process::exit(2);
			},
		}
	}

	let root = workspace_root();
	let ledger = root.join(&ledger);
	if let Some(parent) = ledger.parent() {
		let _ = fs::create_dir_all(parent);
	}
	let pending_record = ledger.with_extension("pending");

	if only_report {
		std::process::exit(report(&root, &ledger));
	}

	if let Some(file) = recover_pending(&root, &pending_record) {
		println!("restored {file} from an interrupted run");
	}

	let done: BTreeSet<String> = read_ledger(&ledger).into_iter().map(|row| row.id).collect();
	let planned = candidates(&root);
	let pending: Vec<&Candidate> = planned
		.iter()
		.filter(|candidate| !done.contains(&candidate.mutant.id))
		.take(limit)
		.collect();
	println!(
		"{} mutants planned, {} already recorded, running {}",
		planned.len(),
		done.len(),
		pending.len()
	);

	let campaign_started = Instant::now();
	for (number, candidate) in pending.iter().enumerate() {
		let file = root.join(&candidate.mutant.site.file);
		let Ok(original) = fs::read_to_string(&file) else {
			eprintln!("cannot read {}", candidate.mutant.site.file);
			continue;
		};
		let Some(mutated) = candidate.mutant.apply(&original) else {
			eprintln!("stale site in {}", candidate.mutant.site.file);
			continue;
		};

		let started = Instant::now();
		let outcome = {
			let _restore = Restore::arm(
				file.clone(),
				original.clone(),
				pending_record.clone(),
				&candidate.mutant.site.file,
			);
			if fs::write(&file, &mutated).is_err() {
				eprintln!("cannot write {}", candidate.mutant.site.file);
				continue;
			}
			verdict(&root, candidate.package, run_cap)
		};
		let seconds = started.elapsed().as_secs();

		let row = Row {
			schema: LEDGER_SCHEMA,
			id: candidate.mutant.id.clone(),
			operator: candidate.mutant.operator.id().to_owned(),
			package: candidate.package.to_owned(),
			file: candidate.mutant.site.file.clone(),
			offset: candidate.mutant.site.offset,
			before: candidate.mutant.site.before.to_owned(),
			after: candidate.mutant.site.after.to_owned(),
			outcome: outcome_id(outcome).to_owned(),
			path: critical_path(&candidate.mutant.site.file).map(|path| path.id().to_owned()),
			seconds,
		};
		let line = serde_json::to_string(&row).expect("a row serializes");
		let appended = fs::OpenOptions::new()
			.create(true)
			.append(true)
			.open(&ledger)
			.and_then(|mut handle| {
				std::io::Write::write_all(&mut handle, format!("{line}\n").as_bytes())
			});
		if let Err(error) = appended {
			eprintln!("cannot append to the ledger: {error}");
			std::process::exit(1);
		}

		println!(
			"[{}/{}] {} {} {}:{} {}s",
			number + 1,
			pending.len(),
			outcome_id(outcome),
			candidate.mutant.operator.id(),
			candidate.mutant.site.file,
			candidate.mutant.site.offset,
			seconds
		);

		if deadline.is_some_and(|cap| campaign_started.elapsed() >= cap) {
			println!("deadline reached after {} mutant(s); stopping between mutants", number + 1);
			break;
		}
	}

	std::process::exit(report(&root, &ledger));
}

// WHY THIS EXISTS
//
// A campaign chunk runs under a wall-clock cap it does not own, so it is killed
// rather than asked to stop. `Drop` does not answer a `SIGKILL`: one
// interrupted run left `continue;` where `vclock/clock.rs` had `break;`, and
// the next chunk would have compiled that as the tree's own code, scoring every
// later mutant against a defect nobody introduced on purpose.
//
// THE CLASS THIS CLOSES. Not that one file: any mutation still applied when the
// runner dies. The bytes are written beside the ledger BEFORE the mutation
// lands and put back on the next start, so recovery does not depend on the
// dying process running any more code.
//
// The second class here is the opposite failure: a mutant the runner never gets
// an answer about. A mutation that removes a loop's exit hangs the suite
// instead of failing it, and an unbounded wait spends the chunk on one mutant;
// the cap and the process-group kill are what make that a recorded kill rather
// than a stall.
//
// WHAT IT DOES NOT CATCH. A machine that dies between the write of the source
// and the write of the record — the window is one syscall and the record is
// written first, so the surviving state is a record whose file is already
// original, which the second case below proves is dropped without a write. It
// also cannot see two runners mutating at once; the ledger is single-writer by
// construction and nothing here makes it safe to share.
#[cfg(test)]
mod tests {
	use std::{
		os::unix::process::CommandExt,
		process::{Command, Stdio},
		time::{Duration, Instant},
	};

	use veyyon_test_scratch::scratch_dir;

	use super::{Pending, Restore, recover_pending, wait_bounded};

	#[test]
	fn an_interrupted_mutant_is_restored_on_the_next_start() {
		let scratch = scratch_dir("veyyon-conformance-campaign-interrupted");
		let source = scratch.join("clock.rs");
		std::fs::write(&source, "break;\n").expect("original written");
		let record = scratch.join("campaign.pending");
		let pending = Pending { file: "clock.rs".to_owned(), original: "break;\n".to_owned() };
		std::fs::write(&record, serde_json::to_string(&pending).expect("a record serializes"))
			.expect("record");
		// The mutation survives the runner, exactly as a kill leaves it.
		std::fs::write(&source, "continue;\n").expect("mutant written");

		let repaired = recover_pending(&scratch, &record);

		assert_eq!(repaired.as_deref(), Some("clock.rs"));
		assert_eq!(std::fs::read_to_string(&source).expect("source readable"), "break;\n");
		assert!(
			!record.exists(),
			"the record is consumed, so the next start does not repeat the write"
		);
	}

	#[test]
	fn a_record_whose_file_is_already_original_is_dropped_without_a_write() {
		let scratch = scratch_dir("veyyon-conformance-campaign-clean");
		let source = scratch.join("clock.rs");
		std::fs::write(&source, "break;\n").expect("original written");
		let record = scratch.join("campaign.pending");
		let pending = Pending { file: "clock.rs".to_owned(), original: "break;\n".to_owned() };
		std::fs::write(&record, serde_json::to_string(&pending).expect("a record serializes"))
			.expect("record");

		assert_eq!(recover_pending(&scratch, &record), None);
		assert!(!record.exists());
	}

	#[test]
	fn no_record_means_nothing_to_repair() {
		let scratch = scratch_dir("veyyon-conformance-campaign-absent");
		assert_eq!(recover_pending(&scratch, &scratch.join("campaign.pending")), None);
	}

	#[test]
	fn the_guard_restores_the_source_and_clears_its_record() {
		let scratch = scratch_dir("veyyon-conformance-campaign-guard");
		let source = scratch.join("clock.rs");
		std::fs::write(&source, "break;\n").expect("original written");
		let record = scratch.join("campaign.pending");

		{
			let _guard =
				Restore::arm(source.clone(), "break;\n".to_owned(), record.clone(), "clock.rs");
			std::fs::write(&source, "continue;\n").expect("mutant written");
			assert!(record.exists(), "the record is armed before the mutation, not after the verdict");
		}

		assert_eq!(std::fs::read_to_string(&source).expect("source readable"), "break;\n");
		assert!(!record.exists());
	}

	// A hang is the failure mode an assertion on values cannot see: the suite
	// neither passes nor fails, it never answers. These two cases pin that the
	// wait ends and that it ends at the cap rather than whenever the machine
	// feels like it.
	#[test]
	fn a_child_that_never_exits_is_killed_at_the_cap() {
		let mut child = Command::new("sleep")
			.arg("120")
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.process_group(0)
			.spawn()
			.expect("sleep spawns");
		let started = Instant::now();

		let status = wait_bounded(&mut child, Duration::from_millis(300));

		assert!(status.is_none(), "a killed group reports no status");
		assert!(
			started.elapsed() < Duration::from_secs(30),
			"the wait is bounded by the cap, not by the child: took {:?}",
			started.elapsed()
		);
	}

	#[test]
	fn a_child_that_exits_is_reported_with_its_own_status() {
		let mut child = Command::new("false")
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.process_group(0)
			.spawn()
			.expect("false spawns");

		let status = wait_bounded(&mut child, Duration::from_secs(30));

		assert!(status.is_some(), "an exit inside the cap is observed");
		assert!(!status.expect("a status").success(), "the child's own failure is not masked");
	}
}
