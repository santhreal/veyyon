//! WHY: the window drew every word an agent produced and handed none of them
//! back. The composer's editor could copy its own text, and the kit's clipboard
//! was reached from nowhere else, so a model's answer, the command it ran, the
//! path it named and the refusal it reported were readable on screen and
//! unreachable from anywhere a reader could paste. A transcript that cannot be
//! quoted is a screenshot.
//!
//! CLASS CLOSED: a turn the window drew states its words when it is taken out.
//! The block projection is swept over `BlockShape` at run time, so a block kind
//! added to the transcript states its text or this is red; the turn projection
//! is swept over the `Turn` union, whose arms are named by an exhaustive match
//! rather than by a list here. The press is driven through the real window: the
//! turn under the pointer is resolved from the boxes the frame recorded, the
//! `Copy` row is located by the word the frame drew, and the clipboard is read
//! back from the platform after the press, once per turn, so a menu that copies
//! the first turn whatever was pressed, or the words of some other turn, turns
//! this red. The two negative cases pin the guards: a press away from every
//! turn opens nothing, and a dismissing press leaves the clipboard as it was.
//!
//! GAPS: it proves what the clipboard holds, not what a foreign application
//! reads out of it -- the headless platform's clipboard is in-memory, and the
//! X11 and Wayland writes are the framework's. It sweeps the turns a state
//! holds, not scrolling: a turn outside the viewport has no box, which is the
//! behaviour `turn_at` states and not a case this presses. Whether the intent
//! stays inside the window rather than reaching a host belongs to
//! `an-intent-the-shell-finishes-alone-is-the-only-one-it-does-not-report`.

use std::{path::Path, sync::Arc};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Artifact, Block, BlockShape, Intent, Keymap, ShellState, ShellView, ToolInvocationViews, Turn,
	damage::Region, fixture, install_tokens, transcript::turn_text,
};
use veyyon_gpui::{App, AppContext, ClipboardItem, Pixels, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The word the menu offers, which is the one row a turn menu draws.
const COPY: &str = "Copy";

/// What the clipboard is seeded with before a press that must not write to it,
/// so an untouched clipboard is told apart from an empty one.
const SENTINEL: &str = "what was on the clipboard before the press";

/// One block of each shape, with the words its copy must state.
///
/// The match is exhaustive over `BlockShape`, so a block kind added to the
/// transcript stops this compiling until it states what it copies.
fn sample_block(shape: BlockShape) -> (Block, Vec<&'static str>) {
	match shape {
		BlockShape::Prose => (Block::Prose("the linker resolves symbols".to_owned()), vec![
			"the linker resolves symbols",
		]),
		BlockShape::Note => (
			Block::Note {
				label:    "compacted",
				text:     "nine turns folded into one".to_owned(),
				boundary: true,
			},
			vec!["compacted", "nine turns folded into one"],
		),
		BlockShape::Invoke => (
			Block::Invoke {
				call_id: "c9".to_owned(),
				tool:    "read".to_owned(),
				target:  "crates/veyyon-desktop-surface/src/transcript.rs".to_owned(),
				result:  Some("93 lines".to_owned()),
				views:   ToolInvocationViews::default(),
			},
			vec!["read", "crates/veyyon-desktop-surface/src/transcript.rs", "93 lines"],
		),
		BlockShape::Reason => {
			(Block::Reason("weighing two spellings".to_owned()), vec!["weighing two spellings"])
		},
		BlockShape::Pane => (
			Block::Pane {
				caption: "scripts/verify-scene.ts".to_owned(),
				lines:   vec!["const scene = read(path);".to_owned(), "verify(scene);".to_owned()],
			},
			vec!["scripts/verify-scene.ts", "const scene = read(path);", "verify(scene);"],
		),
		BlockShape::Unknown => (
			Block::Unknown {
				producer: "some-other-host".to_owned(),
				lines:    vec!["a record this build has no renderer for".to_owned()],
			},
			vec!["some-other-host", "a record this build has no renderer for"],
		),
		BlockShape::Artifact => (
			Block::Artifact(Artifact::File {
				path:               "docs/handbook/src/foundations/verification.md".to_owned(),
				has_content:        true,
				lines:              Some(204),
				bytes:              Some(8_192),
				unavailable_reason: None,
				image:              None,
			}),
			vec!["docs/handbook/src/foundations/verification.md"],
		),
	}
}

/// Which arm of the union a turn is, named by the turn itself so a variant
/// added to `Turn` stops this compiling.
const fn turn_kind(turn: &Turn) -> &'static str {
	match turn {
		Turn::Operator(_) => "Operator",
		Turn::OperatorArtifacts { .. } => "OperatorArtifacts",
		Turn::Agent { .. } => "Agent",
	}
}

/// One turn of each kind, with the words its copy must state.
fn sample_turns() -> Vec<(Turn, Vec<&'static str>)> {
	vec![
		(Turn::Operator("what does a linker do?".to_owned()), vec!["what does a linker do?"]),
		(
			Turn::OperatorArtifacts {
				text:      "look at this".to_owned(),
				artifacts: vec![
					Artifact::Image {
						media_type: "image/png".to_owned(),
						data:       Arc::from(&[0u8, 1, 2][..]),
						alt:        Some("the composer at 960px".to_owned()),
					},
					Artifact::File {
						path:               "proof/scenes/lib.sh".to_owned(),
						has_content:        false,
						lines:              None,
						bytes:              None,
						unavailable_reason: Some("not read".to_owned()),
						image:              None,
					},
				],
			},
			vec!["look at this", "the composer at 960px", "proof/scenes/lib.sh"],
		),
		(
			Turn::Agent {
				blocks: vec![
					Block::Reason("reading the two files".to_owned()),
					Block::Prose("it resolves symbols to addresses".to_owned()),
				],
				model:  Some("local/qwen2.5-1.5b".to_owned()),
			},
			vec!["reading the two files", "it resolves symbols to addresses"],
		),
	]
}

fn seeded_state() -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = false;
	state
}

/// Opens the window on the fixture, with the clipboard seeded, and runs `test`.
fn render_session<R>(test: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
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
		app.new(|_| ShellView::new(installed, seeded_state()))
	})
	.expect("session opens");

	test(&mut session)
}

/// What the platform clipboard holds as text.
fn clipboard(session: &mut HeadlessSession<'_, ShellView>) -> Option<String> {
	session
		.update(|_view, _window, cx| cx.read_from_clipboard().and_then(|item| item.text()))
		.expect("read the clipboard")
}

/// The centre of the one text run whose content is exactly `label`.
fn drawn_label(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the frame draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// The centre of the box the last frame drew `region` in, when it drew one.
fn drawn_region_centre(
	session: &mut HeadlessSession<'_, ShellView>,
	region: Region,
) -> Option<Point<Pixels>> {
	session
		.update(|view, _window, _cx| {
			view.laid_out().drawn_bounds(region).map(|bounds| Point {
				x: bounds.origin.x + bounds.size.width / 2.0,
				y: bounds.origin.y + bounds.size.height / 2.0,
			})
		})
		.expect("read the boxes the frame recorded")
}

/// The centre of the box the last frame drew turn `index` in.
fn drawn_turn_centre(
	session: &mut HeadlessSession<'_, ShellView>,
	index: usize,
) -> Option<Point<Pixels>> {
	drawn_region_centre(session, Region::Turn(index))
}

#[test]
fn every_block_a_turn_can_hold_states_its_words_when_the_turn_is_taken_out() {
	let mut swept: Vec<BlockShape> = Vec::new();
	for shape in BlockShape::iter() {
		let (block, wanted) = sample_block(shape);
		let copied = turn_text(&Turn::Agent { blocks: vec![block], model: None });
		for words in &wanted {
			assert!(
				copied.contains(words),
				"a {shape:?} block states `{words}` when it is copied, copied `{copied}`"
			);
		}
		swept.push(shape);
	}
	assert_eq!(
		swept.len(),
		BlockShape::iter().count(),
		"every block kind the transcript holds is swept"
	);
}

#[test]
fn every_kind_of_turn_states_its_words_when_it_is_taken_out() {
	let samples = sample_turns();
	let kinds: Vec<&str> = samples.iter().map(|(turn, _)| turn_kind(turn)).collect();
	assert_eq!(
		kinds,
		["Operator", "OperatorArtifacts", "Agent"],
		"every arm of the turn union is swept, in the order the union states them"
	);

	for (turn, wanted) in samples {
		let copied = turn_text(&turn);
		for words in wanted {
			assert!(
				copied.contains(words),
				"a {} turn states `{words}` when it is copied, copied `{copied}`",
				turn_kind(&turn)
			);
		}
	}
}

#[test]
fn pressing_copy_takes_the_turn_the_pointer_was_over() {
	let turns = seeded_state().transcript;
	assert!(turns.len() > 1, "the fixture holds more than one turn, so the wrong one can be caught");

	let mut pressed = 0usize;
	for (index, turn) in turns.iter().enumerate() {
		let wanted = turn_text(turn);
		let taken = render_session(|session| {
			session.frame().expect("frame renders");
			let at = drawn_turn_centre(session, index)?;
			session
				.right_click(at)
				.expect("press the turn the window drew");
			let captured = session.frame().expect("the menu renders");
			let row = drawn_label(&captured, COPY);
			session
				.click(Point { x: px(row.x), y: px(row.y) })
				.expect("press the row the menu drew");
			let open = session
				.update(|view, _window, _cx| view.turn_menu().is_some())
				.expect("read the menu");
			assert!(!open, "the menu closes when its row is pressed, turn {index}");
			clipboard(session)
		});

		let Some(taken) = taken else {
			continue;
		};
		assert_eq!(
			taken, wanted,
			"pressing `Copy` over turn {index} takes that turn's words out of the window"
		);
		pressed += 1;
	}
	assert!(pressed > 1, "more than one drawn turn was pressed, pressed {pressed}");
}

#[test]
fn a_press_away_from_every_turn_offers_nothing_to_take() {
	render_session(|session| {
		session.frame().expect("frame renders");
		// The composer's own band, taken from the box the frame drew it in:
		// inside the window, drawn over by no turn.
		let at = drawn_region_centre(session, Region::Composer).expect("the frame drew the composer");
		session.right_click(at).expect("press below every turn");
		let captured = session.frame().expect("frame renders");
		let open = session
			.update(|view, _window, _cx| view.turn_menu().is_some())
			.expect("read the menu");
		assert!(!open, "a press where no turn was drawn opens no menu to copy from");
		assert!(
			!captured
				.text_runs
				.iter()
				.any(|run| run.text.as_ref().trim() == COPY),
			"and the window offers no `{COPY}` to press"
		);
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"and nothing was written to the clipboard"
		);
	});
}

#[test]
fn dismissing_the_menu_takes_nothing_out() {
	render_session(|session| {
		session.frame().expect("frame renders");
		let at = drawn_turn_centre(session, 0).expect("the frame drew the first turn");
		session
			.right_click(at)
			.expect("press the turn the window drew");
		let captured = session.frame().expect("the menu renders");
		let row = drawn_label(&captured, COPY);

		// Left of the menu, which is anchored by its top-left at the pointer:
		// the scrim, not a row.
		let corner = Point { x: px(40.0), y: px(row.y) };
		session.click(corner).expect("press the scrim");
		let open = session
			.update(|view, _window, _cx| view.turn_menu().is_some())
			.expect("read the menu");
		assert!(!open, "a press on the scrim dismisses the menu");
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"and copies nothing on the way out"
		);
	});
}

#[test]
fn a_turn_with_no_words_is_not_written_to_the_clipboard() {
	render_session(|session| {
		session
			.update(|view, _window, cx| view.dispatch(Intent::CopyText(String::new()), cx))
			.expect("dispatch an empty copy");
		assert_eq!(
			clipboard(session).as_deref(),
			Some(SENTINEL),
			"an empty turn leaves the clipboard holding what it held"
		);
	});
}
