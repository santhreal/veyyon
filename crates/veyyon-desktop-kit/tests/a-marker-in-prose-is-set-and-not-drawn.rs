//! WHY: the block reader drew a paragraph as one run of raw source, so every
//! agent reply the transcript drew carried its own markers -- `**Cut** the tag`
//! kept the asterisks, `` `read` `` kept the backticks and
//! `[the plan](docs/plan.md)` kept the brackets. The defect was the whole class
//! of inline markers, not one of them, so this suite sweeps the marker set the
//! reader claims and asserts each marker is off the frame and its meaning is
//! on it.
//!
//! The class this closes: a marker that reaches the frame as a glyph, and a
//! marker that is read where markdown reads none (`snake_case`, `2 * 3`, an
//! unpaired delimiter, anything inside a code span).
//!
//! What this does NOT catch: how the emphasis looks. A weight, a colour and an
//! underline are asserted as the style the span carries, not as pixels, and a
//! theme that resolves accent to the foreground colour would still pass.
//! Reference tables, links that click, and images are not read at all.

mod common;

use common::{headless_context, render_frame};
use veyyon_desktop_kit::{
	ColorRole, TextRamp, TokenSet,
	text::{
		Markdown,
		inline::{Emphasis, plain, span_style, spans},
	},
};
use veyyon_gpui::{
	Context, FontStyle, FontWeight, HighlightStyle, IntoElement, Render, Window, div, prelude::*,
	px, size,
};

/// Every marker the reader claims, the source that carries it, and the text
/// the frame must draw for it. The set is the reader's whole surface: a marker
/// added without a row here leaves the row list below unbalanced, and the
/// sweep asserts the count it read.
const MARKERS: &[(&str, &str, &str)] = &[
	("strong asterisk", "**Cut** the tag", "Cut the tag"),
	("strong underscore", "__Cut__ the tag", "Cut the tag"),
	("italic asterisk", "*Cut* the tag", "Cut the tag"),
	("italic underscore", "_Cut_ the tag", "Cut the tag"),
	("code span", "run `read` first", "run read first"),
	("link", "see [the plan](docs/plan.md)", "see the plan (docs/plan.md)"),
	("nested", "**Cut _the_ tag**", "Cut the tag"),
	("code inside strong", "**run `read`**", "run read"),
	("a marker inside a code span", "`**not strong**`", "**not strong**"),
	("image", "![shot](a.png)", "shot (a.png)"),
];

/// Sources markdown reads no marker in. Each one reaches the frame byte for
/// byte, and draws as one unstyled span.
const LITERAL: &[(&str, &str)] = &[
	("a name's own underscore", "call read_file_at now"),
	("a trailing underscore", "the value is x_"),
	("multiplication", "2 * 3 = 6"),
	("an opener with a space after it", "a * b * c"),
	("an unpaired strong run", "**unclosed and on"),
	("an unpaired code run", "a `backtick and on"),
	("a bracket with no target", "[not a link] here"),
	("an empty code run", "a `` b"),
];

/// Every marker is off the drawn text, and the meaning it named is on the span.
#[test]
fn every_marker_leaves_the_frame_as_what_it_means() {
	let mut swept = 0;
	for (name, source, drawn) in MARKERS {
		assert_eq!(plain(source), *drawn, "{name}: the marker must not be drawn");
		let read = spans(source);
		let marked = read
			.iter()
			.any(|span| span.emphasis != Emphasis::default());
		assert!(marked, "{name}: {source} must set at least one span, and set {read:?}");
		swept += 1;
	}
	assert_eq!(swept, MARKERS.len(), "every marker row must be swept");
}

/// Each marker sets its own meaning and not another's.
#[test]
fn a_marker_sets_the_one_emphasis_it_names() {
	let strong = spans("**Cut** the tag");
	assert!(strong[0].emphasis.strong, "** must set strong: {strong:?}");
	assert!(!strong[0].emphasis.italic, "** must not set italic: {strong:?}");

	let italic = spans("*Cut* the tag");
	assert!(italic[0].emphasis.italic, "* must set italic: {italic:?}");
	assert!(!italic[0].emphasis.strong, "* must not set strong: {italic:?}");

	let code = spans("run `read` first");
	let span = code
		.iter()
		.find(|span| span.text == "read")
		.expect("the code span's interior is its own span");
	assert!(span.emphasis.code, "a backtick pair must set code: {code:?}");

	let link = spans("see [the plan](docs/plan.md)");
	let text = link
		.iter()
		.find(|span| span.text == "the plan")
		.expect("the link text is its own span");
	assert!(text.emphasis.link, "the link text must be set as a link: {link:?}");
	let target = link
		.iter()
		.find(|span| span.text.contains("docs/plan.md"))
		.expect("the target is drawn beside the text");
	assert!(target.emphasis.muted, "the target must be muted: {link:?}");
	assert!(!target.emphasis.link, "the target is not the link text: {link:?}");
}

/// A span inherits every emphasis enclosing it, rather than the innermost one.
#[test]
fn nested_emphasis_reaches_the_span_inside_both() {
	let read = spans("**Cut _the_ tag**");
	let inner = read
		.iter()
		.find(|span| span.text == "the")
		.expect("the doubly emphasised word is its own span");
	assert!(inner.emphasis.strong && inner.emphasis.italic, "both must reach it: {read:?}");
	let outer = read
		.iter()
		.find(|span| span.text == "Cut ")
		.expect("the text before the inner marker is its own span");
	assert!(outer.emphasis.strong && !outer.emphasis.italic, "only strong: {read:?}");
}

/// The negative control: a source markdown reads no marker in reaches the frame
/// byte for byte, as one span set in nothing. Without this the reader could
/// pass every row above by deleting `*`, `_`, `` ` `` and `[` wherever it found
/// them, which is what a naive stripper does to a `snake_case` identifier.
#[test]
fn a_marker_that_is_not_one_reaches_the_frame_as_its_own_bytes() {
	for (name, source) in LITERAL {
		assert_eq!(plain(source), *source, "{name}: {source} must be drawn as written");
		let read = spans(source);
		let set: Vec<_> = read
			.iter()
			.filter(|span| span.emphasis != Emphasis::default())
			.collect();
		assert!(set.is_empty(), "{name}: {source} must set nothing, and set {set:?}");
	}
}

/// A code span's interior is literal, so a marker inside a command is a byte of
/// the command. The delimiters themselves still go.
#[test]
fn a_code_span_keeps_its_interior_and_loses_its_delimiters() {
	assert_eq!(plain("`grep -rn '**' .`"), "grep -rn '**' .");
	assert_eq!(plain("`a_b_c`"), "a_b_c");
	let read = spans("`a_b_c`");
	assert_eq!(read.len(), 1, "the interior is one span: {read:?}");
	assert!(read[0].emphasis.code && !read[0].emphasis.italic, "code only: {read:?}");
}

/// One paragraph, read as markdown or drawn as its own bytes at the same ramp.
struct Prose {
	source: &'static str,
	read:   bool,
}

impl Render for Prose {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let resolved = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved;
		let row = div().w(px(860.0));
		if self.read {
			row.child(Markdown::new(self.source))
		} else {
			row.child(
				div()
					.w_full()
					.text_size(tokens.font_size(TextRamp::Read))
					.line_height(tokens.line_height(TextRamp::Read))
					.child(self.source),
			)
		}
	}
}

/// Shapes one paragraph in a real frame and reports the width of the line it
/// drew. `read` false draws the source's own bytes at the same ramp, which is
/// the control every assertion below measures against.
fn line_width(source: &'static str, read: bool) -> f32 {
	let (mut cx, _permit) = headless_context();
	let window = cx
		.open_window(size(px(960.0), px(240.0)), |_window, app| {
			let mut set = TokenSet::default();
			let available = app.text_system().all_font_names();
			set.resolve_mono_family(&available)
				.expect("this machine must have one of the authored monospace families");
			app.set_global(set);
			app.new(|_cx| Prose { source, read })
		})
		.expect("headless window opens");
	render_frame(&mut cx, &window);
	let frame = cx
		.capture_frame(window.into(), 1.0)
		.expect("the frame rasterises");
	let runs = frame.text_runs();
	assert!(!runs.is_empty(), "{source} must draw ink, read={read}");
	runs
		.iter()
		.map(|run| f32::from(run.bounds.size.width))
		.sum()
}

/// The frame proof: a marked paragraph is narrower than its own source bytes
/// set at the same ramp, by more than a rounding tolerance, because the
/// markers are not glyphs the line paid for. The control is the same string
/// through a plain element, so nothing but the reader differs between the two.
#[test]
fn the_frame_lays_out_the_words_and_not_the_markers() {
	for (name, source) in [
		("strong", "**Cut** the tag"),
		("italic", "*Cut* the tag"),
		("code", "run `read` first"),
		("link", "see [the plan](docs/plan.md)"),
	] {
		let read = line_width(source, true);
		let raw = line_width(source, false);
		assert!(
			raw - read > 4.0,
			"{name}: the markers must be off the line: read drew {read}px and the raw source drew \
			 {raw}px"
		);
	}
}

/// The negative control for the frame: a source markdown reads no marker in
/// draws at exactly the width of its own bytes. Without this the widths above
/// could shrink because the reader deletes punctuation it does not understand.
#[test]
fn a_paragraph_with_no_marker_draws_at_the_width_of_its_own_bytes() {
	for source in ["2 * 3 = 6", "call read_file_at now", "[not a link] here"] {
		let read = line_width(source, true);
		let raw = line_width(source, false);
		assert!(
			(read - raw).abs() < 1.0,
			"{source} must draw as written: read drew {read}px and raw drew {raw}px"
		);
	}
}

/// Each emphasis maps to the one style that means it, and to nothing else.
/// This is the mapping the shaper is handed for every span the reader marked,
/// so a marker read correctly and then set in nothing would fail here.
#[test]
fn every_emphasis_maps_to_the_style_that_names_it() {
	let tokens = TokenSet::default();
	let of = |emphasis: Emphasis| span_style(emphasis, &tokens);

	let strong = of(Emphasis { strong: true, ..Emphasis::default() });
	assert_eq!(strong.font_weight, Some(FontWeight::BOLD), "strong is the bold weight");
	assert_eq!(strong.font_style, None, "strong sets no slant");

	let italic = of(Emphasis { italic: true, ..Emphasis::default() });
	assert_eq!(italic.font_style, Some(FontStyle::Italic), "italic is the slant");
	assert_eq!(italic.font_weight, None, "italic sets no weight");

	let both = of(Emphasis { strong: true, italic: true, ..Emphasis::default() });
	assert_eq!(both.font_weight, Some(FontWeight::BOLD), "nested keeps the weight");
	assert_eq!(both.font_style, Some(FontStyle::Italic), "nested keeps the slant");

	let code = of(Emphasis { code: true, ..Emphasis::default() });
	assert_eq!(
		code.background_color,
		Some(tokens.color(ColorRole::Inset)),
		"a code span sits on the inset ground"
	);

	let link = of(Emphasis { link: true, ..Emphasis::default() });
	let accent = tokens.color(ColorRole::Accent);
	assert_eq!(link.color, Some(accent), "link text is set in the accent");
	assert_eq!(
		link.underline.map(|line| line.color),
		Some(Some(accent)),
		"link text is underlined in the accent"
	);

	let muted = of(Emphasis { muted: true, ..Emphasis::default() });
	assert_eq!(muted.color, Some(tokens.color(ColorRole::Muted)), "a target is muted");
	assert_eq!(muted.underline, None, "a target is not underlined");

	assert_eq!(of(Emphasis::default()), HighlightStyle::default(), "unset prose sets nothing");
}

/// A code span is shaped in the mono family, not the prose family: the same
/// words with a backtick pair around one of them shape to another width. This
/// is the family override reaching the shaper, which no style assertion above
/// can observe.
#[test]
fn a_code_span_shapes_in_the_mono_family_and_not_the_prose_one() {
	let with_code = line_width("run `read` first", true);
	let all_prose = line_width("run read first", true);
	assert!(
		(with_code - all_prose).abs() > 1.0,
		"the mono family must reach the shaper: the code span drew {with_code}px and the same words \
		 in prose drew {all_prose}px"
	);
}
