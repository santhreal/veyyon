//! The blocks a markdown document is read into (§8.25).
//!
//! One reader, so the renderer that draws a document, the span walk that
//! reports what a selection covers and the one-line summary a card draws all
//! read the same shapes out of the same source.
//!
//! A block is what the source states, not what a finished document would
//! state: an unclosed fence at the end of a stream is code, and a table
//! arrives one row at a time. What closes an unbalanced prefix before it is
//! read is `veyyon_desktop_model::text::markdown`.

/// One block of a Markdown document.
#[derive(Debug, PartialEq, Eq)]
pub enum MdBlock {
	Heading {
		level: u8,
		text:  String,
	},
	/// A list item: its own marker, and how deep the source indented it.
	Bullet {
		depth:  usize,
		marker: String,
		text:   String,
	},
	Quote(String),
	Paragraph(String),
	Code {
		lang:  String,
		lines: Vec<String>,
	},
	/// A pipe table: its header cells, what each column is set against, and
	/// the rows that have arrived. A row shorter than the header is the row
	/// the source states rather than a padded one.
	Table {
		head:  Vec<String>,
		align: Vec<CellAlign>,
		rows:  Vec<Vec<String>>,
	},
}

/// Which edge a table column's cells are set against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CellAlign {
	Start,
	Center,
	End,
}

/// The heading level a line opens with, and the text after it.
fn heading_of(line: &str) -> Option<(u8, &str)> {
	let hashes = line.bytes().take_while(|b| *b == b'#').count();
	if !(1..=6).contains(&hashes) {
		return None;
	}
	let rest = line.get(hashes..)?;
	let text = rest.strip_prefix(' ')?;
	Some((u8::try_from(hashes).ok()?, text.trim_start()))
}

/// The list marker a line opens with, and the text after it. An ordered item
/// keeps its own number, because renumbering it would state another order.
fn item_of(line: &str) -> Option<(String, &str)> {
	if let Some(text) = line
		.strip_prefix("- ")
		.or_else(|| line.strip_prefix("* "))
		.or_else(|| line.strip_prefix("+ "))
	{
		return Some(("•".to_owned(), text));
	}
	let digits = line.bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 || digits > 9 {
		return None;
	}
	let rest = line.get(digits..)?;
	let text = rest
		.strip_prefix(". ")
		.or_else(|| rest.strip_prefix(") "))?;
	Some((format!("{}.", &line[..digits]), text))
}

/// The cells one row of a table states, with the outer pipes off and each
/// cell trimmed. A line with no pipe in it is no row.
fn table_cells(line: &str) -> Option<Vec<String>> {
	let body = line.trim();
	if !body.contains('|') {
		return None;
	}
	let inner = body.strip_prefix('|').unwrap_or(body);
	let inner = inner.strip_suffix('|').unwrap_or(inner);
	Some(
		inner
			.split('|')
			.map(|cell| cell.trim().to_owned())
			.collect(),
	)
}

/// What each column of a delimiter row is set against, or none when the line
/// is not one: every cell has to be dashes, with a colon at either end or
/// both.
fn delimiter_row(line: &str) -> Option<Vec<CellAlign>> {
	let cells = table_cells(line)?;
	let mut out = Vec::with_capacity(cells.len());
	for cell in &cells {
		let dashes = cell.trim_start_matches(':').trim_end_matches(':');
		if dashes.is_empty() || !dashes.bytes().all(|byte| byte == b'-') {
			return None;
		}
		out.push(match (cell.starts_with(':'), cell.ends_with(':')) {
			(true, true) => CellAlign::Center,
			(false, true) => CellAlign::End,
			_ => CellAlign::Start,
		});
	}
	(!out.is_empty()).then_some(out)
}

/// The table that opens at `at`, and how many lines of the source it took.
///
/// A header row alone is no table, because a line of prose with a pipe in it
/// is not one either: the delimiter row under the header is what states that
/// the source means a grid.
fn table_at(lines: &[&str], at: usize) -> Option<(MdBlock, usize)> {
	let head = table_cells(lines.get(at).copied()?)?;
	let align = delimiter_row(lines.get(at + 1).copied()?)?;
	let mut rows = Vec::new();
	let mut next = at + 2;
	while let Some(line) = lines.get(next).copied() {
		let Some(cells) = table_cells(line) else {
			break;
		};
		rows.push(cells);
		next += 1;
	}
	Some((MdBlock::Table { head, align, rows }, next - at))
}

/// Reads `source` into blocks.
pub fn blocks(source: &str) -> Vec<MdBlock> {
	let lines: Vec<&str> = source.lines().collect();
	let mut out = Vec::new();
	let mut paragraph: Vec<&str> = Vec::new();
	let mut at = 0;

	let flush = |paragraph: &mut Vec<&str>, out: &mut Vec<MdBlock>| {
		if !paragraph.is_empty() {
			out.push(MdBlock::Paragraph(paragraph.join(" ")));
			paragraph.clear();
		}
	};

	while at < lines.len() {
		let line = lines[at];
		at += 1;
		let body = line.trim_start();
		let depth = (line.len() - body.len()) / 2;
		if let Some(lang) = body
			.strip_prefix("```")
			.or_else(|| body.strip_prefix("~~~"))
		{
			flush(&mut paragraph, &mut out);
			let mut fenced: Vec<String> = Vec::new();
			while let Some(inner) = lines.get(at).copied() {
				at += 1;
				if inner.trim_start().starts_with("```") || inner.trim_start().starts_with("~~~") {
					break;
				}
				fenced.push(inner.to_owned());
			}
			// An unclosed fence at the end of a streaming message is still code.
			out.push(MdBlock::Code { lang: lang.trim().to_owned(), lines: fenced });
		} else if let Some((level, text)) = heading_of(body) {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Heading { level, text: text.to_owned() });
		} else if let Some(text) = body.strip_prefix('>') {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Quote(text.trim_start().to_owned()));
		} else if let Some((marker, text)) = item_of(body) {
			flush(&mut paragraph, &mut out);
			out.push(MdBlock::Bullet { depth, marker, text: text.to_owned() });
		} else if let Some((table, took)) = table_at(&lines, at - 1) {
			flush(&mut paragraph, &mut out);
			out.push(table);
			at += took - 1;
		} else if body.is_empty() {
			flush(&mut paragraph, &mut out);
		} else {
			paragraph.push(body);
		}
	}
	flush(&mut paragraph, &mut out);
	out
}

#[cfg(test)]
mod tests {
	use super::{CellAlign, MdBlock, blocks};

	#[test]
	fn consecutive_lines_are_one_paragraph_and_a_blank_line_ends_it() {
		let read = blocks("one\ntwo\n\nthree");
		assert_eq!(read, [MdBlock::Paragraph("one two".into()), MdBlock::Paragraph("three".into())]);
	}

	#[test]
	fn a_heading_bullet_or_fence_ends_the_paragraph_before_it() {
		let read = blocks("a\n# H\nb\n- c\nd\n```rs\nx\n```\ne");
		assert_eq!(read, [
			MdBlock::Paragraph("a".into()),
			MdBlock::Heading { level: 1, text: "H".into() },
			MdBlock::Paragraph("b".into()),
			MdBlock::Bullet { depth: 0, marker: "•".into(), text: "c".into() },
			MdBlock::Paragraph("d".into()),
			MdBlock::Code { lang: "rs".into(), lines: vec!["x".into()] },
			MdBlock::Paragraph("e".into()),
		]);
	}

	#[test]
	fn an_unclosed_fence_is_still_code() {
		let read = blocks("```\nlet a = 1;");
		assert_eq!(read, [MdBlock::Code { lang: String::new(), lines: vec!["let a = 1;".into()] }]);
	}

	#[test]
	fn every_heading_level_is_a_heading_and_a_bare_hash_is_prose() {
		for level in 1..=6_u8 {
			let hashes = "#".repeat(usize::from(level));
			let read = blocks(&format!("{hashes} H"));
			assert_eq!(read, [MdBlock::Heading { level, text: "H".into() }], "{hashes} H");
		}
		assert_eq!(blocks("####### H"), [MdBlock::Paragraph("####### H".into())]);
		assert_eq!(blocks("#nothash"), [MdBlock::Paragraph("#nothash".into())]);
	}

	#[test]
	fn every_list_marker_is_an_item_and_an_ordered_one_keeps_its_number() {
		for marker in ["-", "*", "+"] {
			let read = blocks(&format!("{marker} item"));
			assert_eq!(read, [MdBlock::Bullet {
				depth:  0,
				marker: "•".into(),
				text:   "item".into(),
			}]);
		}
		assert_eq!(blocks("2. second\n3) third"), [
			MdBlock::Bullet { depth: 0, marker: "2.".into(), text: "second".into() },
			MdBlock::Bullet { depth: 0, marker: "3.".into(), text: "third".into() },
		]);
		assert_eq!(blocks("1.no space"), [MdBlock::Paragraph("1.no space".into())]);
	}

	#[test]
	fn an_indented_item_states_its_depth() {
		let read = blocks("- top\n  - under\n    - deeper");
		assert_eq!(read, [
			MdBlock::Bullet { depth: 0, marker: "•".into(), text: "top".into() },
			MdBlock::Bullet { depth: 1, marker: "•".into(), text: "under".into() },
			MdBlock::Bullet { depth: 2, marker: "•".into(), text: "deeper".into() },
		]);
	}

	#[test]
	fn a_quote_is_its_own_block_without_the_arrow() {
		assert_eq!(blocks("> said so"), [MdBlock::Quote("said so".into())]);
	}

	#[test]
	fn a_pipe_table_is_a_grid_set_the_way_its_delimiter_row_states() {
		let read = blocks("| left | mid | right |\n|:--|:-:|--:|\n| 1 | 2 | 3 |");
		assert_eq!(read, [MdBlock::Table {
			head:  vec!["left".into(), "mid".into(), "right".into()],
			align: vec![CellAlign::Start, CellAlign::Center, CellAlign::End],
			rows:  vec![vec!["1".into(), "2".into(), "3".into()]],
		}]);
	}

	#[test]
	fn a_delimiter_cell_with_no_colon_is_set_against_the_leading_edge() {
		let read = blocks("| a |\n| --- |");
		assert_eq!(read, [MdBlock::Table {
			head:  vec!["a".into()],
			align: vec![CellAlign::Start],
			rows:  Vec::new(),
		}]);
	}

	#[test]
	fn a_header_the_delimiter_row_has_not_reached_yet_is_prose() {
		// Mid-stream a header stands alone for a moment. Read as-is it is the
		// line it is, and what turns it into a grid before it is read is
		// `veyyon_desktop_model::text::markdown`.
		assert_eq!(blocks("| a | b |"), [MdBlock::Paragraph("| a | b |".into())]);
	}

	#[test]
	fn a_line_of_prose_with_a_pipe_in_it_is_no_table() {
		assert_eq!(blocks("pass a | b to it\nand read the rest"), [MdBlock::Paragraph(
			"pass a | b to it and read the rest".into()
		)]);
		assert_eq!(blocks("| a | b |\n| x | y |"), [MdBlock::Paragraph(
			"| a | b | | x | y |".into()
		)]);
	}

	#[test]
	fn a_row_shorter_than_the_header_keeps_the_cells_it_has() {
		let read = blocks("| a | b |\n|--|--|\n| 1 | 2 |\n| 3 |");
		assert_eq!(read, [MdBlock::Table {
			head:  vec!["a".into(), "b".into()],
			align: vec![CellAlign::Start, CellAlign::Start],
			rows:  vec![vec!["1".into(), "2".into()], vec!["3".into()]],
		}]);
	}

	#[test]
	fn a_blank_line_ends_the_grid_and_the_paragraph_before_it_is_kept() {
		let read = blocks("intro\n| a |\n|--|\n| 1 |\n\nafter");
		assert_eq!(read, [
			MdBlock::Paragraph("intro".into()),
			MdBlock::Table {
				head:  vec!["a".into()],
				align: vec![CellAlign::Start],
				rows:  vec![vec!["1".into()]],
			},
			MdBlock::Paragraph("after".into()),
		]);
	}

	#[test]
	fn a_pipe_inside_an_item_or_a_fence_is_not_a_grid() {
		assert_eq!(blocks("- a | b\n|--|--|"), [
			MdBlock::Bullet { depth: 0, marker: "\u{2022}".into(), text: "a | b".into() },
			MdBlock::Paragraph("|--|--|".into()),
		]);
		assert_eq!(blocks("```\n| a |\n|--|\n```"), [MdBlock::Code {
			lang:  String::new(),
			lines: vec!["| a |".into(), "|--|".into()],
		}]);
	}
}
