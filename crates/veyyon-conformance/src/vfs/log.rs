//! Total-ordered operation logging for virtual filesystem verification.

use std::{
	fmt,
	sync::{Arc, Mutex},
	time::Duration,
};

use serde::{Deserialize, Serialize};

use super::{
	error::{VfsError, VfsResult},
	path::VfsPath,
	traits::{FileSystem, VfsDirEntry, VfsMetadata},
};

/// The kind of virtual filesystem operation being performed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OpKind {
	Read,
	Write { byte_count: usize },
	Append { byte_count: usize },
	Metadata,
	CreateDirAll,
	ReadDir,
	RemoveFile,
	RemoveDirAll,
	Rename { to: VfsPath },
	Exists,
}

impl fmt::Display for OpKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Read => write!(f, "read"),
			Self::Write { byte_count } => write!(f, "write({byte_count}B)"),
			Self::Append { byte_count } => write!(f, "append({byte_count}B)"),
			Self::Metadata => write!(f, "metadata"),
			Self::CreateDirAll => write!(f, "create_dir_all"),
			Self::ReadDir => write!(f, "read_dir"),
			Self::RemoveFile => write!(f, "remove_file"),
			Self::RemoveDirAll => write!(f, "remove_dir_all"),
			Self::Rename { to } => write!(f, "rename(to={to})"),
			Self::Exists => write!(f, "exists"),
		}
	}
}

/// The result outcome of a filesystem operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OpOutcome {
	Success { details: String },
	Failure { error: VfsError },
}

impl OpOutcome {
	#[must_use]
	pub const fn is_success(&self) -> bool {
		matches!(self, Self::Success { .. })
	}

	#[must_use]
	pub const fn is_failure(&self) -> bool {
		matches!(self, Self::Failure { .. })
	}
}

/// A recorded virtual filesystem operation entry with monotonically increasing
/// ordinal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpRecord {
	/// Monotonically increasing ordinal defining total ordering across all
	/// operations.
	pub ordinal:             u64,
	/// Target virtual path of the operation.
	pub path:                VfsPath,
	/// Operation type and parameters.
	pub op:                  OpKind,
	/// Outcome of the operation (success or failure).
	pub outcome:             OpOutcome,
	/// Injected or virtual timestamp offset associated with this operation.
	pub virtual_time_offset: Duration,
}

/// A thread-safe, monotonic operation log.
#[derive(Debug, Clone, Default)]
pub struct OpLog {
	inner: Arc<Mutex<LogState>>,
}

#[derive(Debug, Default)]
struct LogState {
	next_ordinal: u64,
	records:      Vec<OpRecord>,
}

impl OpLog {
	/// Creates a new empty operation log.
	#[must_use]
	pub fn new() -> Self {
		Self { inner: Arc::new(Mutex::new(LogState { next_ordinal: 0, records: Vec::new() })) }
	}

	/// Appends an operation record to the log, assigning the next sequential
	/// ordinal.
	pub fn record(
		&self,
		path: VfsPath,
		op: OpKind,
		outcome: OpOutcome,
		virtual_time_offset: Duration,
	) -> u64 {
		let mut state = self.inner.lock().expect("log mutex not poisoned");
		let ordinal = state.next_ordinal;
		state.next_ordinal += 1;
		state
			.records
			.push(OpRecord { ordinal, path, op, outcome, virtual_time_offset });
		ordinal
	}

	/// Returns a snapshot copy of all recorded operations.
	#[must_use]
	pub fn entries(&self) -> Vec<OpRecord> {
		let state = self.inner.lock().expect("log mutex not poisoned");
		state.records.clone()
	}

	/// Returns the number of logged operations.
	#[must_use]
	pub fn len(&self) -> usize {
		let state = self.inner.lock().expect("log mutex not poisoned");
		state.records.len()
	}

	/// Whether the log is currently empty.
	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// Clears all entries from the log and resets the ordinal counter.
	pub fn clear(&self) {
		let mut state = self.inner.lock().expect("log mutex not poisoned");
		state.next_ordinal = 0;
		state.records.clear();
	}
}

/// A decorating filesystem wrapper that records every invocation to an
/// [`OpLog`].
#[derive(Debug)]
pub struct LoggingFs<F: FileSystem> {
	inner: F,
	log:   OpLog,
}

impl<F: FileSystem> LoggingFs<F> {
	/// Wraps `fs` with operation logging into `log`.
	pub const fn new(fs: F, log: OpLog) -> Self {
		Self { inner: fs, log }
	}

	/// Returns a reference to the shared operation log.
	pub const fn log(&self) -> &OpLog {
		&self.log
	}

	/// Returns a reference to the underlying filesystem.
	pub const fn inner(&self) -> &F {
		&self.inner
	}

	/// Returns a mutable reference to the underlying filesystem.
	pub const fn inner_mut(&mut self) -> &mut F {
		&mut self.inner
	}

	/// Consumes wrapper and returns underlying filesystem.
	pub fn into_inner(self) -> F {
		self.inner
	}
}

impl<F: FileSystem> FileSystem for LoggingFs<F> {
	fn read(&self, path: &VfsPath) -> VfsResult<Vec<u8>> {
		let result = self.inner.read(path);
		let outcome = match &result {
			Ok(bytes) => OpOutcome::Success { details: format!("read {} bytes", bytes.len()) },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::Read, outcome, Duration::ZERO);
		result
	}

	fn write(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		let op = OpKind::Write { byte_count: data.len() };
		let result = self.inner.write(path, data);
		let outcome = match &result {
			Ok(n) => OpOutcome::Success { details: format!("wrote {n} bytes") },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self.log.record(path.clone(), op, outcome, Duration::ZERO);
		result
	}

	fn append(&mut self, path: &VfsPath, data: &[u8]) -> VfsResult<usize> {
		let op = OpKind::Append { byte_count: data.len() };
		let result = self.inner.append(path, data);
		let outcome = match &result {
			Ok(n) => OpOutcome::Success { details: format!("appended {n} bytes") },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self.log.record(path.clone(), op, outcome, Duration::ZERO);
		result
	}

	fn metadata(&self, path: &VfsPath) -> VfsResult<VfsMetadata> {
		let result = self.inner.metadata(path);
		let outcome = match &result {
			Ok(meta) => {
				OpOutcome::Success { details: format!("type={:?}, len={}", meta.file_type, meta.len) }
			},
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::Metadata, outcome, Duration::ZERO);
		result
	}

	fn create_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		let result = self.inner.create_dir_all(path);
		let outcome = match &result {
			Ok(()) => OpOutcome::Success { details: "created directory".to_owned() },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::CreateDirAll, outcome, Duration::ZERO);
		result
	}

	fn read_dir(&self, path: &VfsPath) -> VfsResult<Vec<VfsDirEntry>> {
		let result = self.inner.read_dir(path);
		let outcome = match &result {
			Ok(entries) => OpOutcome::Success { details: format!("listed {} entries", entries.len()) },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::ReadDir, outcome, Duration::ZERO);
		result
	}

	fn remove_file(&mut self, path: &VfsPath) -> VfsResult<()> {
		let result = self.inner.remove_file(path);
		let outcome = match &result {
			Ok(()) => OpOutcome::Success { details: "removed file".to_owned() },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::RemoveFile, outcome, Duration::ZERO);
		result
	}

	fn remove_dir_all(&mut self, path: &VfsPath) -> VfsResult<()> {
		let result = self.inner.remove_dir_all(path);
		let outcome = match &result {
			Ok(()) => OpOutcome::Success { details: "removed directory tree".to_owned() },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self
			.log
			.record(path.clone(), OpKind::RemoveDirAll, outcome, Duration::ZERO);
		result
	}

	fn rename(&mut self, from: &VfsPath, to: &VfsPath) -> VfsResult<()> {
		let op = OpKind::Rename { to: to.clone() };
		let result = self.inner.rename(from, to);
		let outcome = match &result {
			Ok(()) => OpOutcome::Success { details: format!("renamed to {to}") },
			Err(err) => OpOutcome::Failure { error: err.clone() },
		};
		self.log.record(from.clone(), op, outcome, Duration::ZERO);
		result
	}

	fn exists(&self, path: &VfsPath) -> bool {
		let exists = self.inner.exists(path);
		let outcome = OpOutcome::Success { details: format!("exists={exists}") };
		self
			.log
			.record(path.clone(), OpKind::Exists, outcome, Duration::ZERO);
		exists
	}
}
