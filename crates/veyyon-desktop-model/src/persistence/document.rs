//! The file each §8.10 store is read from and written to.
//!
//! A store's shape lives in `persistence.rs`; this is the document around it:
//! which file holds it, whether the file holds one store or one per session,
//! and what a load does with a copy the binary does not recognise. The rule is
//! §8.10's: a stale shape is replaced by the default, never migrated and never
//! partially read, and the rejection states which store, which version was
//! found and which was wanted.
//!
//! Reading and writing files is not here. This layer turns a document into
//! state and state into a document, so the filesystem stays in the binary
//! crate and this one needs none to be tested.

use std::collections::HashMap;

use serde::{Serialize, de::DeserializeOwned};

use super::{
	ComposerStore, PanelsStore, PersistedState, PersistenceError, QueueStore, ShellStore,
	TranscriptStore, VersionedStore, WindowStore, validate_and_deserialize,
};
use crate::{connection::SessionId, review::ReviewsStore};

/// Every store §8.10 names, as the document the window keeps it in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, strum::EnumIter)]
pub enum StoreKind {
	/// Window position, size, maximised state and display, for the host.
	Window,
	/// Queue collapse and the active session, for the host.
	Shell,
	/// Which queue sections are collapsed, for the host.
	Queue,
	/// Right panel and drawer shape, per session.
	Panels,
	/// The disclosed tool cards, per session.
	Transcript,
	/// Draft text, attachments and queue mode, per session.
	Composer,
	/// Local review threads, partitioned by repository and file.
	Reviews,
}

impl StoreKind {
	/// Every kind, in the order §8.10's table states them.
	pub const ALL: [Self; 7] = [
		Self::Window,
		Self::Shell,
		Self::Queue,
		Self::Panels,
		Self::Transcript,
		Self::Composer,
		Self::Reviews,
	];

	/// The file name the document is kept under.
	#[must_use]
	pub const fn file_name(self) -> &'static str {
		match self {
			Self::Window => "window.json",
			Self::Shell => "shell.json",
			Self::Queue => "queue.json",
			Self::Panels => "panels.json",
			Self::Transcript => "transcript.json",
			Self::Composer => "composer.json",
			Self::Reviews => "reviews.json",
		}
	}

	/// Whether the document holds one store per session rather than one store.
	#[must_use]
	pub const fn per_session(self) -> bool {
		match self {
			Self::Window | Self::Shell | Self::Queue | Self::Reviews => false,
			Self::Panels | Self::Transcript | Self::Composer => true,
		}
	}

	/// Whether a write is fsynced.
	///
	/// Draft text and local review comments contain authored text, so both
	/// documents are fsynced.
	#[must_use]
	pub const fn fsync(self) -> bool {
		matches!(self, Self::Composer | Self::Reviews)
	}

	/// The version this binary writes, for the warn line a refusal states.
	#[must_use]
	pub const fn current_version(self) -> u32 {
		match self {
			Self::Window => WindowStore::CURRENT_VERSION,
			Self::Shell => ShellStore::CURRENT_VERSION,
			Self::Queue => QueueStore::CURRENT_VERSION,
			Self::Panels => PanelsStore::CURRENT_VERSION,
			Self::Transcript => TranscriptStore::CURRENT_VERSION,
			Self::Composer => ComposerStore::CURRENT_VERSION,
			Self::Reviews => ReviewsStore::CURRENT_VERSION,
		}
	}
}

/// A store a load refused, and why.
///
/// Carried out of the load rather than logged inside it, so the binary states
/// it once at warn level with the store, the version found and the version
/// wanted, and a test asserts on the refusal without reading a log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
	/// The store whose document was refused.
	pub kind:    StoreKind,
	/// The session whose entry was refused, for a per-session store.
	pub session: Option<SessionId>,
	/// What was wrong with the copy on disk.
	pub error:   PersistenceError,
}

impl PersistedState {
	/// Replaces one store with what the document on disk holds.
	///
	/// A refused document leaves the default in place: a host-scope store is
	/// reset and a per-session map is emptied, so nothing is served out of a
	/// shape this binary does not write. A per-session document is refused one
	/// entry at a time, so one session's stale panels do not cost another
	/// session its own.
	pub fn read_document(&mut self, kind: StoreKind, text: &str) -> Vec<Rejection> {
		match kind {
			StoreKind::Window => {
				let (store, refused) = read_single(kind, text);
				self.window = store;
				refused.into_iter().collect()
			},
			StoreKind::Shell => {
				let (store, refused) = read_single(kind, text);
				self.shell = store;
				refused.into_iter().collect()
			},
			StoreKind::Queue => {
				let (store, refused) = read_single(kind, text);
				self.queue = store;
				refused.into_iter().collect()
			},
			StoreKind::Panels => {
				let (map, refused) = read_per_session(kind, text);
				self.panels = map;
				refused
			},
			StoreKind::Transcript => {
				let (map, refused) = read_per_session(kind, text);
				self.transcripts = map;
				refused
			},
			StoreKind::Composer => {
				let (map, refused) = read_per_session(kind, text);
				self.composer = map;
				refused
			},
			StoreKind::Reviews => {
				let (store, refused) = read_single(kind, text);
				self.reviews = store;
				refused.into_iter().collect()
			},
		}
	}

	/// One store as the document it is written in.
	pub fn write_document(&self, kind: StoreKind) -> Result<String, PersistenceError> {
		match kind {
			StoreKind::Window => write_document(&self.window),
			StoreKind::Shell => write_document(&self.shell),
			StoreKind::Queue => write_document(&self.queue),
			StoreKind::Panels => write_document(&self.panels),
			StoreKind::Transcript => write_document(&self.transcripts),
			StoreKind::Composer => write_document(&self.composer),
			StoreKind::Reviews => write_document(&self.reviews),
		}
	}
}

/// Reads a host-scope document, leaving the default in place when the copy on
/// disk is not the shape this binary writes.
fn read_single<T>(kind: StoreKind, text: &str) -> (T, Option<Rejection>)
where
	T: VersionedStore + Default + DeserializeOwned,
{
	match validate_and_deserialize::<T>(text) {
		Ok(store) => (store, None),
		Err(error) => (T::default(), Some(Rejection { kind, session: None, error })),
	}
}

/// Reads a per-session document one entry at a time.
///
/// The map is a shape as well: a document that is not a map of sessions is
/// refused whole, because it holds no entry to keep.
fn read_per_session<T>(kind: StoreKind, text: &str) -> (HashMap<SessionId, T>, Vec<Rejection>)
where
	T: VersionedStore + DeserializeOwned,
{
	let raw: HashMap<SessionId, serde_json::Value> = match serde_json::from_str(text.trim()) {
		Ok(raw) => raw,
		Err(error) => {
			let error = super::parse_error(error);
			return (HashMap::new(), vec![Rejection { kind, session: None, error }]);
		},
	};
	let mut kept = HashMap::with_capacity(raw.len());
	let mut refused = Vec::new();
	for (session, value) in raw {
		match validate_and_deserialize::<T>(&value.to_string()) {
			Ok(store) => {
				kept.insert(session, store);
			},
			Err(error) => refused.push(Rejection { kind, session: Some(session), error }),
		}
	}
	(kept, refused)
}

/// Serializes one store, or states why it could not be written rather than
/// leaving an empty document where the operator's layout was.
fn write_document<T: Serialize>(store: &T) -> Result<String, PersistenceError> {
	serde_json::to_string(store)
		.map_err(|error| PersistenceError::SerializationFailed(error.to_string()))
}
