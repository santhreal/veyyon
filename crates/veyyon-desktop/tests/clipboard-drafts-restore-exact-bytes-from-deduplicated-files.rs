//! WHY: a clipboard attachment has no source path and used to disappear from
//! saved drafts. This tests the production content-addressed file store,
//! corruption/refusal and byte limits. Native attachment preview and platform
//! clipboard decoding are outside this suite.

use std::{fs, sync::Arc};

use veyyon_desktop::state::attachment_files::AttachmentFiles;
use veyyon_desktop_surface::{
	Attachment,
	composer::{MAX_ATTACHMENT_BYTES, MediaType, Payload, read_media},
};
use veyyon_test_scratch::scratch_dir;

fn clipboard(bytes: &[u8]) -> Attachment {
	Attachment::from_clipboard(1, MediaType::Text, Payload::Data(Arc::from(bytes)))
}

#[test]
fn independent_clipboard_allocations_reuse_a_file_and_restore_the_original_bytes() {
	let tree = scratch_dir("clipboard-draft-round-trip");
	let first = clipboard(b"draft attachment text\n");
	let second = clipboard(b"draft attachment text\n");
	let mut files = AttachmentFiles::default();
	let first_paths = files.paths(tree.path(), &[first]).unwrap();
	let second_paths = files.paths(tree.path(), &[second]).unwrap();
	assert_eq!(first_paths, second_paths);
	assert_eq!(fs::read(&first_paths[0]).unwrap(), b"draft attachment text\n");
	let restored = read_media(std::path::Path::new(&first_paths[0])).unwrap();
	assert_eq!(restored.1.bytes(), b"draft attachment text\n");
	assert_eq!(
		fs::read_dir(tree.path().join("draft-attachments-v1"))
			.unwrap()
			.count(),
		1
	);
}

#[test]
fn corrupt_content_is_not_reused_and_original_payload_is_not_consumed() {
	let tree = scratch_dir("clipboard-draft-corruption");
	let attachment = clipboard(b"original text");
	let paths = AttachmentFiles::default()
		.paths(tree.path(), std::slice::from_ref(&attachment))
		.unwrap();
	fs::write(&paths[0], b"modified text").unwrap();
	let error = AttachmentFiles::default()
		.paths(tree.path(), std::slice::from_ref(&attachment))
		.unwrap_err();
	assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
	assert_eq!(attachment.payload.bytes(), b"original text");
}

#[test]
fn unwritable_destination_and_excess_payloads_do_not_produce_partial_draft_paths() {
	let tree = scratch_dir("clipboard-draft-refusal");
	let blocked = tree.path().join("blocked");
	fs::write(&blocked, b"not a directory").unwrap();
	let attachment = clipboard(b"retained");
	assert!(
		AttachmentFiles::default()
			.paths(&blocked, std::slice::from_ref(&attachment))
			.is_err()
	);
	assert_eq!(attachment.payload.bytes(), b"retained");
	let huge = clipboard(&vec![b'x'; MAX_ATTACHMENT_BYTES as usize + 1]);
	assert_eq!(
		AttachmentFiles::default()
			.paths(tree.path(), &[huge])
			.unwrap_err()
			.kind(),
		std::io::ErrorKind::InvalidData
	);
	assert!(!tree.path().join("draft-attachments-v1").exists());
}

#[test]
fn removed_clipboard_data_is_released_without_deleting_saved_draft_bytes() {
	let tree = scratch_dir("clipboard-draft-release");
	let bytes: Arc<[u8]> = Arc::from(b"saved clipboard text".as_slice());
	let weak = Arc::downgrade(&bytes);
	let attachment = Attachment::from_clipboard(1, MediaType::Text, Payload::Data(bytes));
	let mut files = AttachmentFiles::default();
	let paths = files.paths(tree.path(), &[attachment]).unwrap();
	files.paths(tree.path(), &[]).unwrap();
	assert!(weak.upgrade().is_none(), "removed clipboard data stayed allocated");
	assert_eq!(fs::read(&paths[0]).unwrap(), b"saved clipboard text");
}
