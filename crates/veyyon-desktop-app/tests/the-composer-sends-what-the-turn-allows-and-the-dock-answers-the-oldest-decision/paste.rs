//! Pasted images in a saved draft: kept in files named by their bytes and
//! read back byte for byte when the thread is shown again or the window
//! reopens.
//!
//! WHY: a pasted image has no file of its own, and a draft that saved only
//! the paths of attached files dropped it on every thread switch and reopen.
//! The class covers each way a paste leaves the tray: a switch after its
//! bytes were kept, a switch before, a reopen, a kept file changed on disk,
//! a directory that cannot be written and an image over the size limit.
//! Gap: the thumbnail the chip draws is not compared, the clipboard holds the
//! image gpui was handed rather than one a platform decoded, and a kept file
//! no draft names any more is left on disk.

use std::{fmt::Write as _, fs, path::PathBuf};

use gpui::{ClipboardItem, Image, ImageFormat, TestAppContext};
use sha2::{Digest as _, Sha256};
use veyyon_desktop_app::composer::{
	attach::{MAX_ATTACHMENT_BYTES, human_bytes},
	stash,
};
use veyyon_desktop_model::{SessionId, Store};
use veyyon_desktop_ui::editor::actions::Paste;
use veyyon_test_scratch::scratch_dir;

use super::{Win, other, reopen, sid, window};

/// A 1x1 PNG.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01\x08\x06\0\0\0\x1f\x15\xc4\x89\0\0\0\nIDATx\x9cc\0\x01\0\0\x05\0\x01\r\n-\xb4\0\0\0\0IEND\xaeB`\x82";

/// The 1x1 PNG followed by `tag`, so two tags are two images.
fn png(tag: u8) -> Vec<u8> {
	let mut bytes = PNG.to_vec();
	bytes.push(tag);
	bytes
}

/// Copies `bytes` to the clipboard as an image.
fn copy(w: &Win<'_>, bytes: &[u8]) {
	let image = Image::from_bytes(ImageFormat::Png, bytes.to_vec());
	w.cx.write_to_clipboard(ClipboardItem::new_image(&image));
}

/// Pastes `bytes` into the composer as an image and waits for its file.
fn paste(w: &mut Win<'_>, bytes: &[u8]) {
	copy(w, bytes);
	w.focus();
	w.dispatch(Paste);
}

/// Why the last attachment was refused, as the composer states it.
fn notice(w: &Win<'_>) -> Option<String> {
	w.composer
		.read_with(&*w.cx, |composer, _| composer.notice().map(str::to_owned))
}

/// The bytes of each file the draft saved for `session` names.
fn saved_bytes(w: &Win<'_>, session: &SessionId) -> Vec<Vec<u8>> {
	w.saved(session)
		.map(|draft| draft.attachments)
		.unwrap_or_default()
		.iter()
		.map(|path| fs::read(path).unwrap_or_else(|error| panic!("{path} reads: {error}")))
		.collect()
}

/// The name and bytes of each file kept under `root`, by name.
fn kept(root: &std::path::Path) -> Vec<(String, Vec<u8>)> {
	let Ok(entries) = fs::read_dir(root.join("draft-attachments-v1")) else {
		return Vec::new();
	};
	let mut kept: Vec<(String, Vec<u8>)> = entries
		.map(|entry| {
			let path: PathBuf = entry.expect("the kept directory lists").path();
			let name = path
				.file_name()
				.expect("a kept file has a name")
				.to_string_lossy()
				.into_owned();
			(name, fs::read(&path).expect("a kept file reads"))
		})
		.collect();
	kept.sort();
	kept
}

/// `bytes`' SHA-256 in hex, the name their kept file is expected under.
fn hex(bytes: &[u8]) -> String {
	Sha256::digest(bytes)
		.iter()
		.fold(String::with_capacity(64), |mut name, byte| {
			let _ = write!(name, "{byte:02x}");
			name
		})
}

/// Names each image of `images` as the paste numbered from `first`.
fn pasted(first: usize, images: &[Vec<u8>]) -> Vec<(String, Vec<u8>)> {
	images
		.iter()
		.enumerate()
		.map(|(ix, bytes)| (format!("Pasted image {}", first + ix), bytes.clone()))
		.collect()
}

#[gpui::test]
fn pasted_images_come_back_byte_for_byte_after_a_thread_switch_and_a_reopen(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("pasted-draft-round-trip");
	app.update(|cx| stash::install(&tree, cx));
	let (one, two) = (png(1), png(2));
	let persisted = {
		let mut w = window(app, vec![]);
		let over = [PNG, &vec![0; MAX_ATTACHMENT_BYTES as usize]].concat();
		paste(&mut w, &over);
		let expected = format!(
			"Cannot attach Pasted image 1: {} exceeds the {} limit per file",
			human_bytes(over.len() as u64),
			human_bytes(MAX_ATTACHMENT_BYTES),
		);
		assert_eq!(notice(&w), Some(expected));
		assert!(kept(&tree).is_empty(), "an image over the limit wrote no file");
		for bytes in [&one, &one, &two] {
			paste(&mut w, bytes);
		}
		let images = vec![one.clone(), one.clone(), two.clone()];
		assert_eq!(w.tray(), pasted(2, &images));
		let mut files = vec![(hex(&one), one.clone()), (hex(&two), two.clone())];
		files.sort();
		assert_eq!(kept(&tree), files, "one file per distinct image, named by its SHA-256");
		assert_eq!(saved_bytes(&w, &sid()), images, "the draft names the three kept files");

		w.show(other());
		assert!(w.tray().is_empty(), "the other thread's tray holds none of them");
		w.show(sid());
		assert_eq!(w.tray(), pasted(5, &images));
		assert_eq!(notice(&w), None);
		w.state
			.read_with(&*w.cx, |state, _| state.store().persisted.clone())
	};
	let w = reopen(app, Store::with_persisted(persisted), Vec::new());
	assert_eq!(w.tray(), pasted(1, &[one.clone(), one, two]));
	assert_eq!(notice(&w), None);
}

#[gpui::test]
fn an_image_taken_to_another_thread_before_its_file_is_written_lands_in_the_draft_it_left(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("pasted-draft-parked");
	app.update(|cx| stash::install(&tree, cx));
	let mut w = window(app, vec![]);
	let one = png(1);
	copy(&w, &one);
	w.focus();
	let state = w.state.clone();
	w.cx.update(|window, cx| {
		window.dispatch_action(Box::new(Paste), cx);
		cx.defer(move |cx| {
			state.update(cx, |state, cx| {
				state.open_session(other(), cx);
			});
		});
	});
	w.cx.run_until_parked();
	assert!(w.tray().is_empty(), "the other thread's tray holds none of it");
	assert_eq!(
		saved_bytes(&w, &sid()),
		std::slice::from_ref(&one),
		"the thread it left names its file"
	);
	assert_eq!(w.saved(&other()), None);
	w.show(sid());
	assert_eq!(w.tray(), pasted(2, &[one]));
}

#[gpui::test]
fn a_kept_file_changed_on_disk_is_refused_and_pasting_the_image_again_rewrites_it(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("pasted-draft-changed");
	app.update(|cx| stash::install(&tree, cx));
	let mut w = window(app, vec![]);
	let one = png(1);
	paste(&mut w, &one);
	let path = w.saved(&sid()).expect("the draft is saved").attachments[0].clone();
	fs::write(&path, png(9)).expect("the kept file is writable");

	w.show(other());
	w.show(sid());
	assert!(w.tray().is_empty(), "the changed file is not attached");
	assert_eq!(
		notice(&w).as_deref(),
		Some("Cannot restore a pasted image: its kept copy changed on disk"),
	);
	assert_eq!(w.saved(&sid()), None, "the draft no longer names the changed file");

	paste(&mut w, &one);
	assert_eq!(fs::read(&path).expect("the kept file reads"), one, "the file holds the image again");
	assert_eq!(saved_bytes(&w, &sid()), [one]);
}

#[gpui::test]
fn an_image_whose_file_cannot_be_written_stays_in_the_tray_and_states_why(
	app: &mut TestAppContext,
) {
	let tree = scratch_dir("pasted-draft-blocked");
	let blocked = tree.join("blocked");
	fs::write(&blocked, b"not a directory").expect("the scratch directory is writable");
	app.update(|cx| stash::install(&blocked, cx));
	let mut w = window(app, vec![]);
	let one = png(1);
	paste(&mut w, &one);
	assert_eq!(w.tray(), pasted(1, &[one]), "the image is still sent with the next prompt");
	let notice = notice(&w).expect("the composer states why the image is not kept");
	assert!(notice.starts_with("Cannot keep Pasted image 1 with the draft: "), "{notice}");
	assert_eq!(w.saved(&sid()), None, "the draft names no file");
	assert_eq!(
		fs::read(&blocked).expect("the blocking file reads"),
		b"not a directory",
		"nothing was written beside it",
	);
}
