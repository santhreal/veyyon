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
use parking_lot::Mutex;

const PERIOD_USEC: u64 = 100_000;

pub struct LinuxBudget {
	dir:        PathBuf,
	/// The delegated parent when this budget OWNS `dir`; None for a systemd
	/// scope, which systemd removes.
	parent_dir: Option<PathBuf>,
	cores:      Mutex<f64>,
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
		Ok(Self { dir, parent_dir: Some(parent), cores: Mutex::new(cores) })
	}

	/// Point at a cgroup somebody else made (a systemd-run scope): adopt and
	/// meter against it, but never write its quota or remove it.
	pub fn manage_existing(dir: &str) -> Result<Self> {
		let path = PathBuf::from(dir);
		if !path.join("cgroup.procs").exists() {
			return Err(Error::msg(format!("{} is not a cgroup", path.display())));
		}
		Ok(Self { dir: path, parent_dir: None, cores: Mutex::new(0.0) })
	}

	pub fn adopt(&self, pid: i32) {
		// ESRCH (child already exited) and ENOENT (session disposed mid-spawn)
		// are both benign; neither may fail the command the pid belongs to.
		let _ = std::fs::write(self.dir.join("cgroup.procs"), pid.to_string());
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
		*self.cores.lock() = cores;
		let value = if cores > 0.0 {
			format!("{} {PERIOD_USEC}", (cores * PERIOD_USEC as f64).round() as u64)
		} else {
			format!("max {PERIOD_USEC}")
		};
		let _ = std::fs::write(self.dir.join("cpu.max"), value);
	}

	/// Hand surviving members to the parent and remove the cgroup. A cgroup
	/// cannot be removed while populated, and teardown never kills, so the
	/// reparent is what makes removal possible mid-command.
	pub fn teardown(&self) {
		if let Some(parent) = &self.parent_dir {
			for pid in self.members() {
				let _ = std::fs::write(parent.join("cgroup.procs"), pid.to_string());
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

fn write_quota(dir: &Path, cores: f64) -> Result<()> {
	let quota = format!("{} {PERIOD_USEC}", (cores * PERIOD_USEC as f64).round() as u64);
	std::fs::write(dir.join("cpu.max"), quota)
		.map_err(|e| Error::msg(format!("write cpu.max in {}: {e}", dir.display())))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fake_delegated_parent() -> PathBuf {
		let dir = std::env::temp_dir().join(format!(
			"veyyon-cpu-budget-test-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |d| d.as_nanos()),
		));
		std::fs::create_dir_all(&dir).expect("create fake parent");
		std::fs::write(dir.join("cgroup.controllers"), "cpu io memory pids\n").expect("controllers");
		std::fs::write(dir.join("cgroup.subtree_control"), "").expect("subtree_control");
		std::fs::write(dir.join("cgroup.procs"), "").expect("procs");
		dir
	}

	#[test]
	fn create_writes_the_exact_quota_bytes() {
		let parent = fake_delegated_parent();
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
		std::fs::remove_dir_all(&parent).expect("clean parent");
	}

	#[test]
	fn adopt_and_meter_against_the_group_files() {
		let parent = fake_delegated_parent();
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
		std::fs::remove_dir_all(&parent).expect("clean parent");
	}

	#[test]
	fn manage_existing_never_touches_quota_or_removal() {
		let parent = fake_delegated_parent();
		let scope = parent.join("veyyon-cpu-existing.scope");
		std::fs::create_dir(&scope).expect("scope dir");
		std::fs::write(scope.join("cgroup.procs"), "").expect("procs");
		let budget = LinuxBudget::manage_existing(scope.to_str().expect("utf8")).expect("manage");
		budget.set_cores(4.0);
		assert!(!scope.join("cpu.max").exists(), "a managed scope's quota is systemd's to write");
		budget.teardown();
		assert!(scope.exists(), "teardown leaves a managed scope in place");
		std::fs::remove_dir_all(&parent).expect("clean parent");
	}
}
