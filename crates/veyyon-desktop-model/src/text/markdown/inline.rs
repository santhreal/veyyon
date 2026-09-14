//! Repairs for inline syntax in the final arriving line.

use super::mend::{Open, OpenShape};

fn run_len(bytes: &[u8], at: usize, delimiter: u8) -> usize {
	bytes[at..]
		.iter()
		.take_while(|byte| **byte == delimiter)
		.count()
}

fn opens_emphasis(bytes: &[u8], at: usize, delimiter: u8, width: usize) -> bool {
	bytes
		.get(at + width)
		.is_some_and(|byte| !byte.is_ascii_whitespace())
		&& !(delimiter == b'_' && at > 0 && bytes[at - 1].is_ascii_alphanumeric())
}

fn emphasis_close(
	bytes: &[u8],
	reserved: &[bool],
	from: usize,
	delimiter: u8,
	width: usize,
) -> Option<usize> {
	(from + 1..bytes.len()).find(|&at| {
		!reserved[at]
			&& bytes[at] == delimiter
			&& run_len(bytes, at, delimiter) >= width
			&& !bytes[at - 1].is_ascii_whitespace()
			&& !(delimiter == b'_' && bytes.get(at + width).is_some_and(u8::is_ascii_alphanumeric))
	})
}

/// Code span contents remain literal, including an unfinished span's tail.
fn code_spans(bytes: &[u8], line: &str) -> (Vec<bool>, Option<usize>) {
	let mut literal = vec![false; bytes.len()];
	let mut at = 0;
	while at < bytes.len() {
		if bytes[at] != b'`' {
			at += 1;
			continue;
		}
		if let Some(found) = line[at + 1..].find('`') {
			let close = at + 1 + found;
			literal[at..=close].fill(true);
			at = close + 1;
		} else {
			literal[at..].fill(true);
			return (literal, Some(at));
		}
	}
	(literal, None)
}

fn link_open(bytes: &[u8], at: usize) -> Result<usize, OpenShape> {
	let Some(close) = (at + 1..bytes.len()).find(|held| bytes[*held] == b']') else {
		return Ok(at + 1);
	};
	if bytes.get(close + 1) != Some(&b'(') {
		return Ok(close + 1);
	}
	match (close + 2..bytes.len()).find(|held| bytes[*held] == b')') {
		Some(end) => Ok(end + 1),
		None => Err(OpenShape::LinkTarget),
	}
}

struct Mark {
	shape: OpenShape,
	byte:  u8,
	width: usize,
}

/// Apply a partial closing run to the innermost matching emphasis.
fn pay_with_run(open: &mut Vec<Mark>, mark: u8, mut run: usize) -> usize {
	while run > 0 {
		match open.last() {
			Some(held) if held.byte == mark && held.width <= run => {
				run -= held.width;
				open.pop();
			},
			Some(held) if held.byte == mark => return run,
			_ => return 0,
		}
	}
	0
}

pub(super) fn inline_open(line: &str, arriving: bool) -> Vec<Open> {
	let bytes = line.as_bytes();
	let (mut reserved, span) = code_spans(bytes, line);
	let mut marks: Vec<Mark> = Vec::new();
	let mut links: Option<OpenShape> = None;
	let mut written = 0;
	let mut empty = bytes.last().is_some_and(u8::is_ascii_whitespace);
	let mut at = 0;
	while at < bytes.len() {
		if reserved[at] {
			at += 1;
			continue;
		}
		match bytes[at] {
			mark @ (b'*' | b'_') => {
				let run = run_len(bytes, at, mark);
				if at + run == bytes.len() {
					if arriving && (at == 0 || bytes[at - 1].is_ascii_whitespace()) {
						empty = true;
						marks.push(Mark {
							shape: if run == 1 {
								OpenShape::Emphasis
							} else {
								OpenShape::Strong
							},
							byte:  mark,
							width: run,
						});
					} else {
						written = pay_with_run(&mut marks, mark, run);
					}
					break;
				}
				let width = run.min(2);
				if opens_emphasis(bytes, at, mark, width) {
					if let Some(close) = emphasis_close(bytes, &reserved, at + width, mark, width) {
						// A closer already used by nested emphasis cannot also
						// complete an outer run that is still arriving.
						reserved[close..close + width].fill(true);
					} else {
						let shape = if width == 2 {
							OpenShape::Strong
						} else {
							OpenShape::Emphasis
						};
						marks.push(Mark { shape, byte: mark, width });
					}
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
	let mut open = Vec::new();
	if let Some(start) = span {
		let closer = if start + 1 == bytes.len() {
			"\u{200b}`"
		} else {
			"`"
		};
		open.push(Open { shape: OpenShape::CodeSpan, closer: closer.to_owned() });
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
		let mut closer = String::with_capacity(owed + 3);
		// Empty pairs and closers after whitespace are literal Markdown.
		// Zero-width content makes this display-only repair a styled span.
		if at == 0 && empty {
			closer.push('\u{200b}');
		}
		closer.extend(std::iter::repeat_n(char::from(held.byte), owed));
		open.push(Open { shape: held.shape, closer });
	}
	open
}
