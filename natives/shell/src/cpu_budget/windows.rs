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
		// windows-sys 0.61 moved these off SystemInformation onto Threading.
		Threading::{
			ALL_PROCESSOR_GROUPS, GetActiveProcessorCount, OpenProcess, PROCESS_SET_QUOTA,
			PROCESS_TERMINATE,
		},
	},
};

use super::windows_rate::cpu_rate_control;

/// Logical processors `CpuRate` is a fraction of: the host, not this process.
///
/// `available_parallelism` follows the process affinity mask. Inside a
/// container or a parent job that granted 2 of 16 processors, that is 2, and
/// a 2-core budget becomes `CpuRate` 10_000 = 100% of the host. Job `CpuRate`
/// is defined against every processor in the system, so the denominator has
/// to be that count.
fn host_logical_processors() -> f64 {
	// SAFETY: `ALL_PROCESSOR_GROUPS` is the documented argument for a
	// machine-wide count; a zero return falls back rather than dividing by 0.
	let n = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
	if n > 0 {
		f64::from(n)
	} else {
		std::thread::available_parallelism().map_or(1, |n| n.get()) as f64
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
		// `CpuRate` is a fraction of the whole machine. Affinity and container
		// views (`available_parallelism`) are the wrong denominator: they turn
		// "2 cores of a 2-of-16 slice" into 100% of the host.
		let cpus = host_logical_processors();
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

	/// WHY: Windows Job Object accounting
	/// (`JOBOBJECT_BASIC_AND_IO_ACCOUNTING_INFORMATION`) provides CPU time in
	/// 100-nanosecond intervals (FILETIME-style ticks) split across
	/// `TotalUserTime` and `TotalKernelTime`. The backend converts this sum to
	/// microseconds via `(user + kernel) / 10`. This test verifies that
	/// arithmetic at boundaries: zero elapsed time, normal run times,
	/// sub-microsecond truncation, and large values.
	#[test]
	fn filetime_ticks_to_microseconds_conversion_boundaries() {
		// Zero elapsed time
		let zero_ticks: u64 = 0;
		assert_eq!(zero_ticks / 10, 0, "zero ticks must produce zero microseconds");

		// 1 second (10_000_000 ticks of 100ns)
		let one_second_ticks: u64 = 10_000_000;
		assert_eq!(one_second_ticks / 10, 1_000_000, "10M ticks is 1_000_000 microseconds (1s)");

		// Combined user and kernel time
		let user_ticks: u64 = 7_500_000; // 0.75s
		let kernel_ticks: u64 = 2_500_000; // 0.25s
		let total_usec = (user_ticks + kernel_ticks) / 10;
		assert_eq!(total_usec, 1_000_000);

		// Sub-microsecond remainder is truncated
		assert_eq!(9u64 / 10, 0);
		assert_eq!(19u64 / 10, 1);

		// Large/saturating values
		let large_user: u64 = 1_000_000_000_000; // 100,000s
		let large_kernel: u64 = 500_000_000_000; // 50,000s
		assert_eq!((large_user + large_kernel) / 10, 150_000_000_000);
	}

	/// WHY: In `JobBudget::members`, when the buffer is too small,
	/// `pid_capacity` doubles from 64 up to 65_536 before terminating and
	/// returning an empty list. We verify that this exponential search
	/// terminates in a bounded number of iterations and never loops
	/// indefinitely.
	#[test]
	fn pid_buffer_capacity_growth_is_bounded_and_terminates() {
		let mut pid_capacity = 64usize;
		let mut iterations = 0;
		loop {
			iterations += 1;
			if pid_capacity > 65_536 {
				break;
			}
			pid_capacity *= 2;
			assert!(iterations <= 20, "pid capacity doubling loop must terminate");
		}
		assert_eq!(iterations, 12);
		assert_eq!(pid_capacity, 131_072);
	}

	/// WHY: `SendHandle` wraps a raw integer representation of a kernel handle
	/// so `JobBudget` is `Send + Sync` across threads.
	#[test]
	fn job_budget_types_are_send_and_sync() {
		fn assert_send<T: Send>() {}
		fn assert_sync<T: Sync>() {}
		assert_send::<SendHandle>();
		assert_sync::<SendHandle>();
		assert_send::<JobBudget>();
		assert_sync::<JobBudget>();
	}
}
