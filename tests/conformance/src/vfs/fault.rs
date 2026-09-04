//! Deterministic fault injection for virtual filesystem testing.

use std::{collections::BTreeMap, fmt, time::Duration};

use serde::{Deserialize, Serialize};

use super::{
	error::{VfsError, VfsResult},
	path::VfsPath,
	traits::{FileSystem, VfsDirEntry, VfsMetadata},
};
use crate::rng::Rng;

/// The mode of torn write corruption to simulate.
///
/// A torn write models incomplete, corrupted, or out-of-order sector
/// persistence during power loss, kernel panics, or non-atomic hardware writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TornWriteMode {
	/// Only the prefix up to `split_offset` is persisted; the remainder is
	/// dropped.
	PrefixOnly,
	/// Prefix is persisted, and the remainder of the payload is zeroed out.
	ZeroPadding,
	/// Prefix is persisted, and the remaining bytes are bitwise inverted.
	CorruptedSuffix,
	/// High and low halves of the payload are swapped and persisted.
	BlockSwap,
}

impl fmt::Display for TornWriteMode {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::PrefixOnly => write!(f, "prefix-only"),
			Self::ZeroPadding => write!(f, "zero-padding"),
			Self::CorruptedSuffix => write!(f, "corrupted-suffix"),
			Self::BlockSwap => write!(f, "block-swap"),
		}
	}
}

/// The kind of virtual filesystem fault to inject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum FaultKind {
	/// Generic I/O error (`EIO`).
	Io { message: String },
	/// Virtual disk storage exhausted (`ENOSPC`).
	NoSpace,
	/// Access or permission denied (`EACCES`).
	AccessDenied,
	/// Partial write where only `accepted_bytes` are persisted.
	PartialWrite { accepted_bytes: usize },
	/// Torn write where corrupted/half-applied bytes are persisted.
	TornWrite { split_offset: usize, mode: TornWriteMode },
	/// Injected virtual latency delay (expressed as a duration, without
	/// sleeping).
	Latency { virtual_duration: Duration },
}

impl FaultKind {
	/// Returns a list of sample instances for every variant of [`FaultKind`].
	///
	/// Used by test suites to sweep the variant space at run time and fail if a
	/// new variant is added without dedicated coverage.
	#[must_use]
	pub fn all_variants() -> [Self; 6] {
		[
			Self::Io { message: "simulated device fault".to_owned() },
			Self::NoSpace,
			Self::AccessDenied,
			Self::PartialWrite { accepted_bytes: 16 },
			Self::TornWrite { split_offset: 8, mode: TornWriteMode::PrefixOnly },
			Self::Latency { virtual_duration: Duration::from_millis(50) },
		]
	}

	/// Short discriminator name for the fault.
	#[must_use]
	pub const fn name(&self) -> &'static str {
		match self {
			Self::Io { .. } => "io",
			Self::NoSpace => "nospace",
			Self::AccessDenied => "access_denied",
			Self::PartialWrite { .. } => "partial_write",
			Self::TornWrite { .. } => "torn_write",
			Self::Latency { .. } => "latency",
		}
	}
}

/// A deterministic execution plan specifying which operation ordinal triggers
/// which fault.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FaultPlan {
	faults: BTreeMap<u64, FaultKind>,
}

impl FaultPlan {
	/// Creates an empty fault plan.
	#[must_use]
	pub const fn new() -> Self {
		Self { faults: BTreeMap::new() }
	}

	/// Injects a fault at a specific operation ordinal.
	pub fn insert(&mut self, ordinal: u64, fault: FaultKind) {
		self.faults.insert(ordinal, fault);
	}

	/// Retrieves the fault scheduled for operation `ordinal`, if any.
	#[must_use]
	pub fn get(&self, ordinal: u64) -> Option<&FaultKind> {
		self.faults.get(&ordinal)
	}

	/// Returns the number of planned faults.
	#[must_use]
	pub fn len(&self) -> usize {
		self.faults.len()
	}

	/// Whether the plan contains no faults.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.faults.is_empty()
	}

	/// Deterministically generates a fault plan from a `crate::rng::Rng` stream.
	#[must_use]
	pub fn from_rng(rng: &mut Rng, total_ops: u64, fault_count: u64) -> Self {
		let mut plan = Self::new();
		if total_ops == 0 || fault_count == 0 {
			return plan;
		}

		for _ in 0..fault_count {
			let ordinal = rng.below(total_ops);
			let fault_type = rng.below(6);
			let fault = match fault_type {
				0 => FaultKind::Io { message: "deterministic io fault".to_owned() },
				1 => FaultKind::NoSpace,
				2 => FaultKind::AccessDenied,
				3 => {
					let accepted = (rng.below(64) + 1) as usize;
					FaultKind::PartialWrite { accepted_bytes: accepted }
				},
				4 => {
					let mode = match rng.below(4) {
						0 => TornWriteMode::PrefixOnly,
						1 => TornWriteMode::ZeroPadding,
						2 => TornWriteMode::CorruptedSuffix,
						_ => TornWriteMode::BlockSwap,
					};
					let split = (rng.below(32) + 1) as usize;
					FaultKind::TornWrite { split_offset: split, mode }
				},
				_ => {
					let millis = rng.below(200) + 1;
					FaultKind::Latency { virtual_duration: Duration::from_millis(millis) }
				},
			};
			plan.insert(ordinal, fault);
		}
		plan
	}
}

/// A filesystem decorator that intercepts operations and injects faults
/// according to a [`FaultPlan`].
#[derive(Debug)]
pub struct FaultInjectingFs<F: FileSystem> {
	inner:                F,
	plan:                 FaultPlan,
	current_ordinal:      u64,
	accumulated_latency:  Duration,
	injected_fault_count: usize,
}

impl<F: FileSystem> FaultInjectingFs<F> {
	/// Wraps `fs` with fault injection controlled by `plan`.
	pub const fn new(fs: F, plan: FaultPlan) -> Self {
		Self {
			inner: fs,
			plan,
			current_ordinal: 0,
			accumulated_latency: Duration::ZERO,
			injected_fault_count: 0,
		}
	}

	/// Returns total accumulated virtual latency injected across all operations.
	#[must_use]
	pub const fn accumulated_latency(&self) -> Duration {
		self.accumulated_latency
	}

	/// Returns the number of faults that have been triggered.
	#[must_use]
	pub const fn injected_fault_count(&self) -> usize {
		self.injected_fault_count
	}

	/// Returns current operation ordinal counter.
	#[must_use]
	pub const fn current_ordinal(&self) -> u64 {
		self.current_ordinal
	}

	/// Advances the operation counter and returns any active fault for this
	/// step.
	fn advance_ordinal(&mut self) -> (u64, Option<FaultKind>) {
		let ordinal = self.current_ordinal;
		self.current_ordinal += 1;
		let fault = self.plan.get(ordinal).cloned();
		if fault.is_some() {
			self.injected_fault_count += 1;
		}
		(ordinal, fault)
	}

	/// Applies torn write data transformation to `input`.
	pub(crate) fn compute_torn_data(
		input: &[u8],
		split_offset: usize,
		mode: TornWriteMode,
	) -> Vec<u8> {
		let split = split_offset.min(input.len());
		match mode {
			TornWriteMode::PrefixOnly => input[..split].to_vec(),
			TornWriteMode::ZeroPadding => {
				let mut out = input[..split].to_vec();
				out.resize(input.len(), 0);
				out
			},
			TornWriteMode::CorruptedSuffix => {
				let mut out = input[..split].to_vec();
				for b in &input[split..] {
					out.push(!*b);
				}
				out
			},
			TornWriteMode::BlockSwap => {
				let mut out = Vec::with_capacity(input.len());
				out.extend_from_slice(&input[split..]);
				out.extend_from_slice(&input[..split]);
				out
			},
		}
	}
}

impl<F: FileSystem> FileSystem for FaultInjectingFs<F> {
	fn read(&self, path: &VfsPath) -> VfsResult<Vec<u8>> {
		// Note: read is &self, so we read through to inner
		self.inner.read(path)
	}

	fn write(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: path.to_string(), message });
				},
				FaultKind::NoSpace => {
					return Err(VfsError::NoSpace { path: path.to_string() });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: path.to_string() });
				},
				FaultKind::PartialWrite { accepted_bytes } => {
					let to_write = accepted_bytes.min(data.len());
					let prefix = &data[..to_write];
					// Persist ONLY the accepted prefix to ensure the accepted portion is real
					self.inner.write(path, prefix)?;
					return Err(VfsError::PartialWrite {
						path:            path.to_string(),
						bytes_written:   to_write,
						bytes_requested: data.len(),
					});
				},
				FaultKind::TornWrite { split_offset, mode } => {
					let torn_bytes = Self::compute_torn_data(data, split_offset, mode);
					self.inner.write(path, &torn_bytes)?;
					return Err(VfsError::TornWrite {
						path:          path.to_string(),
						bytes_written: torn_bytes.len(),
						detail:        format!("mode={mode}"),
					});
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
			}
		}
		self.inner.write(path, data)
	}

	fn append(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: path.to_string(), message });
				},
				FaultKind::NoSpace => {
					return Err(VfsError::NoSpace { path: path.to_string() });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: path.to_string() });
				},
				FaultKind::PartialWrite { accepted_bytes } => {
					let to_write = accepted_bytes.min(data.len());
					let prefix = &data[..to_write];
					self.inner.append(path, prefix)?;
					return Err(VfsError::PartialWrite {
						path:            path.to_string(),
						bytes_written:   to_write,
						bytes_requested: data.len(),
					});
				},
				FaultKind::TornWrite { split_offset, mode } => {
					let torn_bytes = Self::compute_torn_data(data, split_offset, mode);
					self.inner.append(path, &torn_bytes)?;
					return Err(VfsError::TornWrite {
						path:          path.to_string(),
						bytes_written: torn_bytes.len(),
						detail:        format!("mode={mode}"),
					});
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
			}
		}
		self.inner.append(path, data)
	}

	fn metadata(&self, path: &VfsPath) -> VfsResult<VfsMetadata> {
		self.inner.metadata(path)
	}

	fn create_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: path.to_string(), message });
				},
				FaultKind::NoSpace => {
					return Err(VfsError::NoSpace { path: path.to_string() });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: path.to_string() });
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
				_ => {},
			}
		}
		self.inner.create_dir_all(path)
	}

	fn read_dir(&self, path: &VfsPath) -> VfsResult<Vec<VfsDirEntry>> {
		self.inner.read_dir(path)
	}

	fn remove_file(&mut self, path: &VfsPath) -> VfsResult<()> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: path.to_string(), message });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: path.to_string() });
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
				_ => {},
			}
		}
		self.inner.remove_file(path)
	}

	fn remove_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: path.to_string(), message });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: path.to_string() });
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
				_ => {},
			}
		}
		self.inner.remove_dir_all(path)
	}

	fn rename(&mut self, from: &VfsPath, to: &VfsPath) -> VfsResult<()> {
		let (_ordinal, fault) = self.advance_ordinal();
		if let Some(f) = fault {
			match f {
				FaultKind::Io { message } => {
					return Err(VfsError::IoFault { path: from.to_string(), message });
				},
				FaultKind::NoSpace => {
					return Err(VfsError::NoSpace { path: to.to_string() });
				},
				FaultKind::AccessDenied => {
					return Err(VfsError::AccessDenied { path: from.to_string() });
				},
				FaultKind::Latency { virtual_duration } => {
					self.accumulated_latency += virtual_duration;
				},
				_ => {},
			}
		}
		self.inner.rename(from, to)
	}

	fn exists(&self, path: &VfsPath) -> bool {
		self.inner.exists(path)
	}
}
