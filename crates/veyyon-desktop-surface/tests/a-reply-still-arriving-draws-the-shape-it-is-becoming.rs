//! WHY: a reply arrives a few characters at a time and the transcript read
//! every mid-turn frame as a finished document. A table drew as a row of
//! pipes until its delimiter row landed, a bold word drew its asterisks until
//! the closing pair landed, and a list marker drew as a dash of prose -- then
//! the whole paragraph reflowed when the next delta arrived.
//!
//! The class this closes: a shape a prefix leaves open that reaches the frame
//! as its own markers. The sweep is built from `OpenShape` by an exhaustive
//! match, so a shape added to the model without a frame reading here does not
//! compile. It also pins the two halves against each other: the model states
//! what is open, the kit states which bytes are markers, and they are
//! separate implementations in crates that cannot import one another.
//!
//! What this does NOT catch: the live host cadence. The turn is rendered at a
//! chosen prefix rather than driven by a transport, and the caret is drawn at
//! zero opacity so the frame carries prose and nothing else.

use std::{path::Path, time::Instant};

use veyyon_desktop_kit::{TokenSet, document_spans, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::text::markdown::{OpenShape, settled_prefix_len};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	damage::LaidOut,
	install_tokens,
	model::Block,
	transcript::{TranscriptViewportState, agent_turn},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{App, AppContext, Context, IntoElement, Render, Window};

/// One agent turn of one block, drawn the way the transcript draws it. The
/// block is a reply or an expanded thought, which are the two surfaces a
/// model's markdown arrives on.
struct TurnView {
	text:      String,
	streaming: bool,
	thought:   bool,
	geometry:  TranscriptSurfaceTokens,
	tokens:    TokenSet,
	motion:    MotionTokens,
	state:     TranscriptViewportState,
}

impl Render for TurnView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let block = if self.thought {
			Block::Reason(self.text.clone())
		} else {
			Block::Prose(self.text.clone())
		};
		agent_turn(
			0,
			&[block],
			None,
			true,
			self.streaming,
			0.0,
			&self.state,
			&self.geometry,
			&self.tokens,
			&self.motion,
			self.thought,
			&LaidOut::default(),
			None,
			None,
		)
	}
}

/// Draws `text` as an agent turn and reports every run of text the frame set,
/// in the order the frame set it.
fn drawn(text: &str, streaming: bool) -> Vec<String> {
	runs_of(frame(text, streaming))
}

/// Every run of text a captured frame set, in the order it was set.
fn runs_of(frame: Captured) -> Vec<String> {
	frame
		.text_runs
		.iter()
		.map(|run| run.text.to_string())
		.collect()
}

/// The runs of an expanded thought block still arriving, without the
/// collapsed header line. The header states the summary as one truncated
/// label rather than as markdown, so it carries the source's own bytes and is
/// not a reading of the reader under test.
fn thought_runs(text: &str, streaming: bool) -> Vec<String> {
	runs_of(thought_frame(text, streaming))
		.into_iter()
		.filter(|run| !run.starts_with("Thought:"))
		.collect()
}

/// The captured frame of one turn.
fn frame(text: &str, streaming: bool) -> Captured {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let held = text.to_owned();
	let mut cx = headless_context().expect("headless renderer");
	render_view_captured(
		&mut cx,
		&RenderOptions { width: 720, height: 400, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed tokens");
			app.new(|_| TurnView {
				thought: false,
				text: held,
				streaming,
				geometry: tokens.surface.transcript,
				tokens: installed.set,
				motion: installed.motion,
				state,
			})
		},
	)
	.expect("rendered turn")
}

/// The captured frame of one turn whose thought block is expanded, which is
/// the state an operator reads a thought in while it arrives.
fn thought_frame(text: &str, streaming: bool) -> Captured {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let held = text.to_owned();
	let mut cx = headless_context().expect("headless renderer");
	render_view_captured(
		&mut cx,
		&RenderOptions { width: 720, height: 400, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed tokens");
			// Expanded with motion reduced, so the reveal stands at its own
			// height in the first frame rather than growing into it.
			state.set_block_expanded(0, 0, true, &installed.motion, true, Instant::now());
			let _ = state.is_animating(Instant::now(), &installed.motion, true);
			app.new(|_| TurnView {
				thought: true,
				text: held,
				streaming,
				geometry: tokens.surface.transcript,
				tokens: installed.set,
				motion: installed.motion,
				state,
			})
		},
	)
	.expect("rendered turn")
}

/// A prefix that leaves `shape` open, and the marker byte that must not reach
/// the frame while it is open. Exhaustive: a shape added to the model states
/// its frame reading here or this does not compile.
fn arriving(shape: OpenShape) -> (&'static str, char, &'static str) {
	match shape {
		OpenShape::Fence => ("```rust\nlet held = 1;", '`', "let held = 1;"),
		OpenShape::Table => ("| tool | when |", '|', "tool"),
		OpenShape::Item => ("-", '-', "\u{2022}"),
		OpenShape::Heading => ("##", '#', ""),
		OpenShape::CodeSpan => ("run `read", '`', "read"),
		OpenShape::Strong => ("**Cut", '*', "Cut"),
		OpenShape::Emphasis => ("*Cut", '*', "Cut"),
		OpenShape::LinkTarget => ("see [the plan](docs/p", '[', "the plan"),
	}
}

/// Every open shape reaches the frame as what it is becoming: its markers are
/// off the frame and the text inside it is on the frame.
#[test]
fn every_arriving_shape_draws_without_its_markers() {
	for shape in OpenShape::all() {
		let (source, marker, inside) = arriving(shape);
		let runs = drawn(source, true);
		for run in &runs {
			assert!(
				!run.contains(marker),
				"{shape:?}: {marker:?} must be off the frame, drew {runs:?}"
			);
		}
		if !inside.is_empty() {
			assert!(
				runs.iter().any(|run| run.contains(inside)),
				"{shape:?}: {inside:?} must be on the frame, drew {runs:?}"
			);
		}
	}
}

/// A thought arrives one delta at a time the way a reply does, and the
/// expanded thought prose goes through the same boundary: every shape a
/// prefix leaves open reaches the frame as what it is becoming. The class is
/// every block a model's markdown arrives on, not the reply alone.
#[test]
fn an_arriving_thought_draws_without_its_markers_too() {
	for shape in OpenShape::all() {
		let (source, marker, inside) = arriving(shape);
		let runs = thought_runs(source, true);
		for run in &runs {
			assert!(
				!run.contains(marker),
				"{shape:?}: {marker:?} must be off the thought, drew {runs:?}"
			);
		}
		if !inside.is_empty() {
			assert!(
				runs.iter().any(|run| run.contains(inside)),
				"{shape:?}: {inside:?} must be on the thought, drew {runs:?}"
			);
		}
	}
}

/// The thought's own negative control: a finished thought draws its markers,
/// so the reading above is the boundary at work rather than a reader that
/// drops punctuation.
#[test]
fn a_finished_thought_draws_its_own_markers() {
	for shape in [OpenShape::Table, OpenShape::Strong] {
		let (source, marker, _) = arriving(shape);
		let runs = thought_runs(source, false);
		assert!(
			runs.iter().any(|run| run.contains(marker)),
			"{shape:?}: a finished thought draws {marker:?}, drew {runs:?}"
		);
	}
}

/// The negative control: the same prefix in a turn that is no longer arriving
/// is read as the document it is, markers and all. Without it the frame
/// readings above could pass because the reader strips punctuation it does
/// not understand.
#[test]
fn the_same_prefix_in_a_finished_turn_draws_its_own_markers() {
	for shape in [OpenShape::Table, OpenShape::Strong, OpenShape::Item] {
		let (source, marker, _) = arriving(shape);
		let runs = drawn(source, false);
		assert!(
			runs.iter().any(|run| run.contains(marker)),
			"{shape:?}: a finished turn draws {marker:?}, drew {runs:?}"
		);
	}
}

/// A table the delimiter row has reached draws the same grid whether or not
/// the turn is still arriving: the mend closes what is open and invents
/// nothing else.
#[test]
fn a_table_that_closed_itself_draws_the_same_either_way() {
	let source = "| tool | when |\n|--|--:|\n| read | first |";
	assert_eq!(drawn(source, true), drawn(source, false));
}

/// The settled side of the boundary is drawn the same before and after the
/// next delta lands, and the arriving side is what changed. This is the
/// reveal boundary doing its work: settled text does not reflow because the
/// tail grew.
#[test]
fn the_settled_text_is_drawn_the_same_when_the_next_delta_lands() {
	let before = "# Report\n\nThe first paragraph settled.\n\n| tool | when";
	let after = "# Report\n\nThe first paragraph settled.\n\n| tool | when |\n|--|--|\n| read";
	let settled = settled_prefix_len(before);
	assert!(settled > 0, "the heading and the paragraph have settled");
	assert_eq!(settled, settled_prefix_len(after), "the boundary held while the table grew");
	let (first, second) = (drawn(before, true), drawn(after, true));
	let held = document_spans(&before[..settled]).len();
	assert_eq!(
		first[..held],
		second[..held],
		"the settled runs must be the same runs: {first:?} then {second:?}"
	);
	assert_ne!(first, second, "the arriving side is what the delta changed");
}

/// The seam loses and duplicates nothing: the spans of the two pieces the
/// renderer draws are the spans of the whole block, in order, which is what
/// keeps a selection numbered from this block's base pointing at the text it
/// was drawn over.
#[test]
fn the_spans_of_the_two_pieces_are_the_spans_of_the_whole_block() {
	for document in documents() {
		for split in (0..=document.len()).filter(|at| document.is_char_boundary(*at)) {
			let prefix = &document[..split];
			let settled = settled_prefix_len(prefix);
			let whole = document_spans(prefix);
			let mut pieces = document_spans(&prefix[..settled]);
			pieces.extend(document_spans(&prefix[settled..]));
			assert_eq!(whole, pieces, "split {split} of {document:?} seams at {settled}");
		}
	}
}

/// The documents the split-point walks run over: a heading, a paragraph with
/// inline markers, a grid, a list, a fence and a quote.
fn documents() -> [&'static str; 3] {
	[
		"# Report\n\nA paragraph with **strong** in it.\n\n| a | b |\n|--|--|\n| 1 | 2 |\n\n- \
		 one\n- two\n",
		"```rust\nlet held = 1;\n```\n\nprose after the fence\n",
		"one line\nand another\n\n> a quote\n",
	]
}

/// The words a frame has to carry: every run of three or more alphanumeric
/// bytes in the source. A marker is punctuation, so closing a shape can move
/// a word but cannot drop one.
fn words(source: &str) -> Vec<String> {
	source
		.split(|byte: char| !byte.is_alphanumeric())
		.filter(|word| word.len() >= 3)
		.map(str::to_owned)
		.collect()
}

/// Every prefix of a document renders, and every word in it is on the frame.
/// This is the split-point fuzz: a shape closed mid-arrival is drawn as
/// another shape, never as fewer characters, and no prefix panics the
/// renderer.
#[test]
fn every_prefix_renders_and_keeps_the_words_it_holds() {
	for document in documents() {
		for split in (0..=document.len()).filter(|at| document.is_char_boundary(*at)) {
			let prefix = &document[..split];
			let runs = drawn(prefix, true);
			let frame = runs.join(" ");
			for word in words(prefix) {
				assert!(
					frame.contains(&word),
					"split {split} of {document:?} lost {word:?}, drew {runs:?}"
				);
			}
		}
	}
}
