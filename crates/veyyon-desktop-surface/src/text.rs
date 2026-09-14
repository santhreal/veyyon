//! The markdown a decision arrives in, flattened to the plain lines a card
//! draws.
//!
//! WHY: a plan crosses the wire as `markdown_plan`, written for a markdown
//! renderer, and a card draws one line per row. The plan card drew
//! `- **Cut** the tag` with the markers in it and the run bar drew the plan's
//! leading `#`. The markers come off at the projection, in the one place both
//! surfaces read.
//!
//! The inline markers are read by [`veyyon_desktop_kit::text::inline`], the one
//! reader on this surface: the transcript sets those markers rather than
//! dropping them, and a second copy of the rules here would drift from what the
//! transcript draws. This module handles what is line-shaped -- the fence, the
//! indent, the block marker at the front -- because a card draws a line and not
//! a document.
//!
//! An approval's `detail` does NOT come through here: it arrives plain, and its
//! lines state the command about to run, so a backtick in one is the command's
//! own byte and stays.

use veyyon_desktop_kit::text::inline;

/// The markdown's lines, flattened.
///
/// A fence line is dropped, since it delimits and says nothing; every other
/// line keeps its place, so a blank line still parts two paragraphs and an
/// indented item keeps its depth.
#[must_use]
pub fn plain_lines(markdown: &str) -> Vec<String> {
	markdown
		.lines()
		.filter(|line| !is_fence(line))
		.map(plain)
		.collect()
}

/// The first line with text on it, flattened, or empty when there is none.
#[must_use]
pub fn plain_line(markdown: &str) -> String {
	markdown
		.lines()
		.filter(|line| !is_fence(line))
		.map(plain)
		.find(|line| !line.trim().is_empty())
		.unwrap_or_default()
}

/// A fence opening or closing a code block, which is a delimiter and no text.
fn is_fence(line: &str) -> bool {
	let trimmed = line.trim_start();
	trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

/// One line, with the block markers off its front and the inline markers out
/// of its middle. The indent survives, because it states list depth.
fn plain(line: &str) -> String {
	let body = line.trim_end();
	let indent = &body[..body.len() - body.trim_start().len()];
	let body = strip_block_markers(body.trim_start());
	format!("{indent}{}", inline::plain(&body))
}

/// The blockquote arrows, the heading hashes and a `*`/`+` bullet, which is
/// normalized to `-` so it cannot read as emphasis.
fn strip_block_markers(line: &str) -> String {
	let mut body = line;
	while let Some(rest) = body.strip_prefix('>') {
		body = rest.trim_start();
	}
	let hashes = body.bytes().take_while(|b| *b == b'#').count();
	if (1..=6).contains(&hashes) {
		let rest = &body[hashes..];
		if rest.is_empty() || rest.starts_with(' ') {
			body = rest.trim_start();
		}
	}
	let bulleted =
		matches!(body.as_bytes().first(), Some(b'*' | b'+')) && body.as_bytes().get(1) == Some(&b' ');
	if bulleted {
		format!("- {}", &body[2..])
	} else {
		body.to_owned()
	}
}
