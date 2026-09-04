//! N-API surface for per-session CPU budget groups.
//!
//! This is the one native surface the TypeScript session layer
//! (`session/cpu-limit.ts`) drives. The mechanics per platform (cgroup v2 on
//! Linux, a Job Object on Windows, bookkeeping-only elsewhere) live in
//! `veyyon_shell::cpu_budget`; this module only adapts the options object and
//! the return types.

use std::sync::Arc;

use napi::Result;
use napi_derive::napi;
use veyyon_shell::cpu_budget::{
	BudgetBackendSpec, BudgetGroup as CoreBudgetGroup, register_budget_group,
	unregister_budget_group,
};

use crate::napi_error::to_napi;

/// How a session budget group is created.
#[napi(object)]
pub struct CpuBudgetCreateOptions {
	/// Budget name, unique per session (`veyyon-cpu-<session id>`). The spawn
	/// hooks resolve this name to the live group.
	pub name:                String,
	/// Core count the quota is set to.
	pub cores:               f64,
	/// Linux direct backend: a delegated parent directory to create the
	/// session cgroup under.
	pub cgroup_parent_dir:   Option<String>,
	/// Linux systemd backend: an existing scope cgroup directory (its quota
	/// belongs to systemd and is left alone).
	pub existing_cgroup_dir: Option<String>,
	/// Force the bookkeeping-only backend. Exists for tests; the production
	/// probe selects the platform default instead.
	pub tracked_only:        Option<bool>,
}

/// A live session CPU budget group.
#[napi]
pub struct CpuBudgetGroup {
	name:  String,
	group: Arc<CoreBudgetGroup>,
}

#[napi]
impl CpuBudgetGroup {
	#[napi(constructor)]
	pub fn new(options: CpuBudgetCreateOptions) -> Result<Self> {
		let spec = if let Some(parent_dir) = options.cgroup_parent_dir {
			BudgetBackendSpec::Cgroup { parent_dir }
		} else if let Some(dir) = options.existing_cgroup_dir {
			BudgetBackendSpec::ExistingCgroup { dir }
		} else if options.tracked_only == Some(true) {
			BudgetBackendSpec::Tracked
		} else {
			BudgetBackendSpec::Native
		};
		let group = CoreBudgetGroup::create(&spec, &options.name, options.cores).map_err(to_napi)?;
		let group = register_budget_group(&options.name, group);
		Ok(Self { name: options.name, group })
	}

	/// Whether the OS throttles this group's members. When false the budget
	/// is policy-only (deny / renice / kill from the session watcher).
	#[napi(getter)]
	pub fn throttles(&self) -> bool {
		self.group.throttles()
	}

	/// Move a spawned child into the group. Best-effort by contract.
	#[napi]
	pub fn adopt(&self, pid: i32) {
		self.group.adopt(pid);
	}

	/// Total CPU the group has consumed, in microseconds, when the platform
	/// reports it.
	#[napi]
	pub fn usage_usec(&self) -> Option<f64> {
		self.group.usage_usec().map(|usec| usec as f64)
	}

	/// How often the kernel throttled the group, when the platform counts it.
	#[napi]
	pub fn throttled_periods(&self) -> Option<f64> {
		self.group.throttled_periods().map(|count| count as f64)
	}

	/// The group's current member pids.
	#[napi]
	pub fn members(&self) -> Vec<i32> {
		self.group.members()
	}

	/// Re-express the quota for a changed core count.
	#[napi]
	pub fn set_cores(&self, cores: f64) {
		self.group.set_cores(cores);
	}

	/// The degraded-mode lever: lower the scheduling priority of every member
	/// (level 0 restores). No-op where a real quota exists.
	#[napi]
	pub fn renice(&self, level: i32) {
		self.group.renice(level);
	}

	/// Release the group: unregister it, reparent survivors, free the OS
	/// handle. Never kills.
	#[napi]
	pub fn dispose(&self) {
		unregister_budget_group(&self.name);
		self.group.teardown();
	}
}
