//! Where the window keeps what it remembers, and how it reads it back.
//!
//! §8.10 names seven stores, each versioned, each read once at startup and
//! written debounced. This module is the disk side of that: the directory the
//! documents live in, the load that refuses a shape this binary does not
//! write, and the debounced writer in `writer`.
//!
//! The shapes themselves, and the rule for refusing one, belong to
//! `veyyon_desktop_model::persistence`. Nothing here decides what a store
//! holds; it decides which file holds it and when the file is written.

use std::{fs, io, path::PathBuf};

use veyyon_desktop_model::{PersistedState, Rejection, StoreKind};

mod keeper;
mod memory;
mod writer;

pub use keeper::{Keeper, placement};
pub use memory::{host_shape, record_draft, session_shape};
pub use writer::{DEBOUNCE_MS, StateTracker, StateWriter, WriteFailure};

/// Environment variable naming the directory the window keeps its state in,
/// for a test or a second window that must not share the operator's own.
pub const VEYYON_DESKTOP_STATE_DIR_ENV: &str = "VEYYON_DESKTOP_STATE_DIR";

/// The directory holding one document per §8.10 store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateDir {
	root: PathBuf,
}

impl StateDir {
	/// The directory the documents are read from and written to.
	///
	/// `VEYYON_DESKTOP_STATE_DIR` wins, so a test and a scene never touch the
	/// operator's layout. Otherwise it is `desktop` inside the active
	/// profile's agent directory, beside the socket the window attaches to.
	/// `None` when there is no home directory to build a profile path under,
	/// which is a window that remembers nothing rather than one that writes
	/// somewhere arbitrary.
	#[must_use]
	pub fn discover() -> Option<Self> {
		if let Some(root) = std::env::var_os(VEYYON_DESKTOP_STATE_DIR_ENV)
			.filter(|root| !root.is_empty())
			.map(PathBuf::from)
		{
			return Some(Self { root });
		}
		crate::endpoint::default_agent_dir().map(|agent| Self { root: agent.join("desktop") })
	}

	/// A state directory at an explicit path.
	#[must_use]
	pub const fn at(root: PathBuf) -> Self {
		Self { root }
	}

	/// The directory the documents are in.
	#[must_use]
	pub const fn root(&self) -> &PathBuf {
		&self.root
	}

	/// The file one store is kept in.
	#[must_use]
	pub fn path(&self, kind: StoreKind) -> PathBuf {
		self.root.join(kind.file_name())
	}

	/// Reads every store once, as §8.10 requires.
	///
	/// A document that is absent is a window that has not saved that store
	/// yet, which is the default and not a refusal. A document that is
	/// unreadable, stale, truncated or holds a key this binary does not write
	/// leaves the default in place and comes back as a `Rejection`, so the
	/// operator whose layout reset is told which store reset and why.
	#[must_use]
	pub fn load(&self) -> (PersistedState, Vec<Rejection>) {
		let mut state = PersistedState::new();
		let mut rejections = Vec::new();
		for kind in StoreKind::ALL {
			let path = self.path(kind);
			let text = match fs::read_to_string(&path) {
				Ok(text) => text,
				Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
				Err(error) => {
					rejections.push(Rejection {
						kind,
						session: None,
						error: veyyon_desktop_model::PersistenceError::DeserializationFailed(
							error.to_string(),
						),
					});
					continue;
				},
			};
			rejections.extend(state.read_document(kind, &text));
		}
		(state, rejections)
	}
}

/// States each refused store on stderr, once, at warn level (§8.10).
///
/// An operator whose layout reset is told which store reset, for which
/// session, and what the copy on disk was, rather than watching the window
/// come up at its defaults with no reason given.
pub fn report_rejections(rejections: &[Rejection]) {
	for rejection in rejections {
		let store = rejection.kind.file_name();
		let wanted = rejection.kind.current_version();
		match &rejection.session {
			Some(session) => eprintln!(
				"warn: {store} for session {session} was not read and its default is in use: {error}; \
				 this binary writes version {wanted}",
				session = session.0,
				error = rejection.error,
			),
			None => eprintln!(
				"warn: {store} was not read and its default is in use: {error}; this binary writes \
				 version {wanted}",
				error = rejection.error,
			),
		}
	}
}
