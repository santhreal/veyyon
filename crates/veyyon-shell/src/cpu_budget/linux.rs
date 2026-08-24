//! Linux backend: one cgroup v2 directory per session budget.
//!
//! `cpu.max` carries the quota (`<cores * 100000> 100000`), `cpu.stat`
//! meters the group, and `cgroup.procs` adopts a spawned child by pid write.
//! Membership is inherited across fork, so adopting the direct child caps
//! the whole tree below it. Two ownership modes: `create` makes and owns a
//! cgroup under a delegated parent (and removes it on teardown);
//! `manage_existing` points at a systemd scope whose quota belongs to
//! systemd, so `set_cores` and teardown deliberately do nothing to it.

use std::path::{Path, PathBuf};

use anyhow::{Error, Result};

const PERIOD_USEC: u64 = 100_000;

pub struct LinuxBudget {
	dir:        PathBuf,
	/// The delegated parent when this budget OWNS `dir`; None for a systemd
	/// scope, which systemd removes.
	parent_dir: Option<PathBuf>,
}

impl LinuxBudget {
	/// Create `<parent_dir>/<name>`, enable the cpu controller for it, and
	/// write the quota. Any failure removes the partial cgroup: no half-made
	/// group is left for the kernel to keep accounting.
	pub fn create(parent_dir: &str, name: &str, cores: f64) -> Result<Self> {
		let parent = PathBuf::from(parent_dir);
		let dir = parent.join(name);
		let result = (|| -> Result<()> {
			std::fs::create_dir(&dir)
				.map_err(|e| Error::msg(format!("create {}: {e}", dir.display())))?;
			let subtree_control = parent.join("cgroup.subtree_control");
			let current = std::fs::read_to_string(&subtree_control).unwrap_or_default();
			if !current.split_whitespace().any(|c| c == "cpu") {
				std::fs::write(&subtree_control, "+cpu")
					.map_err(|e| Error::msg(format!("enable +cpu on {}: {e}", parent.display())))?;
			}
			write_quota(&dir, cores)
		})();
		if let Err(error) = result {
			remove_cgroup_dir(&dir);
			return Err(error);
		}
		Ok(Self { dir, parent_dir: Some(parent) })
	}

	/// Point at a cgroup somebody else made (a systemd-run scope): adopt and
	/// meter against it, but never write its quota or remove it.
	pub fn manage_existing(dir: &str) -> Result<Self> {
		let path = PathBuf::from(dir);
		if !path.join("cgroup.procs").exists() {
			return Err(Error::msg(format!("{} is not a cgroup", path.display())));
		}
		Ok(Self { dir: path, parent_dir: None })
	}

	pub fn adopt(&self, pid: i32) {
		// ESRCH (child already exited) and ENOENT (session disposed mid-spawn)
		// are both benign; neither may fail the command the pid belongs to.
		// EACCES/EPERM/EINVAL (undelegated cgroup, sleeper filling pids.max)
		// used to be swallowed the same way, so adopt was a silent no-op.
		if let Err(error) = std::fs::write(self.dir.join("cgroup.procs"), pid.to_string())
			&& !is_benign_adopt_error(&error)
		{
			eprintln!(
				"veyyon-shell: write cgroup.procs for pid {pid} in {} failed: {error}",
				self.dir.display()
			);
		}
	}

	#[must_use]
	pub fn usage_usec(&self) -> Option<u64> {
		self.stat_field("usage_usec")
	}

	/// Throttled period count from `cpu.stat`: the kernel's own record that
	/// demand exceeded the quota. This, not the usage rate, is what tells the
	/// watcher the budget is too small rather than merely fully used.
	#[must_use]
	pub fn throttled_periods(&self) -> Option<u64> {
		self.stat_field("nr_throttled")
	}

	fn stat_field(&self, field: &str) -> Option<u64> {
		let stat = std::fs::read_to_string(self.dir.join("cpu.stat")).ok()?;
		stat
			.lines()
			.find_map(|line| line.strip_prefix(field))
			.and_then(|rest| rest.trim().parse::<u64>().ok())
	}

	#[must_use]
	pub fn members(&self) -> Vec<i32> {
		std::fs::read_to_string(self.dir.join("cgroup.procs"))
			.unwrap_or_default()
			.lines()
			.filter_map(|line| line.trim().parse::<i32>().ok())
			.collect()
	}

	/// Rewrite the quota; cores <= 0 lifts it (the cgroup stays, the cap goes).
	/// Only meaningful for a cgroup this budget owns; a systemd scope's quota
	/// moves through `systemctl set-property` on the TS side, so this is a
	/// deliberate no-op there.
	pub fn set_cores(&self, cores: f64) {
		if self.parent_dir.is_none() {
			return;
		}
		let _ = std::fs::write(self.dir.join("cpu.max"), quota_value(cores));
	}

	/// Hand surviving members to the parent and remove the cgroup. A cgroup
	/// cannot be removed while populated, and teardown never kills, so the
	/// reparent is what makes removal possible mid-command.
	pub fn teardown(&self) {
		if let Some(parent) = &self.parent_dir {
			// One pid per write (kernel contract). Retry: a child that lands
			// in the group between the first scan and rmdir would otherwise
			// leave the directory populated and teardown would leak the cgroup.
			for _ in 0..8 {
				let pids = self.members();
				if pids.is_empty() {
					break;
				}
				for pid in pids {
					let _ = std::fs::write(parent.join("cgroup.procs"), pid.to_string());
				}
			}
			remove_cgroup_dir(&self.dir);
		}
	}
}

/// Remove a cgroup directory. On a real cgroupfs `remove_dir` is the whole
/// operation (the controller files are virtual and vanish with the cgroup).
/// A plain filesystem stand-in (a tmpdir in tests) materializes those files,
/// and there the recursive form is the only one that can succeed.
fn remove_cgroup_dir(dir: &Path) {
	if std::fs::remove_dir(dir).is_ok() {
		return;
	}
	let _ = std::fs::remove_dir_all(dir);
}

/// Adopt write failures that mean "the child is already gone or the group
/// was torn down", not "the write was ignored and the child is uncapped".
fn is_benign_adopt_error(error: &std::io::Error) -> bool {
	matches!(error.kind(), std::io::ErrorKind::NotFound) || error.raw_os_error() == Some(libc::ESRCH)
}

/// The `cpu.max` line for `cores`: a quota over the fixed period, or `max`
/// (no cap) at or below zero.
///
/// Creation and `set_cores` share it deliberately. They used to format the
/// file two different ways, and only `set_cores` knew that zero means "no
/// cap": creating a group at zero cores wrote a literal `0 100000`, which is
/// a quota of no CPU at all rather than an absent one.
fn quota_value(cores: f64) -> String {
	if cores.is_finite() && cores > 0.0 {
		let quota = (cores * PERIOD_USEC as f64).round().max(1.0) as u64;
		format!("{quota} {PERIOD_USEC}")
	} else {
		format!("max {PERIOD_USEC}")
	}
}

fn write_quota(dir: &Path, cores: f64) -> Result<()> {
	std::fs::write(dir.join("cpu.max"), quota_value(cores))
		.map_err(|e| Error::msg(format!("write cpu.max in {}: {e}", dir.display())))
}

#[cfg(test)]
mod tests {
	use veyyon_test_scratch::TempTree;

	use super::*;

	/// The parent is a scratch tree rather than a hand-built path under the
	/// system temp directory, so it is removed when the test that made it ends,
	/// including when that test panics before reaching its cleanup line.
	fn fake_delegated_parent() -> TempTree {
		let tree = veyyon_test_scratch::scratch_dir("cpu-budget");
		let dir = tree.path();
		std::fs::write(dir.join("cgroup.controllers"), "cpu io memory pids\n").expect("controllers");
		std::fs::write(dir.join("cgroup.subtree_control"), "").expect("subtree_control");
		std::fs::write(dir.join("cgroup.procs"), "").expect("procs");
		tree
	}

	#[test]
	fn create_writes_the_exact_quota_bytes() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let budget =
			LinuxBudget::create(parent.to_str().expect("utf8"), "veyyon-cpu-quota-test", 2.0)
				.expect("create budget");
		let dir = parent.join("veyyon-cpu-quota-test");
		assert_eq!(
			std::fs::read_to_string(dir.join("cpu.max")).expect("cpu.max"),
			"200000 100000",
			"2 cores is a 200000 quota over the fixed 100000 period",
		);
		assert_eq!(
			std::fs::read_to_string(parent.join("cgroup.subtree_control")).expect("subtree_control"),
			"+cpu",
			"the parent must delegate cpu downward or the child quota is inert",
		);
		budget.teardown();
		assert!(!dir.exists(), "teardown removes an owned cgroup");
	}

	/// WHY: zero cores means "no cap", and creation and `set_cores` formatted
	/// `cpu.max` separately, so only `set_cores` knew that. Creation wrote a
	/// literal `0 100000`: a quota of no CPU at all, which the kernel either
	/// rejects (the group is then created uncapped and the operator is told it
	/// is capped) or honours by freezing every process adopted into it.
	#[test]
	fn zero_cores_is_an_absent_cap_on_both_write_paths() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let budget = LinuxBudget::create(parent.to_str().expect("utf8"), "veyyon-cpu-zero-test", 0.0)
			.expect("create budget");
		let dir = parent.join("veyyon-cpu-zero-test");
		assert_eq!(
			std::fs::read_to_string(dir.join("cpu.max")).expect("cpu.max"),
			"max 100000",
			"creating at zero cores must lift the cap, never write a zero quota",
		);
		budget.set_cores(2.0);
		assert_eq!(std::fs::read_to_string(dir.join("cpu.max")).expect("cpu.max"), "200000 100000");
		budget.set_cores(0.0);
		assert_eq!(
			std::fs::read_to_string(dir.join("cpu.max")).expect("cpu.max"),
			"max 100000",
			"both write paths agree on the spelling of no cap",
		);
		budget.teardown();
	}

	#[test]
	fn adopt_and_meter_against_the_group_files() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let budget =
			LinuxBudget::create(parent.to_str().expect("utf8"), "veyyon-cpu-adopt-test", 1.0)
				.expect("create budget");
		let dir = parent.join("veyyon-cpu-adopt-test");
		budget.adopt(4242);
		assert_eq!(std::fs::read_to_string(dir.join("cgroup.procs")).expect("procs"), "4242");
		std::fs::write(dir.join("cpu.stat"), "usage_usec 123456\nnr_throttled 7\n")
			.expect("cpu.stat");
		assert_eq!(budget.usage_usec(), Some(123_456));
		assert_eq!(budget.members(), vec![4242]);
		budget.teardown();
	}

	#[test]
	fn manage_existing_never_touches_quota_or_removal() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let scope = parent.join("veyyon-cpu-existing.scope");
		std::fs::create_dir(&scope).expect("scope dir");
		std::fs::write(scope.join("cgroup.procs"), "").expect("procs");
		let budget = LinuxBudget::manage_existing(scope.to_str().expect("utf8")).expect("manage");
		budget.set_cores(4.0);
		assert!(!scope.join("cpu.max").exists(), "a managed scope's quota is systemd's to write");
		budget.teardown();
		assert!(scope.exists(), "teardown leaves a managed scope in place");
	}

	#[test]
	fn non_finite_and_non_positive_cores_spell_max_not_a_zero_quota() {
		for cores in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
			assert_eq!(quota_value(cores), "max 100000", "cores={cores:?} must lift, never freeze");
		}
	}

	#[test]
	fn quota_value_matches_period_times_cores_across_a_grid() {
		for step in 1..=200 {
			let cores = step as f64 / 10.0;
			let want = format!("{} 100000", (cores * 100_000.0).round() as u64);
			assert_eq!(quota_value(cores), want);
		}
		assert_eq!(quota_value(2.0), "200000 100000");
	}

	#[test]
	fn a_positive_budget_too_small_to_express_floors_at_one_microsecond_not_a_freeze() {
		assert_eq!(quota_value(1e-12), "1 100000");
		assert_eq!(quota_value(1e-10), "1 100000");
		assert_eq!(quota_value(4e-6), "1 100000");
		for step in 1..=20 {
			let cores = 10f64.powi(-step);
			assert!(cores > 0.0, "grid must stay a positive finite budget");
			let line = quota_value(cores);
			assert!(!line.starts_with("0 "), "positive cores={cores:?} must not freeze, got {line}");
			assert_ne!(line, "max 100000");
			let quota: u64 = line.split_whitespace().next().unwrap().parse().unwrap();
			assert!(quota >= 1);
		}
	}
	#[test]
	fn teardown_reparents_members_then_removes_the_owned_cgroup() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let budget =
			LinuxBudget::create(parent.to_str().expect("utf8"), "veyyon-cpu-teardown-test", 1.0)
				.expect("create budget");
		let dir = parent.join("veyyon-cpu-teardown-test");
		std::fs::write(dir.join("cgroup.procs"), "111\n222\n").expect("procs");
		budget.teardown();
		assert!(!dir.exists(), "owned cgroup must not leak after teardown");
		let parent_procs =
			std::fs::read_to_string(parent.join("cgroup.procs")).expect("parent procs");
		assert!(
			parent_procs.contains("222"),
			"the last reparented pid must land in the parent (fake cgroup.procs overwrites), got \
			 {parent_procs:?}"
		);
	}

	#[test]
	fn dead_or_missing_adopt_targets_are_benign_and_permission_errors_are_not() {
		assert!(is_benign_adopt_error(&std::io::Error::from_raw_os_error(libc::ESRCH)));
		assert!(is_benign_adopt_error(&std::io::Error::new(std::io::ErrorKind::NotFound, "gone")));
		assert!(!is_benign_adopt_error(&std::io::Error::from_raw_os_error(libc::EACCES)));
		assert!(!is_benign_adopt_error(&std::io::Error::from_raw_os_error(libc::EPERM)));
		assert!(!is_benign_adopt_error(&std::io::Error::from_raw_os_error(libc::EINVAL)));
	}

	#[test]
	fn a_directory_standing_in_for_cgroup_procs_does_not_panic_on_adopt() {
		let parent_tree = fake_delegated_parent();
		let parent = parent_tree.path();
		let budget =
			LinuxBudget::create(parent.to_str().expect("utf8"), "veyyon-cpu-adopt-fail-test", 1.0)
				.expect("create budget");
		let procs = parent
			.join("veyyon-cpu-adopt-fail-test")
			.join("cgroup.procs");
		// create() does not materialize cgroup.procs; a directory here makes the adopt
		// write fail.
		std::fs::create_dir(&procs).expect("directory makes write fail");
		budget.adopt(4242); // must not panic; failure is traced
		budget.teardown();
	}
}
