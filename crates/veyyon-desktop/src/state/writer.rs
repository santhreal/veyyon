//! The debounced write side of §8.10.
//!
//! A store is marked when its value changes and written once the debounce
//! window has passed, so a burst of keystrokes or a dragged handle costs one
//! write rather than one per frame. The window drives `flush_due` from its own
//! timer and `flush_all` on a clean shutdown; the deadline is a millisecond
//! the caller passes in, so a test moves time by hand and never waits on a
//! clock.
//!
//! A document is written to a sibling temporary file and renamed over the
//! previous one, so a window killed mid-write leaves the old layout rather
//! than half of the new one. Draft text is fsynced before that rename and
//! nothing else is (§8.10).

use std::{
	collections::{BTreeMap, BTreeSet},
	fs::{self, File},
	io::{self, Write as _},
};

use veyyon_desktop_model::{PersistedState, PersistenceError, StoreKind};

use super::StateDir;

/// The debounce window §8.10 states.
pub const DEBOUNCE_MS: u64 = 400;

/// A document waiting for its debounce window to pass.
#[derive(Debug, Clone)]
struct Pending {
	document: String,
	due_ms:   u64,
}

/// What a write attempt could not do.
///
/// A store the window cannot serialize and a store it cannot write are one
/// failure to the operator: the copy on disk is not what the window holds. The
/// reason is a line rather than an error type, because it is stated and not
/// matched on.
#[derive(Debug)]
pub struct WriteFailure {
	/// The store that stayed on disk as it was.
	pub kind:   StoreKind,
	/// Why the write did not land.
	pub reason: String,
}

impl WriteFailure {
	/// A store whose document could not be written to its file.
	fn write(kind: StoreKind, error: &io::Error) -> Self {
		Self { kind, reason: error.to_string() }
	}

	/// A store whose value could not be turned into a document, which is a
	/// store the window cannot write rather than one it wrote wrong.
	#[must_use]
	pub fn serialization(kind: StoreKind, error: &PersistenceError) -> Self {
		Self { kind, reason: error.to_string() }
	}
}

/// Holds each changed document until its debounce window passes.
#[derive(Debug)]
pub struct StateWriter {
	dir:     StateDir,
	pending: BTreeMap<StoreKind, Pending>,
	/// Stores whose write has already failed once, so a directory that cannot
	/// be written states itself once instead of on every change.
	failed:  BTreeSet<StoreKind>,
}

impl StateWriter {
	/// A writer over one state directory.
	#[must_use]
	pub const fn new(dir: StateDir) -> Self {
		Self { dir, pending: BTreeMap::new(), failed: BTreeSet::new() }
	}

	/// The directory the documents are written to.
	#[must_use]
	pub const fn dir(&self) -> &StateDir {
		&self.dir
	}

	/// Holds a changed document, due one debounce window from the change that
	/// started it.
	///
	/// The deadline is set by the first change and not extended by the ones
	/// that follow, so text typed without pause is still written every
	/// window rather than only once the typing stops.
	pub fn mark(&mut self, kind: StoreKind, document: String, now_ms: u64) {
		match self.pending.get_mut(&kind) {
			Some(pending) => pending.document = document,
			None => {
				self
					.pending
					.insert(kind, Pending { document, due_ms: now_ms.saturating_add(DEBOUNCE_MS) });
			},
		}
	}

	/// Whether any document is waiting.
	#[must_use]
	pub fn is_pending(&self) -> bool {
		!self.pending.is_empty()
	}

	/// Writes every document whose window has passed.
	pub fn flush_due(&mut self, now_ms: u64) -> Vec<WriteFailure> {
		let due: Vec<StoreKind> = self
			.pending
			.iter()
			.filter(|(_, pending)| pending.due_ms <= now_ms)
			.map(|(kind, _)| *kind)
			.collect();
		self.write_each(&due)
	}

	/// Writes everything waiting, for a clean shutdown.
	pub fn flush_all(&mut self) -> Vec<WriteFailure> {
		let all: Vec<StoreKind> = self.pending.keys().copied().collect();
		self.write_each(&all)
	}

	fn write_each(&mut self, kinds: &[StoreKind]) -> Vec<WriteFailure> {
		let mut failures = Vec::new();
		for kind in kinds {
			let Some(pending) = self.pending.remove(kind) else {
				continue;
			};
			match self.write(*kind, &pending.document) {
				Ok(()) => {
					self.failed.remove(kind);
				},
				Err(error) => {
					if self.failed.insert(*kind) {
						failures.push(WriteFailure::write(*kind, &error));
					}
				},
			}
		}
		failures
	}

	/// Writes one document beside the previous one and renames it over it.
	fn write(&self, kind: StoreKind, document: &str) -> io::Result<()> {
		fs::create_dir_all(self.dir.root())?;
		let final_path = self.dir.path(kind);
		let temp_path = final_path.with_extension("json.writing");
		{
			let mut file = File::create(&temp_path)?;
			file.write_all(document.as_bytes())?;
			if kind.fsync() {
				file.sync_all()?;
			}
		}
		fs::rename(&temp_path, &final_path)
	}
}

/// The last state written, so only a store that changed is written again.
#[derive(Debug)]
pub struct StateTracker {
	last: PersistedState,
}

impl StateTracker {
	/// A tracker over the state a window started from.
	#[must_use]
	pub const fn new(last: PersistedState) -> Self {
		Self { last }
	}

	/// The state as last written.
	#[must_use]
	pub const fn last(&self) -> &PersistedState {
		&self.last
	}

	/// Marks every store whose value differs from the one last written.
	///
	/// Returns the stores that could not be serialized, which the window
	/// cannot write at all rather than writing wrong.
	pub fn sync(
		&mut self,
		next: &PersistedState,
		writer: &mut StateWriter,
		now_ms: u64,
	) -> Vec<WriteFailure> {
		let mut errors = Vec::new();
		for kind in StoreKind::ALL {
			if !changed(&self.last, next, kind) {
				continue;
			}
			match next.write_document(kind) {
				Ok(document) => writer.mark(kind, document, now_ms),
				Err(error) => errors.push(WriteFailure::serialization(kind, &error)),
			}
		}
		self.last = next.clone();
		errors
	}
}

/// Whether one store differs between two states.
///
/// The match is exhaustive so a store added to §8.10's table does not
/// silently stop being written.
fn changed(last: &PersistedState, next: &PersistedState, kind: StoreKind) -> bool {
	match kind {
		StoreKind::Window => last.window != next.window,
		StoreKind::Shell => last.shell != next.shell,
		StoreKind::Queue => last.queue != next.queue,
		StoreKind::Panels => last.panels != next.panels,
		StoreKind::Transcript => last.transcripts != next.transcripts,
		StoreKind::Composer => last.composer != next.composer,
	}
}
