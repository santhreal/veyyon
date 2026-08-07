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

/// The `CpuRate` value for a budget of `cores` cores on a machine with `cpus`
/// logical processors.
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
fn cpu_rate_per_10k(cores: f64, cpus: f64) -> u32 {
	let fraction = (cores / cpus).clamp(0.0, 1.0);
	(fraction * 10_000.0).round().max(1.0) as u32
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
	pub fn create(name: &str, cores: f64) -> Result<Self> {
		let mut wide: Vec<u16> = name.encode_utf16().collect();
		wide.push(0);
		// SAFETY: `wide` is a valid NUL-terminated UTF-16 buffer for the
		// duration of the call; a null security descriptor gives the default.
		let handle = unsafe { CreateJobObjectW(std::ptr::null(), wide.as_ptr()) };
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

	/// Write the CPU rate for `cores` cores.
	fn apply_rate(&self, cores: f64) -> Result<()> {
		let cpus = std::thread::available_parallelism().map_or(1, |n| n.get()) as f64;
		let mut info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
			ControlFlags: JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
			..JOBOBJECT_CPU_RATE_CONTROL_INFORMATION::default()
		};
		info.Anonymous.CpuRate = cpu_rate_per_10k(cores, cpus);
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
			let _ = AssignProcessToJobObject(self.handle(), process);
			CloseHandle(process);
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
	/// `SetInformationJobObject` rejects a `CpuRate` above 10_000, and a rejected
	/// write leaves the job entirely uncapped. So the failure mode of an unclamped
	/// conversion is not "a slightly wrong cap" but "no cap", arriving exactly
	/// when the largest budget was requested.
	#[test]
	fn a_budget_at_or_past_the_machine_size_saturates_at_the_whole_machine() {
		assert_eq!(cpu_rate_per_10k(8.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(9.0, 8.0), 10_000);
		assert_eq!(cpu_rate_per_10k(1_000.0, 8.0), 10_000);
	}

	/// A budget too small to express still produces the smallest real cap,
	/// never 0.
	///
	/// `CpuRate` 0 with `HARD_CAP` set is rejected the same way an out-of-range
	/// value is, so rounding a tiny budget down to 0 turns "cap this session
	/// very hard" into "do not cap this session at all". The floor is what
	/// keeps the failure direction safe.
	#[test]
	fn a_budget_too_small_to_express_floors_at_the_smallest_cap_not_at_zero() {
		// 0.001 of 128 processors rounds to 0 before the floor applies.
		assert_eq!(cpu_rate_per_10k(0.001, 128.0), 1);
		assert_eq!(cpu_rate_per_10k(0.0, 8.0), 1);
		// Negative and NaN are not reachable through the settings schema, but a
		// clamp that let them through would produce a wild u32 cast.
		assert_eq!(cpu_rate_per_10k(-4.0, 8.0), 1);
		assert_eq!(cpu_rate_per_10k(f64::NAN, 8.0), 1);
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
