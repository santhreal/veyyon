//! What an arriving prefix left open, and the text that closes it.
//!
//! Every shape a prefix can leave open is a variant of [`OpenShape`], so the
//! set is enumerable at run time and a shape added without a repair for it
//! does not compile where the repairs are stated.
//!
//! The rules for what counts as a marker are the rules the drawing kit reads
//! prose by: a run followed by a space opens nothing, `_` inside a word is a
//! name's own byte, a code span's interior is literal, and a link is a link
//! only once its target closes. A prefix is mended so it reads as the shape
//! it is becoming, never so it reads as a shape nobody wrote.

/// A markdown shape a prefix of a document left open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OpenShape {
	/// A fenced code block with no closing fence.
	Fence,
	/// A table header with no delimiter row under it yet.
	Table,
	/// A list marker whose text has not arrived: `-`, `*`, `+`, `2.`.
	Item,
	/// The hashes of a heading whose text has not arrived.
	Heading,
	/// A code span with one backtick.
	CodeSpan,
	/// `**` or `__` with no closing pair.
	Strong,
	/// `*` or `_` with no closing mark.
	Emphasis,
	/// A link target that has not closed: `[the plan](docs/pl`.
	///
	/// A label with no bracket yet is not here: the kit draws `[a label]`
	/// alone as the text it is, and a target nobody has written would be
	/// drawn beside the label as invented text.
	LinkTarget,
}

impl OpenShape {
	/// Every shape a prefix can leave open.
	#[must_use]
	pub const fn all() -> [Self; 8] {
		[
			Self::Fence,
			Self::Table,
			Self::Item,
			Self::Heading,
			Self::CodeSpan,
			Self::Strong,
			Self::Emphasis,
			Self::LinkTarget,
		]
	}
}

/// One shape a prefix left open, and the text that closes it.
///
/// The closer is text rather than a constant of the shape, because an
/// emphasis closes in the mark that opened it and a stream caught mid-closer
/// needs only the rest of it.
struct Open {
	shape:  OpenShape,
	closer: String,
}

/// Whether a line opens or closes a fence.
fn is_fence(line: &str) -> bool {
	let body = line.trim_start();
	body.starts_with("```") || body.starts_with("~~~")
}

/// Whether a line could be a row of a table: it opens with a pipe and states
/// at least one cell. A line of prose with a pipe in the middle is no row,
/// because a grid nobody wrote reads worse than a paragraph.
fn is_row(line: &str) -> bool {
	let body = line.trim();
	body.starts_with('|') && body.len() > 1
}

/// Whether a line states what each column of a table is set against.
fn is_delimiter(line: &str) -> bool {
	let body = line.trim();
	let inner = body.strip_prefix('|').unwrap_or(body);
	let inner = inner.strip_suffix('|').unwrap_or(inner);
	let mut cells = 0;
	for cell in inner.split('|') {
		let dashes = cell.trim().trim_start_matches(':').trim_end_matches(':');
		if dashes.is_empty() || !dashes.bytes().all(|byte| byte == b'-') {
			return false;
		}
		cells += 1;
	}
	cells > 0
}

/// Whether a line is a list marker and nothing else. The trailing space a
/// mend adds is what makes the marker an item, so only what precedes the
/// marker is ignored here.
fn is_bare_marker(line: &str) -> bool {
	let body = line.trim_start();
	if matches!(body, "-" | "*" | "+") {
		return true;
	}
	let digits = body.bytes().take_while(u8::is_ascii_digit).count();
	(1..=9).contains(&digits) && matches!(body.get(digits..), Some(".") | Some(")"))
}

/// Whether a line is the hashes of a heading and nothing else.
fn is_bare_hashes(line: &str) -> bool {
	let body = line.trim_start();
	let hashes = body.bytes().take_while(|byte| *byte == b'#').count();
	(1..=6).contains(&hashes) && hashes == body.len()
}

/// The bytes of one run of `delimiter` at `at`.
fn run_len(bytes: &[u8], at: usize, delimiter: u8) -> usize {
	bytes[at..]
		.iter()
		.take_while(|byte| **byte == delimiter)
		.count()
}

/// Whether an emphasis run of `width` bytes of `delimiter` at `at` opens:
/// text follows it, and `_` is not inside a word.
fn opens_emphasis(bytes: &[u8], at: usize, delimiter: u8, width: usize) -> bool {
	bytes
		.get(at + width)
		.is_some_and(|byte| !byte.is_ascii_whitespace())
		&& !(delimiter == b'_' && at > 0 && bytes[at - 1].is_ascii_alphanumeric())
}

/// Whether a closing run for that opener exists after `from`: `width` bytes
/// of `delimiter`, with text before it, outside a code span, and not inside a
/// word for `_`.
fn closes_emphasis(
	bytes: &[u8],
	literal: &[bool],
	from: usize,
	delimiter: u8,
	width: usize,
) -> bool {
	(from + 1..bytes.len()).any(|at| {
		!literal[at]
			&& bytes[at] == delimiter
			&& run_len(bytes, at, delimiter) >= width
			&& !bytes[at - 1].is_ascii_whitespace()
			&& !(delimiter == b'_' && bytes.get(at + width).is_some_and(u8::is_ascii_alphanumeric))
	})
}

/// Where each byte of a line is inside a code span, and where a code span was
/// left open. Everything after an unclosed backtick is literal.
fn code_spans(bytes: &[u8], line: &str) -> (Vec<bool>, Option<usize>) {
	let mut literal = vec![false; bytes.len()];
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] != b'`' {
			at += 1;
			continue;
		}
		match line[at + 1..].find('`') {
			Some(found) => {
				let close = at + 1 + found;
				for held in &mut literal[at..=close] {
					*held = true;
				}
				at = close + 1;
			},
			None => {
				for held in &mut literal[at..] {
					*held = true;
				}
				return (literal, Some(at));
			},
		}
	}
	(literal, None)
}

/// Whether the link opening at `at` closed, and what it left open when it did
/// not: a label with no `]`, or a target with no `)`.
fn link_open(bytes: &[u8], at: usize) -> Result<usize, OpenShape> {
	let Some(close) = (at + 1..bytes.len()).find(|held| bytes[*held] == b']') else {
		// A bracket nobody closed is a bracket: the walk steps over it and
		// reads whatever markers follow.
		return Ok(at + 1);
	};
	if bytes.get(close + 1) != Some(&b'(') {
		// A label alone is the text it is, which is what the kit draws for
		// `[not a link]`: no target is guessed for it.
		return Ok(close + 1);
	}
	match (close + 2..bytes.len()).find(|held| bytes[*held] == b')') {
		Some(end) => Ok(end + 1),
		None => Err(OpenShape::LinkTarget),
	}
}

/// One emphasis still open: its shape, the mark it opened in, and how many of
/// that mark close it.
struct Mark {
	shape: OpenShape,
	mark:  u8,
	width: usize,
}

/// Closes what a run of `mark` at the end of the line can close, innermost
/// first, and reports how many marks of the innermost shape still open were
/// already written.
///
/// A stream caught between the two marks of `**` has written one of them: the
/// repair is the other one, not both.
fn pay_with_run(open: &mut Vec<Mark>, mark: u8, mut run: usize) -> usize {
	while run > 0 {
		match open.last() {
			Some(held) if held.mark == mark && held.width <= run => {
				run -= held.width;
				open.pop();
			},
			Some(held) if held.mark == mark => return run,
			_ => return 0,
		}
	}
	0
}

/// The inline shapes the tail line left open, innermost first, each with the
/// text that closes it.
fn inline_open(line: &str) -> Vec<Open> {
	let bytes = line.as_bytes();
	let (literal, span) = code_spans(bytes, line);
	let mut marks: Vec<Mark> = Vec::new();
	let mut links: Option<OpenShape> = None;
	let mut written = 0;
	let mut at = 0;
	while at < bytes.len() {
		if literal[at] {
			// A closed span's interior reads no marker, and an unclosed one
			// makes every byte after it literal, so one map answers both and
			// the walk steps over them.
			at += 1;
			continue;
		}
		match bytes[at] {
			mark @ (b'*' | b'_') => {
				let run = run_len(bytes, at, mark);
				if at + run == bytes.len() {
					// A run the line ends on opens nothing: it is the closer
					// the stream is in the middle of writing.
					written = pay_with_run(&mut marks, mark, run);
					break;
				}
				let width = run.min(2);
				if opens_emphasis(bytes, at, mark, width)
					&& !closes_emphasis(bytes, &literal, at + width, mark, width)
				{
					let shape = if width == 2 {
						OpenShape::Strong
					} else {
						OpenShape::Emphasis
					};
					marks.push(Mark { shape, mark, width });
				}
				at += width;
			},
			b'[' => match link_open(bytes, at) {
				Ok(past) => at = past,
				Err(shape) => {
					links = Some(shape);
					break;
				},
			},
			_ => at += 1,
		}
	}
	let mut open: Vec<Open> = Vec::new();
	if span.is_some() {
		open.push(Open { shape: OpenShape::CodeSpan, closer: "`".to_owned() });
	}
	if let Some(shape) = links {
		open.push(Open { shape, closer: ")".to_owned() });
	}
	for (at, held) in marks.iter().rev().enumerate() {
		let owed = if at == 0 {
			held.width - written
		} else {
			held.width
		};
		open.push(Open {
			shape:  held.shape,
			closer: String::from_utf8(vec![held.mark; owed]).unwrap_or_default(),
		});
	}
	open
}

/// Which line of `lines` is the header of a table whose delimiter row has not
/// arrived, or none when the source leaves no table open.
fn open_table(lines: &[&str]) -> Option<usize> {
	let mut first = lines.len();
	while first > 0 && is_row(lines[first - 1]) {
		first -= 1;
	}
	if first == lines.len() || lines[first..].iter().copied().any(is_delimiter) {
		return None;
	}
	Some(first)
}

/// Every shape `source` leaves open, innermost first, each with the text that
/// closes it.
///
/// An open fence is the whole answer: its interior is literal, so nothing
/// inside it opens a table, a heading or an emphasis.
fn open_repairs(source: &str) -> Vec<Open> {
	let lines: Vec<&str> = source.lines().collect();
	if lines.iter().copied().filter(|line| is_fence(line)).count() % 2 == 1 {
		return vec![Open { shape: OpenShape::Fence, closer: "\n```".to_owned() }];
	}
	let mut open = Vec::new();
	let tail = lines.last().copied().unwrap_or_default();
	if is_bare_marker(tail) {
		open.push(Open { shape: OpenShape::Item, closer: " ".to_owned() });
	} else if is_bare_hashes(tail) {
		open.push(Open { shape: OpenShape::Heading, closer: " ".to_owned() });
	} else if !is_fence(tail) {
		open.extend(inline_open(tail));
	}
	if open_table(&lines).is_some() {
		// The delimiter row is not an append, so the table carries no closer:
		// the mend writes it under the header it belongs to.
		open.push(Open { shape: OpenShape::Table, closer: String::new() });
	}
	open
}

/// Every shape `source` leaves open, in the order [`mend`] closes them.
#[must_use]
pub fn open_shapes(source: &str) -> Vec<OpenShape> {
	open_repairs(source)
		.into_iter()
		.map(|open| open.shape)
		.collect()
}

/// `source` with every shape it left open closed, so it reads as the document
/// it is becoming rather than as the prefix it is.
///
/// Only text is added. The source's own bytes are all present, in order, so a
/// character that arrived is never dropped by being drawn mid-arrival.
#[must_use]
pub fn mend(source: &str) -> String {
	let open = open_repairs(source);
	if open.is_empty() {
		return source.to_owned();
	}
	let lines: Vec<&str> = source.lines().collect();
	let mut mended = String::with_capacity(source.len() + 16);
	let table = open
		.iter()
		.any(|held| held.shape == OpenShape::Table)
		.then(|| open_table(&lines))
		.flatten();
	match table {
		// The delimiter row states the shape of the columns above the rows, so
		// it goes under the header rather than after whatever has arrived.
		Some(header) => {
			let cells = lines[header].trim().trim_matches('|').split('|').count();
			for (at, line) in source.split_inclusive('\n').enumerate() {
				mended.push_str(line);
				if at == header {
					if !line.ends_with('\n') {
						mended.push('\n');
					}
					mended.push('|');
					for _ in 0..cells {
						mended.push_str("---|");
					}
					mended.push('\n');
				}
			}
		},
		None => mended.push_str(source),
	}
	for held in open {
		mended.push_str(&held.closer);
	}
	mended
}
