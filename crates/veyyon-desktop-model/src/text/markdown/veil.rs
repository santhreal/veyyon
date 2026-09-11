//! How much of an arriving document can no longer change shape.
//!
//! Every block but the last one is finished: the next delta can only extend
//! the block the text ends in, or start a new one after it. So the boundary
//! between what is settled and what is still moving is the first byte of the
//! last block, and a surface that draws the settled side as its own element
//! lays out the arriving block alone rather than the whole reply on every
//! delta.
//!
//! The boundary only ever moves forward as text arrives, which is what makes
//! it usable: text that settled stays settled, at the same offset.

/// Whether a line opens or closes a fence.
fn is_fence(line: &str) -> bool {
	let body = line.trim_start();
	body.starts_with("```") || body.starts_with("~~~")
}

/// Whether a line is a block that one line finishes: a heading, a quote or a
/// list item cannot grow by another line arriving, so it settles as soon as
/// its own newline does.
fn is_one_line_block(line: &str) -> bool {
	let body = line.trim_start();
	let hashes = body.bytes().take_while(|byte| *byte == b'#').count();
	if (1..=6).contains(&hashes) && body[hashes..].starts_with(' ') {
		return true;
	}
	if body.starts_with('>') {
		return true;
	}
	if ["- ", "* ", "+ "]
		.iter()
		.any(|marker| body.starts_with(marker))
	{
		return true;
	}
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	(1..=9).contains(&digits) && matches!(body.get(digits..digits + 2), Some(". ") | Some(") "))
}

/// The length of the prefix of `source` that can no longer change shape: the
/// first byte of the block the text ends in.
///
/// A line that has not ended yet is never settled, because its next character
/// can still turn it into another block. Neither is the paragraph or the
/// table it stands in, which the next line can still extend.
#[must_use]
pub fn settled_prefix_len(source: &str) -> usize {
	let mut settled = 0;
	let mut at = 0;
	let mut fenced = false;
	let mut growing = false;
	for line in source.split_inclusive('\n') {
		let end = at + line.len();
		let complete = line.ends_with('\n');
		let body = line.trim_end_matches('\n');
		if !complete {
			// The last line is still arriving, so the block it stands in is
			// wherever that block started.
			if !growing && !fenced {
				settled = at;
			}
			return settled;
		}
		if fenced {
			if is_fence(body) {
				fenced = false;
				settled = end;
			}
		} else if is_fence(body) {
			// A fence ends the paragraph above it, and opens a block that the
			// next line extends.
			settled = at;
			growing = false;
			fenced = true;
		} else if body.trim().is_empty() {
			growing = false;
			settled = end;
		} else if is_one_line_block(body) {
			growing = false;
			settled = end;
		} else {
			// A paragraph, a table or a row: the next line can extend it, so
			// the block stays open and the boundary stays before it.
			if !growing {
				settled = at;
			}
			growing = true;
		}
		at = end;
	}
	if fenced || growing { settled } else { at }
}
