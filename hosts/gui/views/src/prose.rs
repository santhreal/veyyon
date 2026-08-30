//! Prose: markdown, and a remark with a verdict.

use gpui::{App, Div, IntoElement, ParentElement, Styled};
use veyyon_gui_contract::view::{Markdown, Note};
use veyyon_gui_kit::{
	chrome::{column, row},
	text::{body, text_in},
	tokens::{space, text as sizes},
};
use veyyon_gui_theme::Role;

use crate::tone;

/// Markdown, drawn without a parser.
///
/// No markdown parser is available here and none is being added for this. Blank
/// lines separate paragraphs and a leading `- ` draws as a bullet; every other
/// construct — emphasis, headings, links, fenced code, tables — draws as its
/// source text. Parsing belongs to the host, and the host that does it will
/// replace this function rather than extend it.
pub fn markdown(value: &Markdown, cx: &App) -> Div {
	column(space::SNUG).children(blocks(&value.source).into_iter().map(|block| match block {
		Block::Paragraph(text) => body(text, cx).into_any_element(),
		Block::Bullet(text) => bullet(text, cx).into_any_element(),
	}))
}

/// One bullet: the marker in the theme's bullet role, then the text.
fn bullet(text: String, cx: &App) -> Div {
	row(space::SNUG)
		.items_start()
		.child(text_in("•", Role::MdBullet, sizes::BODY, cx))
		.child(body(text, cx))
}

/// What [`markdown`] draws, one element each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
	Paragraph(String),
	Bullet(String),
}

/// The source split into blocks.
///
/// Separate from the drawing so the split is asserted without a window. A
/// paragraph that swallows the bullet after it is the failure this prevents,
/// and it looks like prose the model wrote that way.
pub fn blocks(source: &str) -> Vec<Block> {
	let mut out: Vec<Block> = Vec::new();
	let mut paragraph: Vec<&str> = Vec::new();

	let flush = |paragraph: &mut Vec<&str>, out: &mut Vec<Block>| {
		if !paragraph.is_empty() {
			out.push(Block::Paragraph(paragraph.join(" ")));
			paragraph.clear();
		}
	};

	for line in source.lines() {
		let trimmed = line.trim();
		if trimmed.is_empty() {
			flush(&mut paragraph, &mut out);
		} else if let Some(item) = bullet_text(trimmed) {
			flush(&mut paragraph, &mut out);
			out.push(Block::Bullet(item.to_owned()));
		} else {
			paragraph.push(trimmed);
		}
	}
	flush(&mut paragraph, &mut out);
	out
}

/// The text of a bullet line, or `None` when the line is not one.
///
/// Both `- ` and `* ` count. A bare `-` with nothing after it is not a bullet:
/// it is a line of prose that happens to be a dash, and drawing it as an empty
/// bullet loses the character.
fn bullet_text(line: &str) -> Option<&str> {
	let rest = line
		.strip_prefix("- ")
		.or_else(|| line.strip_prefix("* "))?;
	let rest = rest.trim();
	(!rest.is_empty()).then_some(rest)
}

pub fn note(value: &Note, cx: &App) -> Div {
	let role = tone::role(value.tone);
	row(space::SNUG)
		.items_start()
		.child(text_in(tone::marker(value.tone), role, sizes::BODY, cx))
		.child(text_in(value.text.clone(), role, sizes::BODY, cx))
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! The block split is the whole of the markdown handling, and its failure is
	//! a paragraph that absorbs the list under it: the text is all present, so
	//! nothing looks missing, and a four-item list reads as one sentence. The
	//! bullet test is a prefix match, which is the kind that fires on a line of
	//! prose starting with a dash.
	//!
	//! WHAT IT DOES NOT CATCH. Every markdown construct that is not a paragraph
	//! or a bullet. Those draw as source text by design, and this suite asserts
	//! that rather than pretending otherwise.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_blank_line_ends_a_paragraph() {
		let split = blocks("one\ntwo\n\nthree");
		assert_eq!(split, vec![
			Block::Paragraph("one two".to_owned()),
			Block::Paragraph("three".to_owned()),
		]);
	}

	#[test]
	fn a_bullet_ends_the_paragraph_above_it_without_a_blank_line() {
		let split = blocks("Reasons:\n- first\n- second");
		assert_eq!(split, vec![
			Block::Paragraph("Reasons:".to_owned()),
			Block::Bullet("first".to_owned()),
			Block::Bullet("second".to_owned()),
		]);
	}

	#[test]
	fn a_line_of_prose_starting_with_a_dash_is_not_a_bullet() {
		assert_eq!(blocks("-3 degrees"), vec![Block::Paragraph("-3 degrees".to_owned())]);
		assert_eq!(blocks("-"), vec![Block::Paragraph("-".to_owned())]);
		assert_eq!(blocks("- "), vec![Block::Paragraph("-".to_owned())]);
	}

	#[test]
	fn an_unparsed_construct_survives_as_its_source_text() {
		let split = blocks("## Heading\n\n`code`");
		assert_eq!(split, vec![
			Block::Paragraph("## Heading".to_owned()),
			Block::Paragraph("`code`".to_owned()),
		]);
	}

	#[test]
	fn the_fixture_splits_into_a_paragraph_and_its_bullets() {
		let split = blocks(&fixtures::views::markdown().source);
		assert_eq!(
			split
				.iter()
				.filter(|block| matches!(block, Block::Bullet(_)))
				.count(),
			2
		);
		assert!(
			split
				.iter()
				.any(|block| matches!(block, Block::Paragraph(_)))
		);
	}

	#[test]
	fn empty_source_draws_nothing_rather_than_an_empty_paragraph() {
		assert_eq!(blocks(""), Vec::new());
		assert_eq!(blocks("\n\n  \n"), Vec::new());
	}
}
