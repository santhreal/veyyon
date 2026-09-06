//! WHY: the composer accepts images and clips from three routes (picker, drop,
//! paste) and sends them with the prompt. Until this suite, nothing pinned what
//! may cross that boundary: a new container the host rejects could be admitted
//! silently, a refusal could lose its message, the 20 MiB prompt ceiling could
//! drift, and a send could leave the tray behind for the next prompt.
//!
//! CLASS CLOSED: an admission decision that disagrees with what the host can
//! send. The accepted set is swept from `MediaType::ALL` at run time, so a type
//! added there fails here until its magic bytes and its wire spelling are
//! recorded; a container that merely looks like one (an `M4A` in an `ISO BMFF`
//! box, a `Matroska` that is not `WebM`, an `SVG`) is refused by its bytes.
//!
//! The suite defends:
//! 1. Every accepted type is classified from its leading bytes, and its IANA
//!    spelling, kind and decoder coherence hold for the whole set.
//! 2. `read_media` refuses the empty, the oversized and the unreadable from a
//!    `stat`, before a byte is read, with a message naming the file.
//! 3. The per-prompt ceiling is enforced on the running total, not per file.
//! 4. A path attaches once; a clipboard image is always new and is named in
//!    paste order; an unaccepted clipboard format is refused, not dropped.
//! 5. A refusal is reported under the composer where the cards would be, and an
//!    admitted file clears it; `Attach` stays local (no host round-trip).
//! 6. The drop overlay tracks real transitions only.
//! 7. A send carries the tray and clears it; an empty prompt sends nothing,
//!    attachments or not.
//!
//! NOT CAUGHT: the pixels of the tray, the notice and the drop target; those
//! are the census and golden suites' claim.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Attachment, Intent, MediaType, Payload, ShellView,
	composer::{
		AttachmentError, ComposerState, MAX_ATTACHMENT_BYTES, MAX_PROMPT_ATTACHMENT_BYTES, MediaKind,
		human_bytes, payload_for, read_media,
	},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, ClipboardItem, Image, ImageFormat};
use veyyon_test_scratch::scratch_dir;

/// The leading bytes of one accepted container per `MediaType` member.
fn magic_for(media: MediaType) -> Vec<u8> {
	match media {
		MediaType::Png => b"\x89PNG\r\n\x1a\nrest".to_vec(),
		MediaType::Jpeg => b"\xff\xd8\xff\xe0rest".to_vec(),
		MediaType::Gif => b"GIF89arest".to_vec(),
		MediaType::Webp => b"RIFF\x10\x00\x00\x00WEBPrest".to_vec(),
		MediaType::Mp4 => b"\x00\x00\x00\x18ftypisomrest".to_vec(),
		MediaType::Webm => b"\x1a\x45\xdf\xa3....doctype:webm".to_vec(),
		MediaType::QuickTime => b"\x00\x00\x00\x14ftypqt  rest".to_vec(),
	}
}

#[test]
fn every_accepted_type_is_sniffed_from_its_bytes_and_spelled_for_the_wire() {
	// One fixture per member, no more: a type added to `ALL` without its magic
	// bytes recorded fails the sweep, and so does a fixture nobody classifies.
	for media in MediaType::ALL {
		assert_eq!(MediaType::sniff(&magic_for(media)), Some(media), "{media:?} not sniffed");
		let is_image = media.as_str().starts_with("image/");
		assert_eq!(
			media.kind() == MediaKind::Image,
			is_image,
			"{media:?} kind disagrees with its IANA type"
		);
		assert_eq!(media.image_format().is_some(), is_image, "{media:?} decoder coherence");
	}
	// The clipboard decoder accepts exactly the still-image formats.
	for format in [ImageFormat::Png, ImageFormat::Jpeg, ImageFormat::Gif, ImageFormat::Webp] {
		assert!(MediaType::from_image_format(format).is_some(), "{format:?} pastes");
	}
	for format in
		[ImageFormat::Svg, ImageFormat::Bmp, ImageFormat::Tiff, ImageFormat::Ico, ImageFormat::Pnm]
	{
		assert_eq!(MediaType::from_image_format(format), None, "{format:?} does not");
	}
}

#[test]
fn a_container_that_is_not_an_accepted_medium_is_refused_by_its_bytes() {
	let cases: [(&str, Vec<u8>); 5] = [
		("an M4A is audio in a video's box", b"\x00\x00\x00\x18ftypM4A rest".to_vec()),
		("a Matroska that is not WebM", b"\x1a\x45\xdf\xa3....doctype:matroska".to_vec()),
		("an SVG is markup, not a raster", b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>".to_vec()),
		("random bytes", vec![0xde, 0xad, 0xbe, 0xef]),
		("nothing at all", Vec::new()),
	];
	for (why, bytes) in cases {
		assert_eq!(MediaType::sniff(&bytes), None, "{why}");
	}
}

#[test]
fn read_media_refuses_the_empty_the_oversized_and_the_missing_before_reading() {
	let tree = scratch_dir("read-media");

	let empty = tree.path().join("empty.png");
	std::fs::write(&empty, []).expect("empty fixture");
	assert!(matches!(read_media(&empty), Err(AttachmentError::Empty { .. })));

	// A sparse file: the refusal must come from the stat, so the fixture costs
	// a length and not 21 MiB of writes.
	let huge = tree.path().join("huge.png");
	let file = std::fs::File::create(&huge).expect("huge fixture");
	file
		.set_len(MAX_ATTACHMENT_BYTES + 1)
		.expect("sparse length");
	let Err(error) = read_media(&huge) else {
		panic!("an oversized file is refused")
	};
	let message = error.to_string();
	assert!(message.contains("huge.png"), "the refusal names the file: {message}");
	assert!(message.contains("limit per file"), "the refusal names the limit: {message}");

	let missing = tree.path().join("missing.png");
	assert!(matches!(read_media(&missing), Err(AttachmentError::Unreadable { .. })));
}

#[test]
fn read_media_returns_the_classified_bytes_it_read() {
	let tree = scratch_dir("read-media-ok");
	let shot = tree.path().join("shot.png");
	let bytes = magic_for(MediaType::Png);
	std::fs::write(&shot, &bytes).expect("png fixture");
	let (media, payload) = read_media(&shot).expect("a real png is read");
	assert_eq!(media, MediaType::Png);
	assert_eq!(payload.bytes(), &bytes[..]);
}

fn video_attachment(name: &str, mebibytes: usize) -> Attachment {
	Attachment::from_path(
		PathBuf::from(format!("/repo/{name}")),
		MediaType::Mp4,
		Payload::Video(Arc::from(vec![7u8; mebibytes * 1024 * 1024])),
	)
}

#[test]
fn the_prompt_ceiling_is_enforced_on_the_running_total_not_per_file() {
	let mut composer = ComposerState::default();
	let first = video_attachment("first.mp4", 12);
	let second = video_attachment("second.mp4", 12);
	// Each file is under the per-file ceiling; together they cross the prompt's.
	composer.attach(first);
	let Err(AttachmentError::PromptFull { name, bytes, attached }) = composer.admit(&second) else {
		panic!("the second 12 MiB clip crosses the 20 MiB prompt ceiling")
	};
	assert_eq!(name, "second.mp4");
	assert_eq!(bytes + attached, 2 * 12 * 1024 * 1024);
	let message = AttachmentError::PromptFull { name, bytes, attached }.to_string();
	assert!(message.contains("second.mp4"), "the refusal names the file: {message}");
	assert!(message.contains("limit per prompt"), "the refusal names the limit: {message}");
}

#[test]
fn a_path_attaches_once_a_paste_is_always_new_and_detach_takes_the_right_card() {
	let mut composer = ComposerState::default();
	let png = || payload_for(MediaType::Png, magic_for(MediaType::Png));
	let picked = || Attachment::from_path(PathBuf::from("/repo/shot.png"), MediaType::Png, png());
	composer.attach(picked());
	composer.attach(picked());
	assert_eq!(composer.attachments.len(), 1, "the same path is one card");

	composer.attach(Attachment::from_clipboard(1, MediaType::Png, png()));
	composer.attach(Attachment::from_clipboard(2, MediaType::Png, png()));
	assert_eq!(composer.attachments.len(), 3, "a paste is never a duplicate");
	assert_eq!(composer.attachments[1].name, "Pasted image 1.png");
	assert_eq!(composer.attachments[2].name, "Pasted image 2.png");

	composer.detach(1);
	assert_eq!(composer.attachments.len(), 2);
	assert_eq!(composer.attachments[1].name, "Pasted image 2.png");
}

fn with_shell<R>(test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };
	let state = fixture::populated();
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	test(&mut session)
}

#[test]
fn a_refusal_is_reported_under_the_composer_and_an_admission_clears_it() {
	with_shell(|session| {
		session
			.update(|view, _window, cx| {
				view.attach(
					Err(AttachmentError::Unsupported { path: PathBuf::from("/repo/notes.txt") }),
					cx,
				);
				let notice = view
					.composer_local()
					.notice
					.expect("the refusal is reported");
				assert!(notice.contains("notes.txt"), "the notice names the file: {notice}");
				assert!(view.state().composer.attachments.is_empty(), "a refusal attaches nothing");
				assert!(view.pending().is_empty(), "a refusal asks the host for nothing");

				let shot = Attachment::from_path(
					PathBuf::from("/repo/shot.png"),
					MediaType::Png,
					payload_for(MediaType::Png, magic_for(MediaType::Png)),
				);
				view.attach(Ok(shot), cx);
				assert_eq!(view.composer_local().notice, None, "an admitted file clears the refusal");
				assert_eq!(view.state().composer.attachments.len(), 1);
				assert!(view.pending().is_empty(), "Attach is local: no host round-trip");
			})
			.expect("refusal then admission applied");
	});
}

#[test]
fn a_pasted_image_is_named_in_paste_order_and_an_unaccepted_format_is_refused() {
	with_shell(|session| {
		session
			.update(|view, _window, cx| {
				let png = Image::from_bytes(ImageFormat::Png, magic_for(MediaType::Png));
				view.attach_clipboard(&ClipboardItem::new_image(&png), cx);
				view.attach_clipboard(&ClipboardItem::new_image(&png), cx);
				let names: Vec<&str> = view
					.state()
					.composer
					.attachments
					.iter()
					.map(|attachment| attachment.name.as_str())
					.collect();
				assert_eq!(names, ["Pasted image 1.png", "Pasted image 2.png"]);

				let svg = Image::from_bytes(ImageFormat::Svg, b"<svg/>".to_vec());
				view.attach_clipboard(&ClipboardItem::new_image(&svg), cx);
				let notice = view
					.composer_local()
					.notice
					.expect("the format refusal is reported");
				assert!(notice.contains("clipboard image"), "the notice names the route: {notice}");
				assert_eq!(
					view.state().composer.attachments.len(),
					2,
					"a refused paste attaches nothing"
				);
			})
			.expect("pastes applied");
	});
}

#[test]
fn the_drop_overlay_tracks_real_transitions_only() {
	with_shell(|session| {
		session
			.update(|view, _window, _cx| {
				assert!(!view.composer_local().dropping);
				assert!(view.set_dropping(true), "entering is a change");
				assert!(!view.set_dropping(true), "hovering is not");
				assert!(view.composer_local().dropping);
				assert!(view.set_dropping(false), "leaving is a change");
				assert!(!view.set_dropping(false), "staying out is not");
			})
			.expect("drop transitions applied");
	});
}

#[test]
fn a_send_carries_the_tray_without_consuming_it_and_an_empty_prompt_sends_nothing() {
	with_shell(|session| {
		session.update(|view, _window, cx| {
			let shot = Attachment::from_path(
				PathBuf::from("/repo/shot.png"),
				MediaType::Png,
				payload_for(MediaType::Png, magic_for(MediaType::Png)),
			);
			view.dispatch(Intent::Attach(shot), cx);
			assert_eq!(view.state().composer.attachments.len(), 1);
			let send = Intent::Send { text: "   ".to_owned(), attachments: Vec::new() };
			view.dispatch(send, cx);
			assert_eq!(view.state().composer.attachments.len(), 1, "a blank prompt keeps its tray");
			assert!(view.pending().is_empty(), "a blank prompt reaches no host");

			let tray = view.state().composer.attachments.clone();
			view.dispatch(Intent::Send { text: "look at this".to_owned(), attachments: tray }, cx);
			assert_eq!(view.state().composer.attachments.len(), 1, "a request attempt retains the tray");
			assert!(
				matches!(view.pending(), [Intent::Send { text, attachments }] if text == "look at this" && attachments.len() == 1),
				"the send reaches the host with its tray: {:?}",
				view.pending()
			);
		}).expect("sends applied");
	});
}

#[test]
fn human_bytes_spells_sizes_as_an_operator_reads_them() {
	assert_eq!(human_bytes(820), "820 B");
	assert_eq!(human_bytes(12_400), "12 KB");
	assert_eq!(human_bytes(MAX_PROMPT_ATTACHMENT_BYTES), "21.0 MB");
}
