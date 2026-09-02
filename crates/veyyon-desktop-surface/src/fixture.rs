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

use veyyon_desktop_model::InputModality;

use crate::{
	composer::{
		ComposerState, ContextMeter, ModelChoice, ModelControl, ModelOption, ThinkingControl,
	},
	drawer::{DrawerContent, DrawerTab},
	model::{Badge, Block, Card, ConnectionPhase, Row, Section, ShellState, Turn},
	right_panel::{DiffFile, DiffRow, PanelContent, PanelTab, TreeContent, TreeRowItem},
	terminal::{Cell, CellStyle, Ink},
};

/// Builds a shell state exercising every section, badge and block kind.
pub fn populated() -> ShellState {
	ShellState {
		title: "veyyon-desktop-surface".to_owned(),
		sections: vec![
			(Section::Unsent, vec![Row {
				id:       1,
				title:    "Split the oversized loader files".to_owned(),
				subtitle: "veyyon/crates/veyyon-desktop-tokens".to_owned(),
				badge:    None,
				meta:     None,
			}]),
			(Section::Pinned, vec![Row {
				id:       2,
				title:    "Reach the headless renderer and prove it deterministic".to_owned(),
				subtitle: "veyyon/crates/veyyon-desktop-scene".to_owned(),
				badge:    Some(Badge::Approval),
				meta:     Some("4m".to_owned()),
			}]),
			(Section::Live, vec![
				Row {
					id:       3,
					title:    "Build the queue, transcript and composer surfaces".to_owned(),
					subtitle: "veyyon/crates/veyyon-desktop-surface".to_owned(),
					badge:    Some(Badge::Working),
					meta:     Some("12m".to_owned()),
				},
				Row {
					id:       4,
					title:    "Per-corner radii on a single quad, at both device ratios".to_owned(),
					subtitle: "zed/crates/gpui".to_owned(),
					badge:    Some(Badge::Watching),
					meta:     Some("31m".to_owned()),
				},
				Row {
					id:       5,
					title:    "Which providers carry the premium multiplier".to_owned(),
					subtitle: "veyyon/packages/catalog".to_owned(),
					badge:    Some(Badge::Input),
					meta:     Some("2m".to_owned()),
				},
				Row {
					id:       6,
					title:    "Close the fail-open colour fallback in the kit".to_owned(),
					subtitle: "veyyon/crates/veyyon-desktop-kit".to_owned(),
					badge:    Some(Badge::Plan),
					meta:     Some("8m".to_owned()),
				},
			]),
			(Section::Deferred, vec![
				Row {
					id:       7,
					title:    "Regenerate the contact sheet after the truncation fix".to_owned(),
					subtitle: String::new(),
					badge:    Some(Badge::Due),
					meta:     Some("09:00".to_owned()),
				},
				Row {
					id:       8,
					title:    "Backdrop blur that samples the framebuffer".to_owned(),
					subtitle: String::new(),
					badge:    None,
					meta:     Some("Thu".to_owned()),
				},
			]),
			// Longer than the page size, so the rail's overflow row is drawn.
			(Section::Parked, parked_rows()),
		],
		transcript: transcript(),
		turn: crate::composer::TurnPhase::Idle,
		composer: fixture_composer(),
		run_status: Some((
			Badge::Working,
			"Rendering the shell headless at 1440x900, one frame per section".to_owned(),
		)),
		panel: fixture_panel(),
		cards: cards(),
		drawer: DrawerContent::default(),
		drawer_open: false,
		// The row the queue draws as open, and the session the titlebar names.
		current_id: 3,
		connection: ConnectionPhase::Attached,
		..ShellState::default()
	}
}

/// A footer with every control the host can report: a model the operator
/// can change, a thinking level with somewhere to go, and a context meter.
fn fixture_composer() -> ComposerState {
	let sonnet =
		ModelChoice { provider: "anthropic".to_owned(), model: "claude-sonnet-4.5".to_owned() };
	let opus =
		ModelChoice { provider: "anthropic".to_owned(), model: "claude-opus-4.1".to_owned() };
	ComposerState {
		model: Some(ModelControl {
			current:    Some(sonnet.clone()),
			options:    vec![
				ModelOption {
					choice:    sonnet,
					name:      "Claude Sonnet 4.5".to_owned(),
					reasoning: true,
					input:     vec![InputModality::Text, InputModality::Image],
				},
				ModelOption {
					choice:    opus,
					name:      "Claude Opus 4.1".to_owned(),
					reasoning: true,
					input:     vec![InputModality::Text, InputModality::Image],
				},
			],
			selectable: true,
		}),
		thinking: Some(ThinkingControl {
			level:  "high".to_owned(),
			levels: ["off", "low", "medium", "high"].map(str::to_owned).to_vec(),
		}),
		context: Some(ContextMeter { used_tokens: 82_400, limit_tokens: Some(200_000) }),
		..ComposerState::default()
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
		.enumerate()
		.map(|(index, title)| Row {
			// Ids continue past the sections above, because a row's identity is
			// the session's, and two rows sharing one is two rows the queue
			// cannot tell apart when one is clicked.
			id:       PARKED_FIRST_ID + index as u64,
			title:    title.to_owned(),
			subtitle: String::new(),
			badge:    None,
			meta:     None,
		})
		.collect()
}

/// The first id the parked list uses, past every row above it.
const PARKED_FIRST_ID: u64 = 9;

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

/// A populated fixture panel.
// A one-span intraline list is deliberate: the field holds every changed span
// and this fixture row changes one.
#[allow(
	clippy::single_range_in_vec_init,
	reason = "a one-span intraline list is deliberate: the field holds every changed span"
)]
fn fixture_panel() -> PanelContent {
	PanelContent {
		tabs:       vec![PanelTab::Diff, PanelTab::File, PanelTab::Tree],
		active_tab: PanelTab::Diff,
		diff:       vec![DiffFile {
			path:      "crates/veyyon-desktop-surface/src/panel.rs".to_string(),
			old_path:  None,
			status:    veyyon_desktop_model::ChangeStatus::Modified,
			additions: 12,
			deletions: 3,
			rows:      vec![
				DiffRow::HunkHeader {
					old_start: 1,
					old_count: 5,
					new_start: 1,
					new_count: 6,
					symbol:    Some("pub fn right_panel".to_string()),
				},
				DiffRow::Context {
					old_line: 1,
					new_line: 1,
					text:     "use veyyon_desktop_kit::TokenSet;".to_string(),
				},
				DiffRow::Removed {
					old_line:  2,
					text:      "fn old_tab_strip() {".to_string(),
					intraline: Vec::from([3..6]),
				},
				DiffRow::Added {
					new_line:  2,
					text:      "fn new_tab_strip() {".to_string(),
					intraline: Vec::from([3..6]),
				},
				DiffRow::Context { old_line: 3, new_line: 3, text: "}".to_string() },
			],
		}],
		file:       None,
		tree:       TreeContent {
			rows:           vec![
				TreeRowItem {
					path:        "crates".to_string(),
					name:        "crates".to_string(),
					depth:       0,
					is_dir:      true,
					is_expanded: true,
					changed:     None,
				},
				TreeRowItem {
					path:        "crates/veyyon-desktop-surface".to_string(),
					name:        "veyyon-desktop-surface".to_string(),
					depth:       1,
					is_dir:      true,
					is_expanded: true,
					changed:     None,
				},
				TreeRowItem {
					path:        "crates/veyyon-desktop-surface/src/panel.rs".to_string(),
					name:        "panel.rs".to_string(),
					depth:       2,
					is_dir:      false,
					is_expanded: false,
					changed:     Some((12, 3)),
				},
			],
			selected_path:  None,
			expanded_paths: std::collections::BTreeSet::new(),
		},
		diff_mode:  veyyon_desktop_model::DiffMode::Unified,
	}
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
	let mut grid_rows = Vec::new();
	for line_str in [
		"$ cargo test -p veyyon-desktop-surface",
		"   Compiling veyyon-desktop-surface v1.3.0",
		"    Finished `test` profile in 41.02s",
		"test the_shell_draws_its_regions_where_the_tokens_put_them ... ok",
	] {
		let mut row = Vec::new();
		for c in line_str.chars() {
			row.push(Cell {
				c,
				ink: Ink::Default,
				bg_ink: Ink::Default,
				style: CellStyle::new(),
				width: 1,
			});
		}
		while row.len() < 80 {
			row.push(Cell::blank());
		}
		grid_rows.push(row);
	}
	while grid_rows.len() < 11 {
		grid_rows.push(vec![Cell::blank(); 80]);
	}

	ShellState {
		drawer: DrawerContent {
			tabs: vec![DrawerTab::Terminal {
				id:    "term-1".to_string(),
				title: "Terminal".to_string(),
			}],
			active_tab: 0,
			grid_rows,
			cursor_col: 0,
			cursor_row: 4,
			cursor_visible: true,
			title: "Terminal".to_string(),
			scroll_offset: 0,
			processes: Vec::new(),
			selection: None,
			search: None,
		},
		drawer_open: true,
		..populated()
	}
}
