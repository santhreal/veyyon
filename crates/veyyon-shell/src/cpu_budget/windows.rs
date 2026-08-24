//! Windows backend: one Job Object per session budget with a hard CPU rate
//! cap (`JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`). The scheduler suspends the
//! job's threads once they spend their cycle budget for an interval, which is
//! the same enforcement of last resort a cgroup quota gives on Linux.
//!
//! `CpuRate` counts cycles per 10_000 cycles of TOTAL machine capacity (every
//! logical processor), so the rate for N cores on an M-core machine is
//! N / M * 10_000. Members join by `AssignProcessToJobObject`, and processes
//! a member spawns join the job by default, so adopting the direct child caps
//! the tree below it.

use std::mem::size_of;

use anyhow::{Error, Result};
use parking_lot::Mutex;
use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE},
	System::{
		JobObjects::{
			AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE,
			JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION,
			JOBOBJECT_BASIC_PROCESS_ID_LIST, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
			JobObjectBasicAndIoAccountingInformation, JobObjectBasicProcessIdList,
			JobObjectCpuRateControlInformation, QueryInformationJobObject, SetInformationJobObject,
		},
		Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
	},
};

/// Whether rate control is on, and if so the `CpuRate` in 1..=10_000.
///
/// Zero, negative, or non-finite cores must DISABLE the cap (`ControlFlags =
/// 0`). Flooring those inputs to `CpuRate` 1 with `HARD_CAP` left `/cpu-limit
/// remove` and `session.cpuLimitCores: 0` throttling the job to 0.01% of the
/// machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CpuRateControl {
	enabled: bool,
	rate:    u32,
}

/// The `CpuRate` value for a **positive** budget of `cores` cores on a machine
/// with `cpus` logical processors.
///
/// `CpuRate` is cycles per 10_000 cycles of TOTAL machine capacity, so a core
/// count has to be expressed as a fraction of the whole machine first: 4 cores
/// on 16 processors is 2_500, not 40_000. The three edges each have a reason:
///
/// - Clamped at the top, because a budget at or past the machine's core count
///   means the whole machine and a `CpuRate` above 10_000 is rejected outright
///   by `SetInformationJobObject`, which would leave the job with NO cap.
/// - Clamped at the bottom against negative or NaN input.
/// - Floored at 1, because `CpuRate` 0 with `HARD_CAP` set is also rejected,
///   and a tiny-but-nonzero budget must round to the smallest cap the API can
///   express rather than to "no cap at all".
///
/// Callers that mean "no cap" must go through [`cpu_rate_control`], not this.
fn cpu_rate_per_10k(cores: f64, cpus: f64) -> u32 {
	let cpus = if cpus.is_finite() && cpus > 0.0 {
		cpus
	} else {
		1.0
	};
	let fraction = (cores / cpus).clamp(0.0, 1.0);
	(fraction * 10_000.0).round().max(1.0) as u32
}

fn cpu_rate_control(cores: f64, cpus: f64) -> CpuRateControl {
	if cores.is_finite() && cores > 0.0 {
		CpuRateControl { enabled: true, rate: cpu_rate_per_10k(cores, cpus) }
	} else {
		CpuRateControl { enabled: false, rate: 0 }
	}
}

/// windows-sys spells HANDLE as a raw pointer, which is not Send/Sync. A job
/// handle is a process-global kernel handle, safe to use from any thread, so
/// it travels as the integer the kernel actually hands out.
struct SendHandle(isize);

pub struct JobBudget {
	job:   SendHandle,
	cores: Mutex<f64>,
}

impl JobBudget {
	pub fn create(_name: &str, cores: f64) -> Result<Self> {
		// Unnamed: a named CreateJobObjectW reopens an existing object on
		// ERROR_ALREADY_EXISTS, so a second session could inherit another
		// session's job (and its leftover HARD_CAP) under a colliding name.
		// The TS registry already keys groups by session id; the kernel name
		// is not needed for lookup.
		// SAFETY: a null name and a null security descriptor create a fresh
		// unnamed job with the default DACL.
		let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
		if handle.is_null() {
			return Err(Error::msg(format!(
				"CreateJobObject failed: {}",
				std::io::Error::last_os_error()
			)));
		}
		let budget = Self { job: SendHandle(handle as isize), cores: Mutex::new(cores) };
		if let Err(error) = budget.apply_rate(cores) {
			budget.teardown();
			return Err(error);
		}
		Ok(budget)
	}

	fn handle(&self) -> HANDLE {
		self.job.0 as HANDLE
	}

	/// Write the CPU rate for `cores` cores, or clear rate control at/below 0.
	fn apply_rate(&self, cores: f64) -> Result<()> {
		// `CpuRate` is a fraction of the whole machine. `available_parallelism`
		// is the right denominator when it reports host logical processors (the
		// usual Windows case). If it reported only an affinity/container slice,
		// a budget of that many cores would become 10_000 = 100% of the host.
		let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
		let control = cpu_rate_control(cores, cpus);
		let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
			ControlFlags: if control.enabled {
				JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
			} else {
				0
			},
			..JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default()
		};
		info.Anonymous.CpuRate = control.rate;
		// SAFETY: `info` is a live, correctly sized CPU-rate control struct;
		// the union field written is the one ControlFlags selects.
		let ok = unsafe {
			SetInformationJobObject(
				self.handle(),
				JobObjectCpuRateControlInformation,
				std::ptr::from_ref(&info).cast(),
				size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
			)
		};
		if ok == 0 {
			return Err(Error::msg(format!(
				"SetInformationJobObject failed: {}",
				std::io::Error::last_os_error()
			)));
		}
		Ok(())
	}

	pub fn adopt(&self, pid: i32) {
		// SAFETY: pid came from the spawn hook; OpenProcess either returns a
		// handle we own (and close) or null for an already-exited child.
		let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid as u32) };
		if process.is_null() {
			return;
		}
		unsafe {
			let assigned = AssignProcessToJobObject(self.handle(), process);
			CloseHandle(process);
			if assigned == 0 {
				// Nested jobs and already-exited pids both fail here; swallowing
				// the error left the child outside the cap with no trace.
				eprintln!(
					"veyyon-shell: AssignProcessToJobObject failed for pid {pid}: {}",
					std::io::Error::last_os_error()
				);
			}
		}
	}

	#[must_use]
	pub fn usage_usec(&self) -> Option<u64> {
		// SAFETY: `info` is a live, correctly sized accounting struct.
		let mut info = JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION::default();
		let ok = unsafe {
			QueryInformationJobObject(
				self.handle(),
				JobObjectBasicAndIoAccountingInformation,
				std::ptr::from_mut(&mut info).cast(),
				size_of::<JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION>() as u32,
				std::ptr::null_mut(),
			)
		};
		if ok == 0 {
			return None;
		}
		// FILETIME-style 100ns ticks to microseconds.
		Some(((info.BasicInfo.TotalUserTime + info.BasicInfo.TotalKernelTime) / 10) as u64)
	}

	#[must_use]
	pub fn members(&self) -> Vec<i32> {
		let mut pid_capacity = 64usize;
		loop {
			let buf_len =
				size_of::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() + pid_capacity * size_of::<usize>();
			let mut buf = vec![0u8; buf_len];
			// SAFETY: `buf` is at least as large as the header plus
			// pid_capacity entries, which is what the API is told it holds.
			let ok = unsafe {
				QueryInformationJobObject(
					self.handle(),
					JobObjectBasicProcessIdList,
					buf.as_mut_ptr().cast(),
					buf_len as u32,
					std::ptr::null_mut(),
				)
			};
			if ok == 0 {
				if pid_capacity > 65_536 {
					return Vec::new();
				}
				pid_capacity *= 2;
				continue;
			}
			// SAFETY: the call succeeded, so the header and
			// NumberOfProcessIdsInList entries of the buffer are initialized.
			// ProcessIdList is declared as a one-element array; the entries past
			// it live in the tail of the same buffer.
			let list = unsafe { &*buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>() };
			if list.NumberOfAssignedProcesses as usize > pid_capacity {
				pid_capacity = list.NumberOfAssignedProcesses as usize;
				continue;
			}
			return unsafe {
				(0..list.NumberOfProcessIdsInList as usize)
					.map(|i| *list.ProcessIdList.as_ptr().add(i) as i32)
					.collect()
			};
		}
	}

	pub fn set_cores(&self, cores: f64) {
		*self.cores.lock() = cores;
		let _ = self.apply_rate(cores);
	}

	pub fn teardown(&self) {
		// SAFETY: the handle is ours and is closed exactly once (the registry
		// entry is removed before teardown runs).
		unsafe {
			CloseHandle(self.handle());
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// A core count becomes a fraction of the WHOLE MACHINE, not of one core.
	///
	/// This is the conversion the whole Windows backend rests on and the one
	/// place it differs in kind from the Linux backend, where `cpu.max` is
	/// expressed against a fixed period and the machine size never enters.
	/// Forgetting to divide by the processor count is the natural mistake, and
	/// its result is not a visible error: `CpuRate` 40_000 is out of range, the
	/// call is rejected, and the job runs with no cap while the settings row
	/// still says four cores. The exact expected values are computed by hand
	/// from the API contract (cycles per 10_000 of total capacity), not read
	/// back from the implementation.
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
		// The same core count means a different rate on a different machine,
		// which is the property a "cores times 100" implementation loses.
		assert_ne!(cpu_rate_per_10k(4.0, 16.0), cpu_rate_per_10k(4.0, 8.0));
		assert_eq!(cpu_rate_per_10k(4.0, 8.0), 5_000);
	}

	/// A budget at or past the machine size saturates at 10_000, never above.
	///
	/// `SetInformationJobObject` rejects a `CpuRate` above 10_000, and a
	/// rejected write leaves the job entirely uncapped. So the failure mode of
	/// an unclamped conversion is not "a slightly wrong cap" but "no cap",
	/// arriving exactly when the largest budget was requested.
	#[test]
	fn a_budget_at_or_past_the_machine_size_saturates_at_the_whole_machine() {
		assert_eq!(cpu_rate_per_10k(8.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(9.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(1_000.0, 8.0), 10_000);
	}

	/// A budget too small to express still produces the smallest real cap,
	/// never 0 — but only while the budget is a real positive cap.
	///
	/// `CpuRate` 0 with `HARD_CAP` set is rejected the same way an out-of-range
	/// value is, so rounding a tiny budget down to 0 turns "cap this session
	/// very hard" into "do not cap this session at all". The floor is what
	/// keeps the failure direction safe for positive cores.
	#[test]
	fn a_budget_too_small_to_express_floors_at_the_smallest_cap_not_at_zero() {
		// 0.001 of 128 processors rounds to 0 before the floor applies.
		assert_eq!(cpu_rate_per_10k(0.001, 128.0), 1);
		assert_eq!(cpu_rate_control(0.001, 128.0), CpuRateControl { enabled: true, rate: 1 });
	}

	/// Lifting the budget (cores <= 0, or non-finite) turns rate control off.
	///
	/// The conversion helper floors at 1, which is correct for a tiny cap and
	/// fatal if `set_cores(0)` / `/cpu-limit remove` reused it: HARD_CAP at
	/// rate 1 is 0.01% of the machine, not "uncapped".
	#[test]
	fn lifting_the_budget_disables_rate_control_instead_of_flooring_to_one() {
		assert_eq!(cpu_rate_control(0.0, 8.0), CpuRateControl { enabled: false, rate: 0 });
		assert_eq!(cpu_rate_control(-4.0, 8.0), CpuRateControl { enabled: false, rate: 0 });
		assert_eq!(cpu_rate_control(f64::NAN, 8.0), CpuRateControl { enabled: false, rate: 0 });
		assert_eq!(cpu_rate_control(f64::INFINITY, 8.0), CpuRateControl {
			enabled: false,
			rate:    0,
		});
		assert_eq!(cpu_rate_control(2.0, 8.0), CpuRateControl { enabled: true, rate: 2_500 });
	}

	/// Property: a positive finite budget is always HARD_CAP in 1..=10_000,
	/// monotonic in cores for a fixed machine, and a fraction of HOST cpus.
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
			assert_eq!(cpu_rate_control(0.0, host).enabled, false);
		}
	}

	/// The smallest expressible step is honoured rather than rounded away.
	///
	/// Half a processor's worth of difference must change the rate; a
	/// conversion that truncated to whole percent would collapse neighbouring
	/// budgets onto the same cap and make `set_cores` silently inert for small
	/// adjustments.
	#[test]
	fn neighbouring_budgets_do_not_collapse_onto_the_same_rate() {
		assert_eq!(cpu_rate_per_10k(1.0, 32.0), 313, "1/32 is 312.5, rounded half away from zero");
		assert_eq!(cpu_rate_per_10k(1.5, 32.0), 469);
		assert_eq!(cpu_rate_per_10k(2.0, 32.0), 625);
	}
}
