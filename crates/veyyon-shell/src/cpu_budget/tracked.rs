//! Bookkeeping-only budget: the backend for hosts with no per-group CPU
//! quota (macOS, and any future platform without one).
//!
//! It tracks the adopted member pids so the TS watcher can deny, renice, or
//! kill with full knowledge of the group, and it meters usage on macOS by
//! summing `proc_pidinfo` over live members. It does NOT throttle:
//! `BudgetGroup::throttles` is false for this backend and the session layer
//! says so on the settings row and at startup.

use std::collections::HashSet;

use parking_lot::Mutex;

pub struct TrackedBudget {
	members: Mutex<HashSet<i32>>,
}

impl TrackedBudget {
	#[must_use]
	pub fn new() -> Self {
		Self { members: Mutex::new(HashSet::new()) }
	}

	pub fn adopt(&self, pid: i32) {
		self.members.lock().insert(pid);
	}

	#[must_use]
	pub fn members(&self) -> Vec<i32> {
		self.members.lock().iter().copied().collect()
	}

	/// Total CPU across live members, microseconds. macOS only: it is the
	/// one tracked-only platform where per-process task info gives a real
	/// number. Anywhere else the watcher gets None and stays on deny/kill
	/// signals derived from wall time alone.
	#[cfg(target_os = "macos")]
	#[must_use]
	pub fn usage_usec(&self) -> Option<u64> {
		Some(self.macos_usage_usec())
	}

	/// Total CPU across live members. See the macOS variant; other platforms
	/// have no per-process meter here.
	#[cfg(not(target_os = "macos"))]
	#[must_use]
	pub const fn usage_usec(&self) -> Option<u64> {
		None
	}

	/// Sum `proc_pidinfo(PROC_PIDTASKINFO)` over live members, pruning the
	/// dead ones so the set cannot grow stale across a long session.
	#[cfg(target_os = "macos")]
	fn macos_usage_usec(&self) -> u64 {
		let mut total_ns: u64 = 0;
		let mut live = HashSet::new();
		for &pid in self.members.lock().iter() {
			// SAFETY: proc_pidinfo writes into the provided buffer when the
			// pid is live and returns the bytes written; a dead pid returns
			// 0 and the buffer is never read.
			let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
			let written = unsafe {
				libc::proc_pidinfo(
					pid,
					libc::PROC_PIDTASKINFO,
					0,
					std::ptr::from_mut(&mut info).cast(),
					std::mem::size_of::<libc::proc_taskinfo>() as i32,
				)
			};
			if written as usize == std::mem::size_of::<libc::proc_taskinfo>() {
				total_ns = total_ns
					.saturating_add(info.pti_total_user)
					.saturating_add(info.pti_total_system);
				live.insert(pid);
			}
		}
		*self.members.lock() = live;
		total_ns / 1_000
	}

	/// Lower (or, at level 0, restore) member scheduling priority. Unix
	/// only; on Windows this backend never runs, so the lever is a no-op.
	pub fn renice(&self, level: i32) {
		#[cfg(unix)]
		for &pid in self.members.lock().iter() {
			// SAFETY: setpriority with PRIO_PROCESS targets exactly the pid
			// given; a dead pid fails with ESRCH and changes nothing.
			unsafe {
				libc::setpriority(libc::PRIO_PROCESS, pid as u32, level);
			}
		}
		#[cfg(not(unix))]
		let _ = level;
	}

	pub fn teardown(&self) {
		self.members.lock().clear();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The nice value the kernel currently has for `pid`, read from
	/// `/proc/<pid>/stat` field 19.
	///
	/// `comm` (field 2) is parenthesised and may itself contain spaces and
	/// parentheses, so the split is on the LAST `)` rather than on whitespace.
	/// Splitting on whitespace reads a process named `(a b)` off by one field
	/// and silently returns the wrong number.
	#[cfg(target_os = "linux")]
	fn nice_of(pid: i32) -> i32 {
		let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("read /proc stat");
		let tail = &stat[stat.rfind(')').expect("comm field is parenthesised") + 1..];
		// After `comm` the next field is `state`, so `nice` (field 19 overall)
		// is index 16 of what remains.
		tail.split_whitespace()
			.nth(16)
			.expect("nice field present")
			.parse()
			.expect("nice is an integer")
	}

	/// A live child that outlives the assertions, killed on drop.
	#[cfg(target_os = "linux")]
	struct Sleeper(std::process::Child);

	#[cfg(target_os = "linux")]
	impl Drop for Sleeper {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	#[cfg(target_os = "linux")]
	fn spawn_sleeper() -> Sleeper {
		Sleeper(
			std::process::Command::new("sleep")
				.arg("30")
				.spawn()
				.expect("spawn sleep"),
		)
	}

	/// Adoption is idempotent: the same pid twice is one member.
	///
	/// The TS watcher iterates `members()` to send SIGTERM on a kill breach and
	/// to renice on saturation. A pid listed twice is signalled twice, and the
	/// second signal lands after the pid may have been recycled by the kernel,
	/// which is how a budget breach turns into killing an unrelated process.
	/// Several wired sites adopt the same child through two paths (a spawn hook
	/// and an explicit call), so duplicate adoption is a real input, not a
	/// hypothetical.
	#[test]
	fn adopting_the_same_pid_twice_yields_one_member() {
		let budget = TrackedBudget::new();
		budget.adopt(4242);
		budget.adopt(4242);
		budget.adopt(4343);
		let mut members = budget.members();
		members.sort_unstable();
		assert_eq!(members, vec![4242, 4343]);
	}

	/// Teardown forgets every member, and the group stays usable afterwards.
	///
	/// Teardown runs when a session ends while its children may still be alive;
	/// this backend must RELEASE them rather than keep signalling them. A
	/// teardown that left the set populated would let a disposed session's
	/// watcher renice or kill processes belonging to the next session, and one
	/// that poisoned the group would panic the shared registry.
	#[test]
	fn teardown_releases_every_member_without_poisoning_the_group() {
		let budget = TrackedBudget::new();
		budget.adopt(11);
		budget.adopt(22);
		budget.teardown();
		assert_eq!(budget.members(), Vec::<i32>::new());
		budget.adopt(33);
		assert_eq!(budget.members(), vec![33]);
	}

	/// On a non-macOS tracked host there is NO usage meter, and the backend
	/// says so instead of inventing a number.
	///
	/// `None` is load-bearing: the TS watcher reads it as "this platform cannot
	/// measure the group" and stays on the deny/kill signals it derives from
	/// wall time. If this ever returned `Some(0)` the watcher would conclude
	/// the group is idle forever and never deny anything, which is a silently
	/// disabled budget rather than a reported one.
	#[cfg(not(target_os = "macos"))]
	#[test]
	fn a_tracked_group_with_no_platform_meter_reports_no_usage_rather_than_zero() {
		let budget = TrackedBudget::new();
		budget.adopt(std::process::id() as i32);
		assert_eq!(budget.usage_usec(), None);
	}

	/// Whether this host lets an unprivileged process RAISE a nice value back
	/// to `baseline`.
	///
	/// Lowering priority is always allowed; raising it needs `CAP_SYS_NICE` or
	/// enough `RLIMIT_NICE` headroom, and containers commonly grant neither.
	/// Probed against a throwaway child so the restore assertion below can be
	/// an EXACT value rather than a disjunction that passes either way.
	#[cfg(target_os = "linux")]
	fn host_allows_raising_priority(baseline: i32) -> bool {
		let child = spawn_sleeper();
		let pid = child.0.id() as i32;
		// SAFETY: PRIO_PROCESS targets exactly this pid, which is a live child
		// this function owns and reaps on drop.
		unsafe {
			libc::setpriority(libc::PRIO_PROCESS, pid as u32, baseline + 2);
			libc::setpriority(libc::PRIO_PROCESS, pid as u32, baseline);
		}
		nice_of(pid) == baseline
	}

	/// `renice` moves the kernel's nice value of every live member to exactly
	/// the level asked for, and level 0 puts it back.
	///
	/// This is the ONLY enforcement this backend has. Where no per-group quota
	/// exists the budget is policy plus this one lever, so a `renice` that
	/// silently does nothing (wrong `which` argument, a signed/unsigned
	/// conversion that mangles the pid, iterating an empty set because adoption
	/// wrote elsewhere) leaves those sessions with a budget that reports
	/// saturation and changes nothing about it. Asserting the exact value the
	/// kernel now holds, read back out of `/proc`, is what distinguishes a real
	/// `setpriority` from a call that returned `-1`.
	///
	/// The restore half matters just as much: the watcher calls `renice(0)` on
	/// recovery, and a group that is never restored leaves every process the
	/// session started permanently deprioritised.
	#[cfg(target_os = "linux")]
	#[test]
	fn renice_sets_the_exact_kernel_nice_value_of_live_members_and_restores_it() {
		let a = spawn_sleeper();
		let b = spawn_sleeper();
		let pid_a = a.0.id() as i32;
		let pid_b = b.0.id() as i32;

		// A child inherits the test runner's nice value, which is NOT
		// necessarily 0: run under a deprioritised harness it starts at 15.
		// Targets are therefore chosen relative to the observed baseline so
		// that both writes are LOWERINGS, which need no privilege, and the
		// assertions stay exact absolute values.
		let baseline = nice_of(pid_a);
		assert_eq!(nice_of(pid_b), baseline, "both children start equal");
		assert!(baseline <= 17, "need two steps of headroom below nice 19, baseline is {baseline}");
		let (lower, lowest) = (baseline + 1, baseline + 2);

		let budget = TrackedBudget::new();
		budget.adopt(pid_a);
		budget.adopt(pid_b);

		budget.renice(lower);
		assert_eq!(nice_of(pid_a), lower, "every member moves, not just the first");
		assert_eq!(nice_of(pid_b), lower);

		budget.renice(lowest);
		assert_eq!(nice_of(pid_a), lowest);
		assert_eq!(nice_of(pid_b), lowest);

		budget.renice(baseline);
		if host_allows_raising_priority(baseline) {
			assert_eq!(nice_of(pid_a), baseline, "recovery restores the original priority");
			assert_eq!(nice_of(pid_b), baseline);
		} else {
			println!(
				"SKIP (restore half): this host forbids an unprivileged process raising a nice \
				 value; CAP_SYS_NICE or RLIMIT_NICE headroom is missing"
			);
			assert_eq!(nice_of(pid_a), lowest, "the lowered value must at least be unchanged");
		}
	}

	/// A group whose only member is dead survives `renice` and keeps its set.
	///
	/// Members die constantly, and the set is pruned only on macOS, so on every
	/// other tracked host it accumulates exited pids for the life of the
	/// session. `setpriority` on a reaped pid returns ESRCH. If that were
	/// escalated (a `?`, an `expect`, a panic) the watcher would abort on the
	/// first finished command and the lever would be dead for the rest of the
	/// session, with nothing said.
	#[cfg(target_os = "linux")]
	#[test]
	fn renice_survives_a_member_that_has_already_exited() {
		let mut dead = std::process::Command::new("true").spawn().expect("spawn true");
		let dead_pid = dead.id() as i32;
		dead.wait().expect("reap");

		let budget = TrackedBudget::new();
		budget.adopt(dead_pid);
		budget.renice(9);

		assert_eq!(budget.members(), vec![dead_pid], "a failed renice must not drop the member");
	}
}
