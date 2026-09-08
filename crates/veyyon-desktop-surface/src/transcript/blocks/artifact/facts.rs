//! What an artefact row states, and what its disclosed frame states instead
//! (§5.3).
//!
//! The artefact chrome is one row and one frame. The row is 24px: an icon, the
//! artefact's identity, and one summary of it — a pixel size, a line and byte
//! count, or the reason there is nothing to read. The frame below carries the
//! artefact itself and the facts that summary had no room for. Nothing the row
//! states is stated again in the frame, so this module decides both halves in
//! one place and the renderers only draw what it returns.

use veyyon_desktop_kit::IconName;

use super::decoder::ImageStatus;
use crate::{composer::human_bytes, model::Artifact};

/// Formats line counts for display (e.g. "1 line", "42 lines").
pub fn format_lines(lines: u32) -> String {
	if lines == 1 {
		"1 line".to_string()
	} else {
		format!("{lines} lines")
	}
}

/// The 24px row: an icon, the artefact's identity, and at most one summary.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRow {
	pub icon:    IconName,
	pub title:   String,
	pub summary: Option<String>,
	/// Whether the summary states a fault, which inks it in the error role.
	pub fault:   bool,
}

/// How a frame's line reads: an ordinary measurement, or a fault.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactRole {
	Note,
	Fault,
}

/// One line the disclosed frame states below the artefact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactFact {
	pub text: String,
	pub role: FactRole,
}

impl ArtifactFact {
	const fn note(text: String) -> Self {
		Self { text, role: FactRole::Note }
	}

	const fn fault(text: String) -> Self {
		Self { text, role: FactRole::Fault }
	}
}

/// The summary a file's row states: the reason it cannot be read, the pixel
/// size of the image it carries, or what was recorded of it.
fn file_summary(
	has_content: bool,
	lines: Option<u32>,
	bytes: Option<u64>,
	unavailable_reason: Option<&str>,
	image_status: Option<&ImageStatus>,
) -> Option<String> {
	if let Some(reason) = unavailable_reason {
		return Some(reason.to_owned());
	}
	match image_status {
		Some(ImageStatus::Valid { width, height, .. }) => return Some(format!("{width}×{height}")),
		Some(ImageStatus::Error { .. }) => return Some("unsupported image".to_owned()),
		None => {},
	}
	match (lines, bytes) {
		(Some(l), Some(b)) => Some(format!("{} · {}", format_lines(l), human_bytes(b))),
		(Some(l), None) => Some(format_lines(l)),
		(None, Some(b)) => Some(human_bytes(b)),
		(None, None) => has_content.then(|| "content available".to_owned()),
	}
}

/// The row for an artefact, given the decode result for the image it carries.
///
/// The status is passed in because decoding is cached per payload and both the
/// row and the frame read the same result.
pub fn artifact_row(artifact: &Artifact, image_status: Option<&ImageStatus>) -> ArtifactRow {
	match artifact {
		Artifact::Image { alt, .. } => {
			let summary = match image_status {
				Some(ImageStatus::Valid { width, height, .. }) => Some(format!("{width}×{height}")),
				Some(ImageStatus::Error { .. }) => Some("decode error".to_owned()),
				None => None,
			};
			let title = alt
				.as_deref()
				.filter(|s| !s.is_empty())
				.unwrap_or("Image attachment");
			ArtifactRow {
				icon: IconName::Image,
				title: title.to_owned(),
				fault: matches!(image_status, Some(ImageStatus::Error { .. })),
				summary,
			}
		},
		Artifact::File { path, has_content, lines, bytes, unavailable_reason, image } => {
			ArtifactRow {
				icon:    if image.is_some() {
					IconName::Image
				} else {
					IconName::File
				},
				title:   path.clone(),
				fault:   unavailable_reason.is_some()
					|| matches!(image_status, Some(ImageStatus::Error { .. })),
				summary: file_summary(
					*has_content,
					*lines,
					*bytes,
					unavailable_reason.as_deref(),
					image_status,
				),
			}
		},
	}
}

/// The lines the disclosed frame states, which are the ones the row did not.
///
/// A decoded image's frame states the encoding and the payload size, never the
/// pixel size the row already carries. A file whose row spent its summary on
/// the reason it cannot be read states what was recorded of it instead. A file
/// whose row already stated its counts adds nothing: its frame is the artefact
/// and the actions on it.
pub fn artifact_facts(
	artifact: &Artifact,
	image_status: Option<&ImageStatus>,
) -> Vec<ArtifactFact> {
	let payload = match artifact {
		Artifact::Image { data, .. } => Some(data.len() as u64),
		Artifact::File { image, .. } => image.as_ref().map(|bytes| bytes.len() as u64),
	};
	match image_status {
		Some(ImageStatus::Valid { format, .. }) => {
			let mut text = format.mime_type().to_owned();
			if let Some(size) = payload {
				text.push_str(" · ");
				text.push_str(&human_bytes(size));
			}
			return vec![ArtifactFact::note(text)];
		},
		Some(ImageStatus::Error { message }) => {
			return vec![ArtifactFact::fault(message.clone())];
		},
		None => {},
	}
	let Artifact::File { lines, bytes, unavailable_reason, .. } = artifact else {
		return Vec::new();
	};
	if unavailable_reason.is_none() {
		return Vec::new();
	}
	let mut facts = Vec::new();
	if let Some(l) = lines {
		facts.push(ArtifactFact::note(format!("Recorded lines: {l}")));
	}
	if let Some(b) = bytes {
		facts.push(ArtifactFact::note(format!("Recorded size: {}", human_bytes(*b))));
	}
	facts
}
