//! What a message's text is made of.
//!
//! A transcript prints prose, fenced code and patches, and the three are read
//! differently: prose has emphasis and lists, code has strings and keywords,
//! a patch has files and hunks and line numbers. Each of the three is a parser
//! here, total over arbitrary input, and each returns byte offsets into the
//! exact string it was handed so a renderer can style runs of it without
//! copying.
//!
//! No rendering here. A renderer for each of these lives in the features crate,
//! one file per block kind.

pub mod diff;
pub mod markdown;
pub mod syntax;

/// One line of text, cut to `max` characters at a word boundary.
///
/// A title and a row's second line are both one line of somebody's prose held
/// to a length. Neither is cut mid-word, because a word broken in half reads as
/// a rendering defect rather than as an elision, and neither is cut with an
/// ellipsis, because the element that draws it shortens to the width it has.
///
/// A single word longer than `max` is cut by character, since there is no
/// boundary to find.
pub fn clip(line: &str, max: usize) -> String {
	let line = line.trim();
	if line.chars().count() <= max {
		return line.to_owned();
	}
	let mut cut = String::new();
	for word in line.split_whitespace() {
		if cut.chars().count() + word.chars().count() + 1 > max {
			break;
		}
		if !cut.is_empty() {
			cut.push(' ');
		}
		cut.push_str(word);
	}
	if cut.is_empty() {
		cut.extend(line.chars().take(max));
	}
	cut
}

/// One line cut to `max` characters, with a mark where it was cut.
///
/// For the text nothing else shortens. A notice is a sentence in a bar as wide
/// as the window, so a cut with no mark reads as a sentence that stopped rather
/// than as a name held to a length. A row uses [`clip`] instead, because its
/// element shortens further and two marks in one line is one too many.
pub fn elided(line: &str, max: usize) -> String {
	let cut = clip(line, max);
	if cut.chars().count() < line.trim().chars().count() {
		return format!("{cut}\u{2026}");
	}
	cut
}
