//! The wire form of a composer attachment.

use veyyon_desktop_model::AttachmentSubmission;
use veyyon_desktop_surface::{Attachment, AttachmentSource};

/// The wire form of one attachment. The id is the attachment's place in the
/// prompt and where it came from, so two chips that carry the same bytes are
/// still two attachments and a duplicate id never reaches the host.
pub(super) fn submission_of((position, attachment): (usize, &Attachment)) -> AttachmentSubmission {
	let origin = match &attachment.source {
		AttachmentSource::Path(path) => path.display().to_string(),
		AttachmentSource::Clipboard(ordinal) => format!("clipboard:{ordinal}"),
	};
	AttachmentSubmission {
		id:         format!("{position}:{origin}"),
		name:       attachment.name.clone(),
		media_type: attachment.media.as_str().to_owned(),
		data:       attachment.payload.bytes().to_vec(),
	}
}
