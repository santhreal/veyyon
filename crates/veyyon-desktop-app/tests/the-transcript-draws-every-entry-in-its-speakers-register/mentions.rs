//! A file the prompt named is drawn on the prompt that named it: the file,
//! its picture when the host read one, and no bubble for words never written.
//!
//! WHY: the prompt's plan put its words in a bubble unconditionally, so a
//! prompt of files alone drew an empty bubble; a named file's picture was
//! dropped because only an attached image was decoded, so the picture's
//! fallback words drew the file name a second time.
//!
//! Gap: the picture's pixels are not read; it is proven drawn by the
//! fallback words that are absent.

use gpui::TestAppContext;
use veyyon_desktop_app::transcript::plan::Piece;
use veyyon_desktop_model::{ContentBlock, MessageRole};

use super::{bitmap, entry, opened, text, thread};

fn mention(path: &str, image: Option<Vec<u8>>) -> ContentBlock {
	ContentBlock::FileMention {
		path: path.to_owned(),
		has_content: true,
		lines: Some(3),
		bytes: None,
		unavailable_reason: None,
		image,
	}
}

#[gpui::test]
fn a_prompt_that_wrote_no_words_draws_the_files_it_named_and_no_bubble(cx: &mut TestAppContext) {
	let cases = [vec![mention("notes.md", None)], vec![text(""), mention("notes.md", None)]];
	for content in cases {
		let mut thread = thread(cx, opened(vec![entry("u", None, MessageRole::User, content)]));
		let pieces = thread.plan(0).pieces;
		assert!(
			!pieces.iter().any(|piece| matches!(piece, Piece::Bubble(_))),
			"no words, no bubble: {pieces:?}"
		);
		assert!(
			pieces
				.iter()
				.any(|piece| matches!(piece, Piece::File { path, .. } if path == "notes.md")),
			"the file is drawn on the prompt that named it: {pieces:?}"
		);
		assert_eq!(thread.drew_times("notes.md"), 1);
	}
}

#[gpui::test]
fn a_named_picture_draws_the_picture_and_its_name_once(cx: &mut TestAppContext) {
	let content = vec![text("look at this"), mention("shot.bmp", Some(bitmap(64, 48)))];
	let mut thread = thread(cx, opened(vec![entry("u", None, MessageRole::User, content)]));
	let pieces = thread.plan(0).pieces;
	assert!(
		pieces
			.iter()
			.any(|piece| matches!(piece, Piece::Image { block: 1, .. })),
		"the picture the host read is a piece of the prompt: {pieces:?}"
	);
	assert!(thread.drew("look at this"));
	assert_eq!(
		thread.drew_times("shot.bmp"),
		1,
		"the name is drawn once, by the file; the picture decoded, so its fallback words are not"
	);
}
