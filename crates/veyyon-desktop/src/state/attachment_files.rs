//! Content-addressed clipboard payloads beside the versioned draft documents.

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
	collections::HashMap,
	fs::{self, File, OpenOptions},
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use sha2::{Digest, Sha256};
use veyyon_desktop_surface::{
	Attachment,
	composer::{
		AttachmentSource, MAX_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENT_BYTES, Payload,
		preview::MAX_ATTACHMENTS,
	},
};

static NEXT_WRITE: AtomicU64 = AtomicU64::new(0);

/// Retaining the payload allocation makes its pointer a safe cache key.
#[derive(Debug, Default)]
pub struct AttachmentFiles {
	paths: HashMap<(usize, usize), (Payload, PathBuf)>,
}

impl AttachmentFiles {
	/// Materializes clipboard bytes once. Path attachments retain their original
	/// location.
	pub fn paths(&mut self, root: &Path, attachments: &[Attachment]) -> io::Result<Vec<String>> {
		if attachments.len() > MAX_ATTACHMENTS {
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"draft attachment count exceeds the prompt limit",
			));
		}
		if attachments
			.iter()
			.try_fold(0u64, |sum, attachment| sum.checked_add(attachment.bytes()))
			.is_none_or(|sum| sum > MAX_PROMPT_ATTACHMENT_BYTES)
		{
			return Err(io::Error::new(
				io::ErrorKind::InvalidData,
				"draft attachments exceed the prompt byte limit",
			));
		}
		self.paths.retain(|key, _| {
			attachments.iter().any(|attachment| {
				matches!(attachment.source, AttachmentSource::Clipboard(_))
					&& (attachment.payload.bytes().as_ptr() as usize, attachment.payload.bytes().len())
						== *key
			})
		});
		attachments
			.iter()
			.map(|attachment| match &attachment.source {
				AttachmentSource::Path(path) => Ok(path.to_string_lossy().into_owned()),
				AttachmentSource::Clipboard(_) => {
					let bytes = attachment.payload.bytes();
					let key = (bytes.as_ptr() as usize, bytes.len());
					if let Some((_, path)) = self.paths.get(&key) {
						return Ok(path.to_string_lossy().into_owned());
					}
					let path = materialize(root, bytes)?;
					self
						.paths
						.insert(key, (attachment.payload.clone(), path.clone()));
					Ok(path.to_string_lossy().into_owned())
				},
			})
			.collect()
	}
}

fn materialize(root: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
	if bytes.is_empty() || bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"clipboard attachment is empty or exceeds its byte limit",
		));
	}
	let digest = Sha256::digest(bytes);
	let folder = root.join("draft-attachments-v1");
	fs::create_dir_all(&folder)?;
	let folder = fs::canonicalize(folder)?;
	let path = folder.join(format!("{digest:x}.bin"));
	match fs::symlink_metadata(&path) {
		Ok(metadata) => {
			if !metadata.is_file() || metadata.len() != bytes.len() as u64 {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"saved clipboard attachment has an invalid type or length",
				));
			}
			let mut file = File::open(&path)?.take(MAX_ATTACHMENT_BYTES + 1);
			let mut hash = Sha256::new();
			let mut chunk = [0u8; 8192];
			loop {
				let read = file.read(&mut chunk)?;
				if read == 0 {
					break;
				}
				hash.update(&chunk[..read]);
			}
			if hash.finalize() != digest {
				return Err(io::Error::new(
					io::ErrorKind::InvalidData,
					"saved clipboard attachment failed its content digest",
				));
			}
			return Ok(path);
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(error),
	}
	let temporary = folder.join(format!(
		"{digest:x}.writing-{}-{}",
		std::process::id(),
		NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
	));
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(0o600);
	let mut file = options.open(&temporary)?;
	let result = (|| {
		file.write_all(bytes)?;
		file.sync_all()?;
		drop(file);
		fs::rename(&temporary, &path)
	})();
	if result.is_err() {
		let _ = fs::remove_file(&temporary);
	}
	result.map(|()| path)
}
