//! WHY: the transcript drew every word a session produced and a reader could
//! take none of them by hand. The turn menu copied a whole turn, which is the
//! answer for a turn and no answer at all for one sentence of it, one path out
//! of a refusal, or one line of a command's output, so a reader who wanted a
//! path retyped it from the screen.
//!
//! CLASS CLOSED: every case here drives the live window -- a real `ShellView`,
//! the real transcript viewport, the production block renderers -- and reads
//! what the drag selected back through the same projection the copy chord puts
//! on the clipboard. The block kinds are swept from `BlockShape` at run time,
//! so a kind that draws text has to state its spans and a kind that draws none
//! has to be recorded in `SELECTION_OPT_OUTS`, which is pinned here by exact
//! equality: a `Block` variant added to the transcript turns this suite red
//! until its spans, or its opt-out, are recorded. The pointer cases cover the
//! shapes an offset is got wrong in -- a paragraph that wrapped, a
//! right-to-left run, a combining accent, an emoji cluster joined by a
//! zero-width joiner, and a code pane whose lines are separate spans behind a
//! row that has to be opened first.
//!
//! GAPS: it reads which bytes a selection covers and that the covered words
//! repaint, not the colour of the ground they repaint on, which the token
//! suites read. It drives one window width; a paragraph that wraps at another
//! measure is covered by the wrapped case here rather than by a sweep of
//! widths. A tool card the host drew a view for states its text through the
//! tool view renderers and is recorded as offering no span, so a selection
//! inside one of those rows is out of scope until those rows carry spans of
//! their own.

use std::{path::Path, sync::Arc};

use strum::IntoEnumIterator;
use unicode_segmentation::UnicodeSegmentation;
use veyyon_desktop_kit::{document_spans, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::tool_view::{TextBlockView, ToolPresentation, ToolView};
use veyyon_desktop_scene::{
	frame::RgbaFrame,
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Keymap, ShellState, ShellView, fixture, install_tokens,
	model::{Artifact, Block, BlockShape, ToolInvocationViews, Turn},
	transcript::{SELECTION_OPT_OUTS, block_spans, select_whole_turn, selected_text},
};
use veyyon_gpui::{App, AppContext, Bounds, ClipboardItem, Pixels, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// What the clipboard holds before a case touches it, so a copy that wrote
/// nothing is told apart from a copy that wrote the right thing.
const SENTINEL: &str = "nothing has been copied yet";

/// The first paragraph of the turn the pointer cases drag over.
const FIRST: &str = "The fix landed in src/main.rs and the run is green.";
/// The second, which a drag across a block boundary ends in.
const SECOND: &str = "Nothing else in the tree reads that path.";

/// A turn of two paragraphs, which is the smallest transcript a drag can cross
/// a block boundary in.
fn two_paragraphs() -> Vec<Turn> {
	vec![Turn::Agent {
		blocks: vec![Block::Prose(FIRST.into()), Block::Prose(SECOND.into())],
		model:  None,
	}]
}

/// The chord `key` is reached by, which is the platform's own primary
/// modifier: the keymap declares `primary-` and the window resolves it.
fn primary(key: &str) -> String {
	let modifier = if cfg!(target_os = "macos") {
		"cmd"
	} else {
		"ctrl"
	};
	format!("{modifier}-{key}")
}

fn seeded_state(turns: Vec<Turn>, reduced_motion: bool) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.reduced_motion = reduced_motion;
	state.transcript = turns;
	state
}

/// Opens the window on `turns`, with the clipboard seeded, and runs `test`.
fn render_session<R>(
	turns: Vec<Turn>,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	render_session_still(turns, false, test)
}

/// The same window with motion off, which is what a block that opens on a
/// press needs: a reveal is driven by the wall clock, and a body drawn part
/// way through one is clipped to the height it has reached, so the pointer
/// reaches its lines only once the reveal has finished. Motion off finishes it
/// in the frame the press produced; the animation itself is the reveal suite's
/// subject.
fn render_session_still<R>(
	turns: Vec<Turn>,
	reduced_motion: bool,
	test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.write_to_clipboard(ClipboardItem::new_string(SENTINEL.to_owned()));
		app.new(|_| ShellView::new(installed, seeded_state(turns, reduced_motion)))
	})
	.expect("session opens");

	test(&mut session)
}

/// The box the frame drew the one run holding `needle` in.
fn run_holding(captured: &Captured, needle: &str) -> Bounds<Pixels> {
	let runs: Vec<Bounds<Pixels>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().contains(needle))
		.map(|run| run.bounds)
		.collect();
	assert_eq!(
		runs.len(),
		1,
		"the frame draws a run holding {needle:?} exactly once, drew {}",
		runs.len()
	);
	runs[0]
}

/// The box the frame drew the one run whose whole text is `label` in. A
/// caption of two common words is held by a card elsewhere on the frame too,
/// which is what separates this from [`run_holding`].
fn run_labelled(captured: &Captured, label: &str) -> Bounds<Pixels> {
	let runs: Vec<Bounds<Pixels>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| run.bounds)
		.collect();
	assert_eq!(
		runs.len(),
		1,
		"the frame draws {label:?} as a run of its own exactly once, drew {}",
		runs.len()
	);
	runs[0]
}

/// A point `fraction` of the way across `bounds`, on its middle line.
fn along(bounds: Bounds<Pixels>, fraction: f32) -> Point<Pixels> {
	Point {
		x: bounds.origin.x + bounds.size.width * fraction,
		y: bounds.origin.y + bounds.size.height / 2.0,
	}
}

/// How many pixels inside `area` two frames disagree on.
fn changed_pixels(before: &RgbaFrame, after: &RgbaFrame, area: Bounds<Pixels>) -> usize {
	let scale = before.scale_factor();
	let device = |value: Pixels| (f32::from(value) * scale).round().max(0.0) as u32;
	let left = device(area.origin.x);
	let top = device(area.origin.y);
	let right = device(area.origin.x + area.size.width);
	let bottom = device(area.origin.y + area.size.height);
	assert!(right > left && bottom > top, "the box {area:?} holds no pixels");

	let mut changed = 0;
	for y in top..bottom {
		for x in left..right {
			if before.pixel(x, y) != after.pixel(x, y) {
				changed += 1;
			}
		}
	}
	changed
}

/// What the platform clipboard holds as text.
fn clipboard(session: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	session
		.update(|_view, _window, cx| cx.read_from_clipboard().and_then(|item| item.text()))
		.expect("read the clipboard")
}

#[test]
fn a_drag_across_two_blocks_selects_the_words_it_crossed_and_draws_them_selected() {
	let (selected, repainted) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		let second = run_holding(&rest, SECOND);
		session
			.drag(along(first, 0.5), along(second, 0.5))
			.expect("the drag reaches the second paragraph");
		let dragged = session.frame().expect("frame renders after the drag");
		let selected = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		(selected, changed_pixels(&rest.frame, &dragged.frame, second))
	});

	let (head, tail) = selected.split_once('\n').unwrap_or_else(|| {
		panic!("a drag across two blocks copies one line per block, copied {selected:?}")
	});
	assert!(
		!head.is_empty() && FIRST.ends_with(head),
		"the first line copied is the tail of the first paragraph, was {head:?}"
	);
	assert!(
		!tail.is_empty() && SECOND.starts_with(tail),
		"the second line copied is the head of the second paragraph, was {tail:?}"
	);
	assert!(
		repainted > 0,
		"the second paragraph is under the selection and repainted nothing, so a reader cannot see \
		 what is selected"
	);
}

#[test]
fn a_press_with_shift_extends_the_selection_rather_than_starting_a_new_one() {
	let (plain, extended) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		let second = run_holding(&rest, SECOND);
		session.click(along(first, 0.25)).expect("the press lands");
		let plain = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		session
			.shift_click(along(second, 0.75))
			.expect("the extending press lands");
		let extended = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		(plain, extended)
	});

	assert!(plain.is_empty(), "a press that has not been dragged selects nothing, copied {plain:?}");
	let (head, tail) = extended.split_once('\n').unwrap_or_else(|| {
		panic!("a shift-press in the second block extends across both, copied {extended:?}")
	});
	assert!(
		!head.is_empty() && FIRST.ends_with(head),
		"the extended selection starts where the first press landed, copied {head:?}"
	);
	assert!(
		tail.len() > SECOND.len() / 2 && SECOND.starts_with(tail),
		"the extended selection ends where the shift-press landed, copied {tail:?}"
	);
}

#[test]
fn the_entry_chord_takes_the_turn_and_the_copy_chord_puts_it_on_the_clipboard() {
	let copied = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		// The chords resolve on the transcript's own context, which the press
		// that focuses the column brings into scope.
		session
			.click(along(run_holding(&rest, FIRST), 0.1))
			.expect("the press focuses the transcript");
		assert!(
			session
				.keystroke(&primary("a"))
				.expect("the chord dispatches"),
			"the chord that takes an entry is bound in the transcript scope"
		);
		assert!(
			session
				.keystroke(&primary("c"))
				.expect("the chord dispatches"),
			"the chord that copies a selection is bound in the transcript scope"
		);
		clipboard(session)
	});

	assert_eq!(
		copied.as_deref(),
		Some(format!("{FIRST}\n{SECOND}").as_str()),
		"the entry chord takes every span of the turn and the copy chord puts them on the clipboard \
		 over what was there"
	);
}

#[test]
fn the_copy_chord_leaves_the_clipboard_alone_when_nothing_is_selected() {
	let (held, claimed) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		session
			.click(along(run_holding(&rest, FIRST), 0.1))
			.expect("the press focuses the transcript");
		let claimed = session
			.keystroke(&primary("c"))
			.expect("the chord dispatches");
		(clipboard(session), claimed)
	});

	assert_eq!(
		held.as_deref(),
		Some(SENTINEL),
		"a copy with nothing selected wrote an empty string over what the reader had copied"
	);
	assert!(
		!claimed,
		"a copy with nothing selected claimed the chord, so no other binding can have it"
	);
}

#[test]
fn a_dismissal_drops_the_selection_and_the_words_come_back_unselected() {
	let (held, dropped, repainted) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		session
			.drag(along(first, 0.2), along(first, 0.8))
			.expect("the drag stays inside the paragraph");
		let dragged = session.frame().expect("frame renders after the drag");
		let held = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		session.keystroke("escape").expect("Escape dispatches");
		let cleared = session.frame().expect("frame renders after the dismissal");
		let dropped = session
			.update(|view, _window, _cx| view.text_selection().is_none())
			.expect("the view reads back its selection");
		(held, dropped, changed_pixels(&dragged.frame, &cleared.frame, first))
	});

	assert!(
		!held.is_empty(),
		"a drag inside one paragraph selected no words, so what follows proves nothing about \
		 dropping them"
	);
	assert!(dropped, "Escape left the selection held, so the highlight has no way out");
	assert!(
		repainted > 0,
		"the dismissal dropped the selection and repainted nothing, so the highlight is still drawn"
	);
}

#[test]
fn a_press_on_the_canvas_beside_the_text_drops_the_selection() {
	let (held, dropped) = render_session(two_paragraphs(), |session| {
		let rest = session.frame().expect("frame renders");
		let first = run_holding(&rest, FIRST);
		session
			.drag(along(first, 0.2), along(first, 0.8))
			.expect("the drag stays inside the paragraph");
		let held = session
			.update(|view, _window, _cx| view.selected_text())
			.expect("the view reads back its selection");
		// The margin left of the column is the transcript's own canvas: a press
		// there names no span, and it is the press that ends a selection without
		// starting another.
		session
			.click(Point { x: first.origin.x - px(24.0), y: along(first, 0.5).y })
			.expect("the press lands beside the text");
		let dropped = session
			.update(|view, _window, _cx| view.text_selection().is_none())
			.expect("the view reads back its selection");
		(held, dropped)
	});

	assert!(
		!held.is_empty(),
		"a drag inside one paragraph selected no words, so what follows proves nothing about \
		 dropping them"
	);
	assert!(
		dropped,
		"a press beside the text left the selection held, so the highlight stays drawn under a \
		 pointer that has moved on"
	);
}

/// A paragraph carrying the shapes a byte offset is got wrong in: a line long
/// enough to wrap at this measure, a right-to-left run, a combining accent,
/// and an emoji cluster joined by a zero-width joiner.
const AWKWARD: &str = "The run wrote one long line that has to wrap at this measure because it \
                       keeps going past the column, and it names \u{5e9}\u{5dc}\u{5d5}\u{5dd} \
                       \u{5e2}\u{5d5}\u{5dc}\u{5dd}, cafe\u{301}, and \u{1f469}\u{200d}\u{1f4bb} \
                       in one sentence.";

/// How many stops the pointer is dragged to across the paragraph. The frame
/// records a wrapped paragraph as one box rather than one run per glyph, so no
/// stop can be aimed at the emoji: sweeping the width instead lands offsets
/// throughout the sentence, the accent and the joined sequence among them.
const STOPS: usize = 24;

#[test]
fn a_drag_over_a_wrapped_line_never_cuts_a_cluster_or_leaves_the_span() {
	let drawn = document_spans(AWKWARD);
	let span = drawn.first().expect("the paragraph draws one span").clone();
	let taken = render_session(
		vec![Turn::Agent { blocks: vec![Block::Prose(AWKWARD.into())], model: None }],
		|session| {
			let rest = session.frame().expect("frame renders");
			let paragraph = run_holding(&rest, "\u{1f469}\u{200d}\u{1f4bb}");
			let height = f32::from(paragraph.size.height);
			assert!(
				height > 30.0,
				"the paragraph has to wrap for this case to mean anything, drew {height}px of a 22px \
				 line"
			);

			// The press opens at the head of the first line and each stop
			// walks the last one, so the head of the selection travels the
			// whole sentence: the offsets it resolves to are wherever the
			// shaper put the cluster boundaries, not where this test guessed
			// they were.
			let from = Point { x: paragraph.origin.x + px(1.0), y: paragraph.origin.y + px(11.0) };
			let last_line = paragraph.origin.y + paragraph.size.height - px(11.0);
			let mut taken: Vec<String> = Vec::new();
			for stop in 0..=STOPS {
				let across = paragraph.size.width * (stop as f32 / STOPS as f32);
				session
					.drag(from, Point { x: paragraph.origin.x + across, y: last_line })
					.expect("the drag reaches the stop");
				taken.push(
					session
						.update(|view, _window, _cx| view.selected_text())
						.expect("the view reads back its selection"),
				);
			}
			taken
		},
	);

	let clusters = cluster_offsets(&span);
	let mut reached: Vec<&String> = taken.iter().filter(|text| !text.is_empty()).collect();
	reached.dedup();
	assert!(
		reached.len() >= 4,
		"a drag across the paragraph selects more the further it goes; {} of {STOPS} stops selected \
		 anything at all",
		reached.len()
	);
	assert!(
		taken
			.iter()
			.any(|text| text.contains("\u{1f469}\u{200d}\u{1f4bb}")),
		"no stop of the drag reached past the joined sequence, so nothing here would notice it \
		 being cut"
	);

	for text in taken.iter().filter(|text| !text.is_empty()) {
		let start = span.find(text.as_str()).unwrap_or_else(|| {
			panic!("every stop copies a piece of the span the frame drew, copied {text:?}")
		});
		let end = start + text.len();
		for (offset, cluster) in &clusters {
			if *offset < end && offset + cluster.len() > start {
				assert!(
					*offset >= start && offset + cluster.len() <= end,
					"the copy {text:?} cuts the cluster {cluster:?} at byte {offset}, so a reader \
					 takes half a character"
				);
			}
		}
	}
}

/// Each grapheme cluster of `text` with the byte offset it starts at.
fn cluster_offsets(text: &str) -> Vec<(usize, &str)> {
	text.grapheme_indices(true).collect()
}

/// The caption the row holding the output draws, and the lines behind it.
const PANE_CAPTION: &str = "cargo test";
const PANE_LINES: [&str; 2] = ["test result: ok. 3 passed", "Finished in 0.42s"];

#[test]
fn one_line_of_a_command_s_output_is_selected_after_the_row_that_opened_it() {
	let selected = render_session_still(
		vec![Turn::Agent {
			blocks: vec![Block::Pane {
				caption: PANE_CAPTION.into(),
				lines:   PANE_LINES.iter().map(|line| (*line).to_owned()).collect(),
			}],
			model:  None,
		}],
		true,
		|session| {
			let collapsed = session.frame().expect("frame renders");
			assert!(
				collapsed
					.text_runs
					.iter()
					.all(|run| !run.text.as_ref().contains(PANE_LINES[0])),
				"the pane draws its lines only once the row is open, so this case has to open it"
			);
			session
				.click(along(run_labelled(&collapsed, PANE_CAPTION), 0.5))
				.expect("the press opens the row");
			let opened = session.frame().expect("frame renders after the row opened");
			let line = run_holding(&opened, PANE_LINES[0]);
			session
				.drag(along(line, 0.1), along(line, 0.9))
				.expect("the drag stays inside the line");
			session
				.update(|view, _window, _cx| view.selected_text())
				.expect("the view reads back its selection")
		},
	);

	assert!(
		!selected.is_empty() && PANE_LINES[0].contains(selected.as_str()),
		"a drag along one line of the output copies a piece of that line and nothing of the line \
		 under it, copied {selected:?}"
	);
}

/// One sample of every kind of block a turn can hold, keyed by its shape, so
/// the sweep reads the union from `BlockShape` rather than from a list written
/// here.
fn sample(shape: BlockShape) -> Block {
	match shape {
		BlockShape::Prose => Block::Prose("A sentence the run wrote.".into()),
		BlockShape::Reason => Block::Reason("What it was working out.".into()),
		BlockShape::Note => {
			Block::Note { label: "Compacted", text: "the earlier turns".into(), boundary: true }
		},
		BlockShape::Invoke => Block::Invoke {
			call_id: "call-1".into(),
			tool:    "bash".into(),
			target:  PANE_CAPTION.into(),
			result:  Some(PANE_LINES.join("\n")),
			views:   ToolInvocationViews::default(),
		},
		BlockShape::Pane => Block::Pane {
			caption: PANE_CAPTION.into(),
			lines:   PANE_LINES.iter().map(|line| (*line).to_owned()).collect(),
		},
		BlockShape::Unknown => Block::Unknown {
			producer: "some-plugin".into(),
			lines:    vec!["a line it recorded".into()],
		},
		BlockShape::Artifact => Block::Artifact(Artifact::File {
			path:               "docs/plan.md".into(),
			has_content:        false,
			lines:              Some(12),
			bytes:              Some(480),
			unavailable_reason: None,
			image:              None,
		}),
	}
}

#[test]
fn every_kind_of_block_either_states_its_spans_or_is_recorded_as_offering_none() {
	let mut offering_none: Vec<String> = Vec::new();
	for shape in BlockShape::iter() {
		let block = sample(shape);
		let spans = block_spans(&block);
		if spans.is_empty() {
			offering_none.push(format!("{shape:?}"));
			continue;
		}

		// Every span a kind states is reachable: the selection the entry chord
		// takes covers it, and what comes back is the text the block drew.
		let turn = Turn::Agent { blocks: vec![block], model: None };
		let selection = select_whole_turn(0, &turn).expect("a block with spans takes a selection");
		let copied = selected_text(std::slice::from_ref(&turn), selection);
		for span in &spans {
			assert!(
				copied.contains(span.as_str()),
				"{shape:?} states the span {span:?} and taking the whole turn copied {copied:?}"
			);
		}
	}

	// An opt-out named by one word is a whole block kind, which is what this
	// sweep can see. One carrying a qualifier is a case of a kind that states
	// spans otherwise, and each of those carries a case of its own below.
	let whole_kinds: Vec<&str> = SELECTION_OPT_OUTS
		.iter()
		.copied()
		.filter(|opt| !opt.contains(' '))
		.collect();
	assert_eq!(
		offering_none.iter().map(String::as_str).collect::<Vec<_>>(),
		whole_kinds,
		"a block kind that draws no selectable span is recorded in SELECTION_OPT_OUTS, and one \
		 recorded there draws none"
	);

	let shapes: Vec<String> = BlockShape::iter()
		.map(|shape| format!("{shape:?}"))
		.collect();
	for opt in SELECTION_OPT_OUTS {
		let named = opt.split_whitespace().next().unwrap_or_default();
		assert!(
			shapes.iter().any(|shape| shape == named),
			"the opt-out {opt:?} names {named:?}, which is no kind of block a turn can hold"
		);
	}
}

#[test]
fn a_call_the_host_drew_a_view_for_states_no_span_and_is_recorded_as_offering_none() {
	assert_eq!(
		SELECTION_OPT_OUTS,
		["Artifact", "Invoke with a host view"],
		"the kinds and cases that draw no selectable span are pinned, so one added or taken away is \
		 a decision rather than a drift"
	);

	let presented = ToolPresentation {
		expanded: true,
		view:     ToolView::TextBlock(TextBlockView::text(PANE_LINES[0])),
	};
	let drawn_by_the_host = Block::Invoke {
		call_id: "call-1".into(),
		tool:    "bash".into(),
		target:  PANE_CAPTION.into(),
		result:  Some(PANE_LINES.join("\n")),
		views:   ToolInvocationViews { call: None, result: Some(Arc::new(presented)) },
	};

	assert!(
		block_spans(&drawn_by_the_host).is_empty(),
		"a call the host drew a view for states its text through that view, not through a span of \
		 this module's, so the raw result is not offered twice"
	);
}
