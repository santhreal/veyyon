//! One screen's worth of data for every [`RouteId`].
//!
//! A route with no fixture has never been drawn, and the sweep in this module's
//! tests is what says so. That matters more here than anywhere else in the
//! crate: a route is reachable from the window's own argument parsing, so a
//! route without data is a screen an operator can open and find blank.

use crate::{
	screen::{
		Board, BoardCard, BoardColumn, Control, Field, FieldOrigin, Form, FormGroup, NodeState,
		PickList, PickRow, Report, ReportSection, ReportStat, Route, RouteId, Splash, StepState,
		Tree, TreeNode, Wizard, WizardStep,
	},
	view::{Badge, Diff, DiffFile, DiffHunk, DiffLine, Markdown, Table, TableRow, Tone, View},
};

/// The route `id` names, with data in it.
pub fn route(id: RouteId) -> Route {
	match id {
		RouteId::Session => Route::Session,
		RouteId::Pick => Route::Pick(model_picker()),
		RouteId::Form => Route::Form(settings()),
		RouteId::Board => Route::Board(todo_board()),
		RouteId::Report => Route::Report(usage()),
		RouteId::Tree => Route::Tree(file_tree()),
		RouteId::Splash => Route::Splash(welcome()),
		RouteId::Wizard => Route::Wizard(setup()),
		RouteId::Diff => Route::Diff(change()),
	}
}

/// Every route, in [`RouteId::ALL`] order.
pub fn routes() -> Vec<Route> {
	RouteId::ALL.into_iter().map(route).collect()
}

/// A list chosen from: the model picker, with a row already checked, a row that
/// is not available, and a filter narrowing the list.
pub fn model_picker() -> PickList {
	PickList::new("Model", vec![
		PickRow::new("claude-sonnet-4-6", "claude-sonnet-4-6")
			.detail("anthropic · 200k context")
			.badge(Badge::new("current", Tone::Accent))
			.checked(),
		PickRow::new("gpt-5.2-codex", "gpt-5.2-codex")
			.detail("openai · 400k context")
			.badge(Badge::plain("reasoning")),
		PickRow::new("gemini-3-pro", "gemini-3-pro").detail("google · 1m context"),
		PickRow::new("grok-code-fast-2", "grok-code-fast-2")
			.detail("xai · no key configured")
			.badge(Badge::new("unavailable", Tone::Warn))
			.disabled(),
	])
	.query("g")
	.highlight(1)
}

/// A form: settings, with a value from more than one origin, a masked field,
/// and a field hidden behind a toggle that is off.
pub fn settings() -> Form {
	Form::new("Settings", vec![
		FormGroup::new("Appearance", vec![
			Field::new("appearance.theme", "Theme", Control::Choice {
				options:  vec!["dark".to_owned(), "light".to_owned(), "birch".to_owned()],
				selected: 0,
			})
			.origin(FieldOrigin::Profile),
			Field::new("appearance.showImages", "Show images", Control::Toggle { on: true }),
			Field::new("appearance.readingWidth", "Reading width", Control::Number {
				value: 96.0,
				unit:  Some("columns".to_owned()),
				min:   Some(40.0),
				max:   Some(160.0),
			})
			.origin(FieldOrigin::Project)
			.help("Columns of prose before a line wraps."),
		]),
		FormGroup::new("Argot Shorthand", vec![
			Field::new("argot.enabled", "Argot Shorthand", Control::Toggle { on: false }),
			Field::new("argot.dictionaryBudget", "Dictionary budget", Control::Number {
				value: 2048.0,
				unit:  Some("tokens".to_owned()),
				min:   Some(0.0),
				max:   None,
			})
			.hidden(),
		]),
		FormGroup::new("Providers", vec![
			Field::new("providers.anthropic.key", "Anthropic key", Control::Text {
				value:       "sk-ant-0000000000000000".to_owned(),
				placeholder: String::new(),
				masked:      true,
			})
			.origin(FieldOrigin::Environment),
			Field::new("providers.anthropic.baseUrl", "Base URL", Control::Text {
				value:       String::new(),
				placeholder: "https://api.anthropic.com".to_owned(),
				masked:      false,
			}),
			Field::new("providers.anthropic.probe", "Test the connection", Control::Action {
				label:       "Send a request".to_owned(),
				destructive: false,
			}),
			Field::new("session.model", "Resolved model", Control::Reading {
				value: "claude-sonnet-4-6".to_owned(),
			})
			.origin(FieldOrigin::Session),
		]),
	])
	.focus(0, 2)
}

/// Cards in columns: the todo board, with an empty column and a card that
/// reports progress.
pub fn todo_board() -> Board {
	Board::new("Foundation", vec![
		BoardColumn::new("pending", vec![
			BoardCard::new("Capture every route").line("One frame per RouteId"),
			BoardCard::new("Wire the transport"),
		]),
		BoardColumn::new("in progress", vec![
			BoardCard::new("Draw every view kind")
				.line("13 kinds, one module each")
				.badge(Badge::new("active", Tone::Accent))
				.progress(0.45),
		]),
		BoardColumn::new("done", vec![
			BoardCard::new("Scaffold the workspace").badge(Badge::new("green", Tone::Ok)),
		]),
		BoardColumn::new("dropped", Vec::new()),
	])
}

/// Figures and rows: the usage report, with a total row, a prose section, and a
/// section with nothing in it.
pub fn usage() -> Report {
	Report::new("Usage", vec![
		ReportSection::new(vec![View::Table(Table::new(
			vec!["model".to_owned(), "turns".to_owned(), "tokens".to_owned(), "cost".to_owned()],
			vec![
				TableRow::new(vec![
					"claude-sonnet-4-6".to_owned(),
					"41".to_owned(),
					"1.2M".to_owned(),
					"$3.18".to_owned(),
				]),
				TableRow::new(vec![
					"gpt-5.2-codex".to_owned(),
					"7".to_owned(),
					"180k".to_owned(),
					"$0.44".to_owned(),
				]),
				TableRow::new(vec![
					"total".to_owned(),
					"48".to_owned(),
					"1.4M".to_owned(),
					"$3.62".to_owned(),
				])
				.emphasis(),
			],
		))])
		.heading("By model"),
		ReportSection::new(vec![View::Markdown(Markdown::new(
			"Cached reads are billed at a tenth of the input rate.",
		))])
		.heading("Notes"),
		ReportSection::new(Vec::new())
			.heading("Rate limits")
			.empty_text("None reached this session."),
	])
	.stat(ReportStat::new("Session", "$3.62"))
	.stat(ReportStat::new("Today", "$11.90"))
	.stat(ReportStat::new("Context", "62%").tone(Tone::Warn))
	.footer("Prices are the provider's published rates at the time of the turn.")
}

/// Nested rows: a file tree with an open branch, a closed one, and one whose
/// children are still being read.
pub fn file_tree() -> Tree {
	Tree::new("hosts/gui", vec![
		TreeNode::new(0, "contract", NodeState::Open),
		TreeNode::new(1, "src", NodeState::Open),
		TreeNode::new(2, "lib.rs", NodeState::Leaf).detail("3.4 kB"),
		TreeNode::new(2, "fixtures", NodeState::Closed).last(),
		TreeNode::new(1, "Cargo.toml", NodeState::Leaf)
			.detail("612 B")
			.last(),
		TreeNode::new(0, "views", NodeState::Closed),
		TreeNode::new(0, "shell", NodeState::Loading).last(),
	])
	.highlight(2)
}

/// A full-window statement: the welcome screen.
pub fn welcome() -> Splash {
	Splash::new("veyyon")
		.line("A coding agent that draws its own windows.")
		.key("enter", "start a session")
		.key("ctrl-p", "open a model")
		.key("ctrl-,", "settings")
		.key("ctrl-c", "quit")
}

/// Ordered steps: first-run setup, stopped on the step that was rejected.
pub fn setup() -> Wizard {
	Wizard::new(
		"Setup",
		vec![
			WizardStep::new("Pick a provider", StepState::Done),
			WizardStep::new("Add a key", StepState::Failed),
			WizardStep::new("Choose a model", StepState::Pending),
			WizardStep::new("Name the profile", StepState::Pending),
		],
		Form::new("Add a key", vec![FormGroup::new("Anthropic", vec![
			Field::new("key", "API key", Control::Text {
				value:       "sk-ant-000".to_owned(),
				placeholder: "sk-ant-…".to_owned(),
				masked:      true,
			})
			.help("The provider rejected this key: 401 from api.anthropic.com."),
		])])
		.focus(0, 0),
	)
}

/// Changed lines: an edited file, a rename, and a file whose body is not shown.
pub fn change() -> Diff {
	Diff::new("Route the window through a page map", vec![
		DiffFile::new("hosts/gui/shell/src/window.rs", vec![DiffHunk::new(
			"@@ -18,7 +18,9 @@",
			vec![
				DiffLine::context(18, 18, "use crate::chrome::row;"),
				DiffLine::removed(19, "use crate::transcript;"),
				DiffLine::added(19, "use crate::page;"),
				DiffLine::added(20, "use crate::transcript;"),
				DiffLine::context(20, 21, ""),
			],
		)]),
		DiffFile::renamed(
			"hosts/gui/shell/src/blocks.rs",
			"hosts/gui/shell/src/transcript.rs",
			vec![DiffHunk::new("@@ -1,3 +1,3 @@", vec![
				DiffLine::removed(1, "//! One card per transcript block."),
				DiffLine::added(1, "//! One card per transcript block, drawn from the view kinds."),
			])],
		),
		DiffFile::collapsed("assets/icon.png", "binary file"),
	])
	.footer("3 files changed")
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! A route is reachable from the window's own arguments, so a route with no
	//! data is a screen an operator opens and finds blank. The sweep is over
	//! [`RouteId::ALL`] rather than a list here, so adding a route turns this
	//! red until it has data, and [`route`] is exhaustive so it cannot compile
	//! without a decision either way.
	//!
	//! It also pins that the fixtures are not degenerate. A fixture that is a
	//! title and no rows draws a screen that looks finished and proves nothing,
	//! and the states a renderer has to handle — a disabled row, a hidden field,
	//! an empty column, a failed step, a branch still loading — are exactly the
	//! ones that go undrawn until something forces them into a frame.
	//!
	//! WHAT IT DOES NOT CATCH. Whether a screen reads well. That is a capture.

	use super::*;

	#[test]
	fn every_route_has_data() {
		for id in RouteId::ALL {
			assert_eq!(route(id).id(), id, "{} returned another route's data", id.key());
		}
		assert_eq!(routes().len(), RouteId::ALL.len());
	}

	#[test]
	fn every_fixture_screen_carries_more_than_a_title() {
		assert!(!model_picker().rows.is_empty());
		assert!(!settings().groups.is_empty());
		assert!(!todo_board().columns.is_empty());
		assert!(!usage().sections.is_empty());
		assert!(!file_tree().nodes.is_empty());
		assert!(!welcome().keys.is_empty());
		assert!(!setup().steps.is_empty());
		assert!(!change().files.is_empty());
	}

	#[test]
	fn the_picker_covers_the_row_states_a_renderer_draws() {
		let picker = model_picker();
		assert!(picker.rows.iter().any(|row| row.disabled), "no disabled row to draw");
		assert_eq!(picker.checked().count(), 1, "no checked row to draw");
		assert!(picker.highlighted().is_some(), "the highlight is past the last row");
		assert!(picker.query.is_some(), "no filter to draw");
	}

	#[test]
	fn the_settings_form_covers_every_control_and_more_than_one_origin() {
		let form = settings();
		let fields: Vec<&Field> = form
			.groups
			.iter()
			.flat_map(|group| group.fields.iter())
			.collect();

		let mut kinds: Vec<&str> = fields
			.iter()
			.map(|field| match field.control {
				Control::Toggle { .. } => "toggle",
				Control::Choice { .. } => "choice",
				Control::Text { .. } => "text",
				Control::Number { .. } => "number",
				Control::Action { .. } => "action",
				Control::Reading { .. } => "reading",
			})
			.collect();
		kinds.sort_unstable();
		kinds.dedup();
		assert_eq!(kinds, ["action", "choice", "number", "reading", "text", "toggle"]);

		assert!(fields.iter().any(|field| field.hidden), "no hidden field to skip");
		assert!(
			fields
				.iter()
				.any(|field| matches!(field.control, Control::Text { masked: true, .. })),
			"no masked field to redact"
		);

		let mut origins: Vec<FieldOrigin> = fields.iter().map(|field| field.origin).collect();
		origins.sort_by_key(|origin| origin.label());
		origins.dedup();
		assert!(origins.len() > 2, "every field claims the same origin");

		assert!(form.focused().is_some(), "the focus is past the last field");
		assert_eq!(form.visible_fields().count(), fields.len() - 1);
	}

	#[test]
	fn the_remaining_screens_cover_their_awkward_states() {
		assert!(
			todo_board()
				.columns
				.iter()
				.any(|column| column.cards.is_empty()),
			"no empty column"
		);
		assert!(
			usage()
				.sections
				.iter()
				.any(|section| section.empty.is_some()),
			"no empty section"
		);
		assert!(
			setup()
				.steps
				.iter()
				.any(|step| step.state == StepState::Failed),
			"no failed step to draw"
		);
		assert!(
			file_tree()
				.nodes
				.iter()
				.any(|node| node.state == NodeState::Loading),
			"no loading node to draw"
		);
		assert!(file_tree().highlighted().is_some(), "the highlight is past the last node");
		assert!(file_tree().max_depth() > 1, "a one-level tree does not exercise the gutter");
	}

	#[test]
	fn every_report_table_is_aligned() {
		for section in usage().sections {
			assert!(section.is_aligned(), "a fixture report section is a shifted table");
		}
	}

	#[test]
	fn the_diff_counts_what_its_lines_say() {
		let diff = change();
		assert_eq!(diff.totals(), (3, 2));
		assert!(diff.files.iter().any(|file| file.old_path.is_some()), "no renamed file to draw");
		assert!(diff.files.iter().any(|file| file.collapsed.is_some()), "no collapsed file to draw");
	}
}
