//! Pasted attachments kept as files, so a saved draft names them by path.
//!
//! A pasted image has no path of its own. The composer writes its bytes
//! under the window's state directory, in a file named by their SHA-256, and
//! records that path in the draft like any attached file, so reopening the
//! window reads the same bytes back. Two pastes of the same bytes share one
//! file. A kept file whose bytes no longer hash to its name is rewritten
//! when the same bytes are kept again and refused when a draft reads it
//! back.

use std::{
	fmt::Write as _,
	fs, io,
	path::{Path, PathBuf},
	process,
	sync::atomic::{AtomicU64, Ordering},
};

use gpui::{App, Global};
use sha2::{Digest as _, Sha256};

use super::attach::{self, AttachError, Attachment, Source, pasted_name};

/// The directory under the state directory the files are kept in; the suffix
/// is the version of the naming scheme.
const DIR: &str = "draft-attachments-v1";

/// Numbers the partial files this process writes, so two writes of the same
/// bytes never share one.
static NEXT_PARTIAL: AtomicU64 = AtomicU64::new(0);

/// The directory pasted attachments are kept in.
struct Kept(PathBuf);

impl Global for Kept {}

/// Keeps pasted attachments under `state_dir`, the directory the window
/// writes its stores in. A window that keeps no state installs none, and
/// its pasted attachments last only while it is open.
pub fn install(state_dir: &Path, cx: &mut App) {
	cx.set_global(Kept(state_dir.join(DIR)));
}

/// The directory pasted attachments are kept in, when the window has one.
pub(super) fn dir(cx: &App) -> Option<PathBuf> {
	cx.try_global::<Kept>().map(|kept| kept.0.clone())
}

/// Whether `path` is a file kept in `dir`.
pub(super) fn holds(dir: &Path, path: &Path) -> bool {
	path.parent() == Some(dir)
}

/// The name the file holding `bytes` is kept under: their SHA-256 in hex.
fn name(bytes: &[u8]) -> String {
	Sha256::digest(bytes)
		.iter()
		.fold(String::with_capacity(64), |mut name, byte| {
			let _ = write!(name, "{byte:02x}");
			name
		})
}

/// Writes `bytes` to the file named by their hash in `dir`, or reuses the
/// file already holding them, and returns its path. The bytes are written to
/// a partial file first and renamed over the name, so a reader never sees a
/// part of them.
///
/// # Errors
///
/// The error creating `dir` or writing the file.
pub(super) fn keep(dir: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
	let name = name(bytes);
	let path = dir.join(&name);
	if fs::read(&path).is_ok_and(|held| *held == *bytes) {
		return Ok(path);
	}
	fs::create_dir_all(dir)?;
	let partial = dir.join(format!(
		".{name}.{}.{}.partial",
		process::id(),
		NEXT_PARTIAL.fetch_add(1, Ordering::Relaxed)
	));
	let written = fs::write(&partial, bytes).and_then(|()| fs::rename(&partial, &path));
	if written.is_err() {
		let _ = fs::remove_file(&partial);
	}
	written.map(|()| path)
}

/// Reads back the kept file at `path`, refusing one whose bytes no longer
/// hash to its name.
///
/// # Errors
///
/// Why the file cannot be restored.
pub(super) fn read(path: &Path) -> Result<Attachment, AttachError> {
	let attachment = attach::read_file(path).map_err(|error| match error {
		AttachError::Unreadable { source, .. } => {
			AttachError::Unrestored { reason: source.to_string() }
		},
		other => other,
	})?;
	if path.file_name().and_then(|held| held.to_str()) != Some(name(&attachment.bytes).as_str()) {
		return Err(AttachError::Unrestored { reason: "its kept copy changed on disk".to_owned() });
	}
	Ok(attachment)
}

impl Attachment {
	/// The attachment read back from the file a pasted one was kept in, shown
	/// as the paste numbered `ordinal`.
	#[must_use]
	pub(super) fn pasted(self, ordinal: u64) -> Self {
		let kept = match self.source {
			Source::Path(path) => Some(path),
			Source::Clipboard { kept, .. } => kept,
		};
		Self { name: pasted_name(ordinal), source: Source::Clipboard { ordinal, kept }, ..self }
	}
}
