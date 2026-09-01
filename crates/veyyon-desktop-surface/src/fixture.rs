//! A shell state to render without a host attached.
//!
//! Every surface here is drawn from a state, so a state built in memory renders
//! the whole window with no transport, no session and no agent running. That is
//! what makes the shell reviewable as a picture, and it is what the headless
//! render test asserts against.
//!
//! The fixture is deliberately awkward: titles longer than the rail is wide, a
//! parked list longer than its page size, a section with nothing in it, and one
//! row of every badge. A fixture full of short tidy strings proves only that
//! the layout survives the easy case.

use crate::model::{Badge, Block, Card, Row, Section, ShellState, TreeRow, Turn};

/// Builds a shell state exercising every section, badge and block kind.
pub fn populated() -> ShellState {
	ShellState {
		title:      "veyyon-desktop-surface".to_owned(),
		sections:   vec![
			(Section::Unsent, vec![Row {
				title:    "Split the oversized loader files".to_owned(),
				subtitle: "veyyon/crates/veyyon-desktop-tokens".to_owned(),
				badge:    None,
				meta:     None,
				current:  false,
			}]),
			(Section::Pinned, vec![Row {
				title:    "Reach the headless renderer and prove it deterministic".to_owned(),
				subtitle: "veyyon/crates/veyyon-desktop-scene".to_owned(),
				badge:    Some(Badge::Approval),
				meta:     Some("4m".to_owned()),
				current:  false,
			}]),
			(Section::Live, vec![
				Row {
					title:    "Build the queue, transcript and composer surfaces".to_owned(),
					subtitle: "veyyon/crates/veyyon-desktop-surface".to_owned(),
					badge:    Some(Badge::Working),
					meta:     Some("12m".to_owned()),
					current:  true,
				},
				Row {
					title:    "Per-corner radii on a single quad, at both device ratios".to_owned(),
					subtitle: "zed/crates/gpui".to_owned(),
					badge:    Some(Badge::Watching),
					meta:     Some("31m".to_owned()),
					current:  false,
				},
				Row {
					title:    "Which providers carry the premium multiplier".to_owned(),
					subtitle: "veyyon/packages/catalog".to_owned(),
					badge:    Some(Badge::Input),
					meta:     Some("2m".to_owned()),
					current:  false,
				},
				Row {
					title:    "Close the fail-open colour fallback in the kit".to_owned(),
					subtitle: "veyyon/crates/veyyon-desktop-kit".to_owned(),
					badge:    Some(Badge::Plan),
					meta:     Some("8m".to_owned()),
					current:  false,
				},
			]),
			(Section::Deferred, vec![
				Row {
					title:    "Regenerate the contact sheet after the truncation fix".to_owned(),
					subtitle: String::new(),
					badge:    Some(Badge::Due),
					meta:     Some("09:00".to_owned()),
					current:  false,
				},
				Row {
					title:    "Backdrop blur that samples the framebuffer".to_owned(),
					subtitle: String::new(),
					badge:    None,
					meta:     Some("Thu".to_owned()),
					current:  false,
				},
			]),
			// Longer than the page size, so the rail's overflow row is drawn.
			(Section::Parked, parked_rows()),
		],
		transcript: transcript(),
		composed:   String::new(),
		run_status: Some((
			Badge::Working,
			"Rendering the shell headless at 1440x900, one frame per section".to_owned(),
		)),
		tree:       tree(),
		tabs:       vec!["Changes".to_owned(), "Terminal".to_owned(), "Diagnostics".to_owned()],
		active_tab: 0,
		cards:      cards(),
		drawer:     None,
	}
}

/// A parked list longer than one page.
fn parked_rows() -> Vec<Row> {
	let titles = [
		"Refactor the surface dumper to serialize from Tokens",
		"Investigate the edge ceiling unit mismatch",
		"Clarify the missing tint pair for the watching badge",
		"Terminal drawer resize handle hit area",
		"Palette ranking across sessions and files",
		"Settings differential for the queue density knob",
		"Diff gutter alignment at the narrow breakpoint",
	];

	titles
		.into_iter()
		.map(|title| Row {
			title:    title.to_owned(),
			subtitle: String::new(),
			badge:    None,
			meta:     None,
			current:  false,
		})
		.collect()
}

/// A transcript with every block kind, and one turn long enough to wrap.
fn transcript() -> Vec<Turn> {
	vec![
		Turn::Operator(
			"Build the queue, the transcript and the composer for real, from the tokens. I want to \
			 look at it, not read a report about it."
				.to_owned(),
		),
		Turn::Agent(vec![
			Block::Reason("Reading the surface token groups and the kit's primitives".to_owned()),
			Block::Invoke {
				tool:   "read".to_owned(),
				target: "crates/veyyon-desktop-tokens/src/surface.rs".to_owned(),
				result: Some("207 lines".to_owned()),
			},
			Block::Invoke {
				tool:   "read".to_owned(),
				target: "crates/veyyon-desktop-kit/src/token_set.rs".to_owned(),
				result: Some("281 lines".to_owned()),
			},
			Block::Invoke {
				tool:   "search".to_owned(),
				target: "structure: pub fn $NAME($$$ARGS) -> $RET".to_owned(),
				result: Some("38 matches".to_owned()),
			},
			Block::Prose(
				"The kit already owns the bridge from tokens to renderer types, as a global resolved \
				 once at construction. The surfaces read the geometry groups directly and take \
				 colours from that same set, so a primitive and the surface around it cannot disagree \
				 about what the theme says."
					.to_owned(),
			),
			Block::Pane {
				caption: "crates/veyyon-desktop-surface/src/queue.rs".to_owned(),
				lines:   vec![
					"pub fn queue_rail(".to_owned(),
					"    sections: &[(Section, Vec<Row>)],".to_owned(),
					"    geometry: &QueueSurfaceTokens,".to_owned(),
					"    tokens: &TokenSet,".to_owned(),
					") -> impl IntoElement {".to_owned(),
				],
			},
			Block::Prose(
				"Two row shapes carry the density: a card for the sections being worked in, a line \
				 for the ones that are not."
					.to_owned(),
			),
		]),
	]
}

/// A changed-files tree.
fn tree() -> Vec<TreeRow> {
	vec![
		TreeRow { depth: 0, name: "crates".to_owned(), changed: None },
		TreeRow { depth: 1, name: "veyyon-desktop-surface".to_owned(), changed: None },
		TreeRow { depth: 2, name: "src".to_owned(), changed: None },
		TreeRow { depth: 3, name: "queue.rs".to_owned(), changed: Some((238, 0)) },
		TreeRow { depth: 3, name: "transcript.rs".to_owned(), changed: Some((249, 0)) },
		TreeRow { depth: 3, name: "composer.rs".to_owned(), changed: Some((180, 0)) },
		TreeRow { depth: 3, name: "panel.rs".to_owned(), changed: Some((141, 0)) },
		TreeRow { depth: 3, name: "shell.rs".to_owned(), changed: Some((214, 0)) },
		TreeRow { depth: 3, name: "tokens.rs".to_owned(), changed: Some((58, 0)) },
		TreeRow { depth: 1, name: "veyyon-desktop-kit".to_owned(), changed: None },
		TreeRow { depth: 2, name: "src/token_set.rs".to_owned(), changed: Some((41, 12)) },
		TreeRow { depth: 0, name: "Cargo.toml".to_owned(), changed: Some((1, 0)) },
	]
}

/// One card of every kind, plus enough of them to overflow the stack cap.
fn cards() -> Vec<Card> {
	vec![
		Card::Approval {
			tool:   "bash — cargo test -p veyyon-desktop-surface".to_owned(),
			detail: vec![
				"Runs on axiomexec, in the checkout at /media/.../veyyon-gui.".to_owned(),
				"Touches no tracked file; writes target/scene-frames/.".to_owned(),
			],
		},
		Card::Question {
			prompt:  "The queue rail has no width for both a badge and elapsed time under 208px. \
			          Which gives way?"
				.to_owned(),
			options: vec![
				"Drop the elapsed time, keep the badge".to_owned(),
				"Reduce the badge to its tint dot".to_owned(),
				"Wrap to a second line".to_owned(),
			],
		},
		Card::Plan {
			title: "Move the surface leaves onto kit primitives".to_owned(),
			body:  vec![
				"Replace the hand-built title and subtitle rows with Truncate.".to_owned(),
				"Replace the answer row with Button, keeping the accent on the last.".to_owned(),
				"Replace the tree rows with TreeRow once its indent reads the token.".to_owned(),
			],
		},
	]
}

/// The same state with the terminal drawer open.
///
/// Separate from `populated` because the drawer takes its height from the
/// session column, so a state that opens it by default is a state where the
/// transcript is the thing being hidden.
pub fn with_drawer() -> ShellState {
	ShellState {
		drawer: Some(vec![
			"$ cargo test -p veyyon-desktop-surface".to_owned(),
			"   Compiling veyyon-desktop-surface v1.3.0".to_owned(),
			"    Finished `test` profile in 41.02s".to_owned(),
			"test the_shell_draws_its_regions_where_the_tokens_put_them ... ok".to_owned(),
		]),
		..populated()
	}
}
