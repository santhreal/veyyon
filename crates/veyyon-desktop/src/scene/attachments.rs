//! The composer holding what the next prompt carries (§5.4).
//!
//! The tray is window state rather than protocol state: the host is told about
//! an attachment when the prompt is submitted, so nothing in the store states
//! one and a scene of the tray sets it the way a scene of a draft sets the
//! draft. Two cards, because a card has two readings — the size of an image
//! the model takes, and the refusal for a clip it does not — and a tray of one
//! photographs whichever the fixture happened to pick.

use std::path::PathBuf;

use veyyon_desktop_model::{InputModality, ModelRef, ModelView, ModelsView, QueuePartition};
use veyyon_desktop_surface::{
	Attachment,
	composer::{MediaType, payload_for},
};

use crate::scene::seed::{Built, Seed};

/// A 1x1 truecolor PNG, encoded here rather than committed as a file: the
/// thumbnail decodes it for real and draws it as the card's square, so the
/// image path is exercised by the same bytes on every render.
const ONE_PIXEL_PNG: [u8; 69] = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
	0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x88, 0xea, 0x39, 0x01,
	0x00, 0x02, 0xf2, 0x01, 0xaf, 0xc5, 0xdb, 0x56, 0x9e, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
];

/// The clip's bytes. A card states a size and never decodes a video, so the
/// only thing the length has to be is the one the caption reads back.
const CLIP_LENGTH: usize = 4096;

/// The name the refused card carries: long enough that the refusal beside it
/// has to be cut to stay in the box, which is where a caption that could not
/// shrink drew past the card's ceiling.
const CLIP_NAME: &str = "a-recording-of-the-drawer-opening.mp4";

/// The composer with an image and a clip attached, under a model the catalogue
/// lists as taking text and images.
pub fn composer_attachments() -> Built {
	let mut seed = Seed::attached();
	seed.session(QueuePartition::Live);
	seed.store.domains.models = Some(ModelsView {
		models:          vec![ModelView {
			provider:       "anthropic".to_string(),
			id:             "claude-sonnet-4.5".to_string(),
			name:           "Claude Sonnet 4.5".to_string(),
			reasoning:      true,
			context_window: 200_000,
			max_output:     64_000,
			input:          vec![InputModality::Text, InputModality::Image],
		}],
		current:         Some(ModelRef {
			provider: "anthropic".to_string(),
			id:       "claude-sonnet-4.5".to_string(),
		}),
		thinking_level:  None,
		thinking_levels: Vec::new(),
	});
	let mut built = seed.finish();
	built.composer_text = "Describe what this frame shows.".to_string();
	built.state.composer.attachments = vec![
		Attachment::from_clipboard(
			1,
			MediaType::Png,
			payload_for(MediaType::Png, ONE_PIXEL_PNG.to_vec()),
		),
		Attachment::from_path(
			PathBuf::from(CLIP_NAME),
			MediaType::Mp4,
			payload_for(MediaType::Mp4, vec![0; CLIP_LENGTH]),
		),
	];
	built
}
