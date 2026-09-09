//! The markdown a plan arrives in, flattened to the plain lines the surfaces
//! draw.
//!
//! WHY: a plan crosses the wire as `markdown_plan`, written for a markdown
//! renderer, and every desktop surface draws its text verbatim. The plan card
//! drew `- **Cut** the tag` with the markers in it and the run bar drew the
//! plan's leading `#`, because there is no markdown renderer here. The markers
//! come off at the projection, in the one place both surfaces read.
//!
//! An approval's `detail` does NOT come through here: it arrives plain, and its
//! lines state the command about to run, so a backtick in one is the command's
//! own byte and stays.

/// A byte's fate when the line is rebuilt.
const KEEP: u8 = 0;
/// A marker byte: dropped.
const DROP: u8 = 1;
/// A marker byte that separates what it joined: emitted as one space.
const SPACE: u8 = 2;
/// A byte inside a code span: emitted, and no marker is read in it.
const LITERAL: u8 = 3;

/// The markdown's lines, flattened.
///
/// A fence line is dropped, since it delimits and says nothing; every other
/// line keeps its place, so a blank line still parts two paragraphs and an
/// indented item keeps its depth.
pub(super) fn plain_lines(markdown: &str) -> Vec<String> {
	markdown
		.lines()
		.filter(|line| !is_fence(line))
		.map(plain)
		.collect()
}

/// The first line with text on it, flattened, or empty when there is none.
pub(super) fn plain_line(markdown: &str) -> String {
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
	format!("{indent}{}", inline(&body))
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

/// The line without its inline markers: emphasis and code delimiters dropped,
/// a link left as its text and its target.
fn inline(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut fate = vec![KEEP; bytes.len()];
	mark_code_spans(bytes, &mut fate);
	mark_emphasis(bytes, &mut fate);
	mark_links(bytes, &mut fate);
	let mut out = String::with_capacity(text.len());
	for (at, ch) in text.char_indices() {
		match fate[at] {
			DROP => {},
			SPACE => out.push(' '),
			_ => out.push(ch),
		}
	}
	out
}

/// A pair of backticks, whose interior is literal and reads no further marker.
fn mark_code_spans(bytes: &[u8], fate: &mut [u8]) {
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] == b'`'
			&& let Some(close) = (at + 1..bytes.len()).find(|&j| bytes[j] == b'`')
		{
			fate[at] = DROP;
			fate[close] = DROP;
			for byte in &mut fate[at + 1..close] {
				*byte = LITERAL;
			}
			at = close + 1;
			continue;
		}
		at += 1;
	}
}

/// The `*` and `_` runs that open and close emphasis, and only those: a run
/// followed by a space opens nothing, and `_` inside a word is a name's own
/// byte, which is why `snake_case` survives.
fn mark_emphasis(bytes: &[u8], fate: &mut [u8]) {
	let mut at = 0;
	while at < bytes.len() {
		let delimiter = bytes[at];
		if fate[at] != KEEP || !matches!(delimiter, b'*' | b'_') {
			at += 1;
			continue;
		}
		let width = run_len(bytes, at, delimiter).min(2);
		let opens = bytes
			.get(at + width)
			.is_some_and(|b| !b.is_ascii_whitespace())
			&& !(delimiter == b'_' && at > 0 && bytes[at - 1].is_ascii_alphanumeric());
		if !opens {
			at += width;
			continue;
		}
		match closer(bytes, fate, at + width, delimiter, width) {
			Some(close) => {
				for byte in &mut fate[at..at + width] {
					*byte = DROP;
				}
				for byte in &mut fate[close..close + width] {
					*byte = DROP;
				}
				at += width;
			},
			None => at += width,
		}
	}
}

/// The closing run for an emphasis opener: `width` bytes of `delimiter`, with
/// text before it, not preceded by a space, and not inside a word for `_`.
fn closer(bytes: &[u8], fate: &[u8], from: usize, delimiter: u8, width: usize) -> Option<usize> {
	let mut at = from;
	while at < bytes.len() {
		if fate[at] == KEEP
			&& bytes[at] == delimiter
			&& at > from
			&& run_len(bytes, at, delimiter) >= width
			&& !bytes[at - 1].is_ascii_whitespace()
			&& !(delimiter == b'_' && bytes.get(at + width).is_some_and(u8::is_ascii_alphanumeric))
		{
			return Some(at);
		}
		at += 1;
	}
	None
}

/// The bytes of one run of `delimiter` starting at `at`.
fn run_len(bytes: &[u8], at: usize, delimiter: u8) -> usize {
	bytes[at..].iter().take_while(|b| **b == delimiter).count()
}

/// A `[text](target)` link, kept as `text (target)`: the brackets go, the
/// closing one leaving the space that parts the two.
fn mark_links(bytes: &[u8], fate: &mut [u8]) {
	let mut at = 0;
	while at < bytes.len() {
		if fate[at] != KEEP || bytes[at] != b'[' {
			at += 1;
			continue;
		}
		let Some(close) = (at + 1..bytes.len()).find(|&j| fate[j] == KEEP && bytes[j] == b']') else {
			at += 1;
			continue;
		};
		if bytes.get(close + 1) != Some(&b'(') || !(close + 2..bytes.len()).any(|j| bytes[j] == b')')
		{
			at = close + 1;
			continue;
		}
		fate[at] = DROP;
		fate[close] = SPACE;
		if at > 0 && bytes[at - 1] == b'!' && fate[at - 1] == KEEP {
			fate[at - 1] = DROP;
		}
		at = close + 1;
	}
}
