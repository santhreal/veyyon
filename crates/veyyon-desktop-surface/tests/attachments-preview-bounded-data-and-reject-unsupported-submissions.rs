//! WHY: text attachments use text input, not vision, while opaque documents
//! must never reach a provider without document support. Preview memory and
//! draft retention must not depend on attachment size or a successful request.
//! These tests drive production classification and `ShellView` dispatch; they
//! do not prove native picker behavior or painted preview geometry.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use std::{io::Cursor, path::PathBuf};

use composer_layout::render_session;
use veyyon_desktop_model::{InputModality, RequestId};
use veyyon_desktop_surface::{
	Attachment, Intent, MediaType,
	composer::{
		AttachmentError, ComposerState, ModelChoice, ModelControl, ModelOption, payload_for,
		preview::{
			AttachmentPreview, MAX_ATTACHMENTS, MAX_BINARY_PREVIEW_BYTES, MAX_TEXT_PREVIEW_CHARS,
		},
		read_media,
	},
	fixture,
};
use veyyon_test_scratch::scratch_dir;

fn attachment(media: MediaType, bytes: Vec<u8>) -> Attachment {
	Attachment::from_path(PathBuf::from("/repo/data"), media, payload_for(media, bytes))
}

fn model(input: Vec<InputModality>) -> ModelControl {
	let choice = ModelChoice { provider: "provider".into(), model: "selected-model".into() };
	ModelControl {
		current: Some(choice.clone()),
		options: vec![ModelOption { choice, name: "Selected model".into(), reasoning: false, input }],
	}
}

#[test]
fn text_and_document_previews_are_bounded_and_preserve_original_type_and_size() {
	let tree = scratch_dir("attachment-previews");
	for (name, bytes, media) in [
		("renamed.png", "λ\n".repeat(1024).into_bytes(), MediaType::Text),
		("report.txt", b"%PDF-1.7 opaque content".to_vec(), MediaType::Pdf),
		("binary.jpg", [0, 255, 13, 17].repeat(1024), MediaType::Binary),
	] {
		let path = tree.path().join(name);
		std::fs::write(&path, &bytes).expect("file fixture");
		let (classified, payload) = read_media(&path).expect("bounded file read");
		let item = Attachment::from_path(path, classified, payload);
		assert_eq!(item.media, media);
		assert_eq!(item.bytes(), bytes.len() as u64);
		assert_eq!(item.payload.bytes(), bytes);
		match &item.preview {
			AttachmentPreview::Text(text) => {
				assert_eq!(text.chars().count(), MAX_TEXT_PREVIEW_CHARS);
				assert!(text.chars().all(|ch| !ch.is_control()));
			},
			AttachmentPreview::Binary(text) => assert!(text.len() < MAX_BINARY_PREVIEW_BYTES * 3),
			other => panic!("wrong preview for {media:?}: {other:?}"),
		}
	}
	assert!(matches!(read_media(tree.path()), Err(AttachmentError::NotFile { .. })));
}

#[test]
fn image_preview_decodes_bounded_pixels_without_changing_submission_bytes() {
	let mut png = Cursor::new(Vec::new());
	image::DynamicImage::new_rgb8(8, 4)
		.write_to(&mut png, image::ImageFormat::Png)
		.expect("PNG");
	let bytes = png.into_inner();
	let item = attachment(MediaType::Png, bytes.clone());
	assert!(matches!(&item.preview, AttachmentPreview::Image(_)));
	assert_eq!(item.payload.bytes(), bytes);
	let corrupt = attachment(MediaType::Png, b"\x89PNG\r\n\x1a\ntruncated".to_vec());
	let composer =
		ComposerState { model: Some(model(vec![InputModality::Image])), ..ComposerState::default() };
	assert!(composer.rejection_reason(&corrupt).is_some());
	let oversized = attachment(MediaType::Png, vec![0; 20 * 1024 * 1024]);
	assert!(
		matches!(&oversized.preview, AttachmentPreview::Unavailable(reason) if reason.contains("preview limit"))
	);
}

#[test]
fn modality_decisions_fail_closed_and_documents_never_inherit_text_or_image_support() {
	let text = attachment(MediaType::Text, b"plain text".to_vec());
	let video = attachment(MediaType::Mp4, b"\0\0\0\x18ftypisom".to_vec());
	let pdf = attachment(MediaType::Pdf, b"%PDF-1.7".to_vec());
	let binary = attachment(MediaType::Binary, vec![0, 255]);
	for input in
		[vec![], vec![InputModality::Text], vec![InputModality::Image], vec![InputModality::Video]]
	{
		let composer =
			ComposerState { model: Some(model(input.clone())), ..ComposerState::default() };
		assert_eq!(composer.rejection_reason(&text).is_none(), input.contains(&InputModality::Text));
		assert_eq!(
			composer.rejection_reason(&video).is_none(),
			input.contains(&InputModality::Video)
		);
		for document in [&pdf, &binary] {
			assert!(
				composer
					.rejection_reason(document)
					.expect("refusal")
					.contains("not supported by the host")
			);
		}
	}
	assert!(
		ComposerState::default()
			.rejection_reason(&text)
			.expect("unknown model")
			.contains("unknown")
	);
}

#[test]
fn tray_count_and_submission_size_are_bounded_even_for_direct_sends() {
	let mut composer =
		ComposerState { model: Some(model(vec![InputModality::Text])), ..ComposerState::default() };
	for index in 0..MAX_ATTACHMENTS {
		let item = Attachment::from_path(
			PathBuf::from(format!("/repo/{index}")),
			MediaType::Text,
			payload_for(MediaType::Text, b"text".to_vec()),
		);
		composer.admit(&item).expect("room in tray");
		composer.attach(item);
	}
	let item = attachment(MediaType::Text, b"another".to_vec());
	assert!(matches!(composer.admit(&item), Err(AttachmentError::TrayFull { .. })));
	let mut sent = composer.attachments.clone();
	sent.push(item);
	assert!(
		composer
			.submission_rejection_for(&sent)
			.expect("count refusal")
			.contains("more than")
	);
	let large = attachment(MediaType::Text, vec![b'a'; 20 * 1024 * 1024]);
	assert!(
		composer
			.submission_rejection_for(std::slice::from_ref(&large))
			.is_none()
	);
	assert!(
		composer
			.submission_rejection_for(&[large, attachment(MediaType::Text, vec![b'b'])])
			.expect("size refusal")
			.contains("total size")
	);
}

#[test]
fn direct_send_validates_its_payload_not_the_visible_tray() {
	let mut state = fixture::populated();
	let kept = attachment(MediaType::Text, b"keep these bytes".to_vec());
	state.composer.attach(kept.clone());
	render_session(state, Some("draft"), 1440, 900, |session| {
		session
			.update(|view, _window, cx| {
				let opaque = attachment(MediaType::Binary, vec![0, 255]);
				view.dispatch(Intent::Send { text: "draft".into(), attachments: vec![opaque] }, cx);
				assert!(view.pending().is_empty());
				assert!(
					view
						.composer_local()
						.notice
						.expect("visible refusal")
						.contains("not supported by the host")
				);
				assert_eq!(view.state().composer.attachments, vec![kept]);
				assert_eq!(view.composer().expect("editor").read(cx).text(), "draft");
			})
			.expect("direct send");
	});
}

#[test]
fn normal_submit_reports_model_refusal_and_removal_prevents_dispatching_the_file() {
	let mut state = fixture::populated();
	state.composer.model = Some(model(vec![InputModality::Text]));
	state
		.composer
		.attach(attachment(MediaType::Mp4, b"video bytes".to_vec()));
	render_session(state, Some("draft"), 1440, 900, |session| {
		session.update(|view, _window, cx| {
			view.submit_primary_turn_action(cx);
			assert!(view.pending().is_empty());
			assert!(view.composer_local().notice.expect("model refusal").contains("does not accept video"));
			assert_eq!(view.state().composer.attachments.len(), 1);
			view.dispatch(Intent::RemoveAttachment(0), cx);
			view.submit_primary_turn_action(cx);
			assert!(matches!(view.pending(), [Intent::Send { text, attachments }] if text == "draft" && attachments.is_empty()));
		}).expect("remove then submit");
	});
}

#[test]
fn failed_host_submission_preserves_text_payload_and_preview_for_retry() {
	let mut state = fixture::populated();
	let file = attachment(MediaType::Text, "UTF-8 payload λ".as_bytes().to_vec());
	state.composer.attach(file.clone());
	render_session(state, Some("draft"), 1440, 900, |session| {
		session.update(|view, _window, cx| {
			view.submit_primary_turn_action(cx);
			let intents = view.drain_intents();
			assert!(matches!(&intents[..], [Intent::Send { attachments, .. }] if attachments == &vec![file.clone()]));
			view.track_submission(RequestId(1), &intents[0]);
			assert_eq!(view.finish_submission(RequestId(1), false, cx), None);
			assert_eq!(view.state().composer.attachments, vec![file]);
			assert_eq!(view.composer().expect("editor").read(cx).text(), "draft");
		}).expect("failed request");
	});
}

#[test]
fn a_failed_read_stays_visible_when_the_same_batch_also_accepts_a_file() {
	let tree = scratch_dir("attachment-batch");
	let empty = tree.path().join("empty.txt");
	let valid = tree.path().join("valid.txt");
	std::fs::write(&empty, []).expect("empty fixture");
	std::fs::write(&valid, b"valid text").expect("text fixture");
	let results = [empty, valid]
		.into_iter()
		.map(|path| {
			read_media(&path).map(|(media, payload)| Attachment::from_path(path, media, payload))
		})
		.collect();
	render_session(fixture::populated(), None, 1440, 900, |session| {
		session
			.update(|view, _window, cx| {
				view.attach_results(results, cx);
				assert_eq!(view.state().composer.attachments.len(), 1);
				assert_eq!(view.state().composer.attachments[0].payload.bytes(), b"valid text");
				assert!(
					view
						.composer_local()
						.notice
						.expect("batch refusal")
						.contains("empty.txt")
				);
				assert!(view.pending().is_empty());
			})
			.expect("apply read results");
	});
}
