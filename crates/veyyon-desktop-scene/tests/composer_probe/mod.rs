//! Probe rendering the shell states for composer and attached card measures.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
};

use veyyon_desktop_kit::TokenSet;
use veyyon_desktop_model::QueueMode;
use veyyon_desktop_scene::{Headless, headless::render_view};
use veyyon_desktop_surface::{
	Card, ShellView,
	composer::{
		Attachment, AttachmentSource, MediaType, Payload, TurnPhase, opening_line,
		preview::AttachmentPreview,
	},
	fixture, install_tokens,
	layout::{LabelState, ShedInput, shell_widths},
	model::{Badge, ShellState},
};
use veyyon_desktop_tokens::{ComposerSurfaceTokens, Tokens, load_bundled_theme};
use veyyon_gpui::{AppContext, Context, IntoElement, ParentElement, Render, Styled, Window};

use crate::dead_token_probe::{
	Observation, frame_observation,
	shell::{self, Seeded},
};

fn fixture_attachment() -> Attachment {
	Attachment {
		name:    "recording.mp4".to_owned(),
		source:  AttachmentSource::Path(PathBuf::from("recording.mp4")),
		media:   MediaType::Mp4,
		payload: Payload::Data(Arc::from(vec![0u8; 1024])),
		preview: AttachmentPreview::Video,
	}
}

fn draft_state() -> ShellState {
	let mut state = fixture::populated();
	state.composer.attachments = vec![fixture_attachment()];
	state.run_status =
		Some((Badge::Working, "Executing background verification sweep...".to_owned()));
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	state
}

fn opening_line_state() -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.current_id = 1;
	state
}
fn run_bar_state() -> ShellState {
	let mut state = fixture::populated();
	state.transcript.clear();
	state.cards.clear();
	state.run_status =
		Some((Badge::Working, "Executing background verification sweep...".to_owned()));
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	state
}

fn compact_state() -> ShellState {
	let mut state = fixture::populated();
	state.run_status =
		Some((Badge::Working, "Compact layout testing run bar and footer shedding".to_owned()));
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	state
}

fn hysteresis_state() -> ShellState {
	let mut state = fixture::populated();
	state.run_status =
		Some((Badge::Working, "Hysteresis band verification across label thresholds".to_owned()));
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	state
}

fn approval_state() -> ShellState {
	let mut state = fixture::populated();
	let mono_lines = (0..16)
		.map(|i| format!("$ execute_step_{i} --flag=arg_{i} /path/to/detail/pane/mono/file"))
		.collect::<Vec<_>>();
	state.cards = vec![Card::Approval {
		tool:   "tool_execution_with_long_name".to_owned(),
		detail: mono_lines,
	}];
	state
}

fn question_state() -> ShellState {
	let mut state = fixture::populated();
	state.cards = vec![Card::Question {
		prompt:  "Target configuration for build artifact:".to_owned(),
		options: vec![
			"Debug with symbols".to_owned(),
			"Release optimized".to_owned(),
			"Benchmark profile".to_owned(),
		],
	}];
	state
}

fn plan_state() -> ShellState {
	let mut state = fixture::populated();
	let markdown_lines = (0..30)
		.map(|i| format!("Step {i}: Apply architectural refactoring across component layers"))
		.collect::<Vec<_>>();
	state.cards = vec![Card::Plan {
		title: "Comprehensive architectural redesign plan".to_owned(),
		body:  markdown_lines,
	}];
	state
}

fn overflow_state() -> ShellState {
	let mut state = fixture::populated();
	state.cards = vec![
		Card::Approval {
			tool:   "primary_tool".to_owned(),
			detail: vec!["first approval detail".to_owned()],
		},
		Card::Question {
			prompt:  "Secondary prompt".to_owned(),
			options: vec!["Option A".to_owned(), "Option B".to_owned()],
		},
		Card::Plan {
			title: "Tertiary plan".to_owned(),
			body:  vec!["line 1".to_owned(), "line 2".to_owned()],
		},
	];
	state
}

struct LongOpeningLineView {
	geometry: ComposerSurfaceTokens,
	tokens:   TokenSet,
}

impl Render for LongOpeningLineView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		// The family the shell sets on its root, which every run inside it
		// inherits. Without it the run reaches GPUI as `.SystemUIFont`, which
		// resolves through a fallback carrying the default weight, and the
		// weight this line authors never reaches the raster.
		veyyon_gpui::div()
			.font_family(self.tokens.ui_family())
			.child(opening_line(
				"What should this session do when the operator presents a complex prompt designed to \
				 test the maximum width constraints of the composer opening line header?",
				&self.geometry,
				&self.tokens,
			))
	}
}

/// Observations for composer and attached card dead token sweeps.
pub fn observations(cx: &mut Headless, tokens: &Tokens) -> Vec<Observation> {
	let theme = load_bundled_theme("dark").expect("the bundled theme must load");

	let mut out = Vec::new();

	// 1. Render real multiline editor in the composer to cover radius_inner and
	//    growth cap.
	let draft_options = shell::wide();
	let draft_st = draft_state();
	let multiline = (0..25)
		.map(|i| format!("Line {i}: multiline draft text expanding composer to growth cap"))
		.collect::<Vec<_>>()
		.join("\n");
	let frame_theme = theme.clone();
	let frame_tokens = tokens.clone();
	let draft_frame = render_view(cx, &draft_options, move |_window, app| {
		let installed = install_tokens(app, &frame_tokens, &frame_theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|cx| {
			let mut view = ShellView::new(installed, draft_st);
			view.set_composed(multiline, cx);
			view
		})
	})
	.expect("multiline composer must render");
	out.push(frame_observation("composer_draft_multiline", &draft_frame));

	// 2. Render long opening line to test opening_line_max_width_px.
	let opening_theme = theme;
	let opening_tokens = tokens.clone();
	let opening_frame = render_view(cx, &draft_options, move |_window, app| {
		let installed = install_tokens(app, &opening_tokens, &opening_theme, Path::new("surface"))
			.expect("the bundled token set must install");
		let geometry = installed.surface.composer.clone();
		app.new(|_cx| LongOpeningLineView { geometry, tokens: installed.set })
	})
	.expect("long opening line must render");
	out.push(frame_observation("composer_long_opening_line", &opening_frame));

	// 3. Seeded shell states for cards and remaining surfaces.
	let seeded = vec![
		Seeded { name: "composer_run_bar", options: shell::wide(), state: run_bar_state() },
		Seeded {
			name:    "composer_opening_line",
			options: shell::wide(),
			state:   opening_line_state(),
		},
		Seeded {
			name:    "composer_narrow_compact",
			options: shell::sized(1200, 900),
			state:   compact_state(),
		},
		Seeded {
			name:    "composer_hysteresis",
			options: shell::sized(1280, 900),
			state:   hysteresis_state(),
		},
		Seeded { name: "cards_approval", options: shell::wide(), state: approval_state() },
		Seeded { name: "cards_question", options: shell::wide(), state: question_state() },
		Seeded { name: "cards_plan", options: shell::wide(), state: plan_state() },
		Seeded { name: "cards_overflow", options: shell::wide(), state: overflow_state() },
	];
	out.extend(shell::render(cx, tokens, seeded));

	// 4. Clutter ceilings on controls (footer_max_controls, run_bar_max_controls).
	assert!(5 <= tokens.surface.composer.footer_max_controls);
	assert!(4 <= tokens.surface.composer.run_bar_max_controls);
	out.push(Observation::Report {
		name: "surface.composer.footer_max_controls",
		text: format!("footer_max_controls:{}", tokens.surface.composer.footer_max_controls),
	});
	out.push(Observation::Report {
		name: "surface.composer.run_bar_max_controls",
		text: format!("run_bar_max_controls:{}", tokens.surface.composer.run_bar_max_controls),
	});

	// 5. Layout hysteresis and compact thresholds behavior.
	let surface = &tokens.surface;
	let c = &surface.composer;
	let swept_widths = || (400..=2400).step_by(8).map(|w| w as f32);
	let at = |viewport_px: f32, labels: LabelState| {
		shell_widths(
			ShedInput {
				viewport_px,
				viewport_height_px: 900.0,
				chrome_height_px: surface.shell.titlebar_height_px,
				gutter_px: 16.0,
				queue_collapsed: false,
				queue_float_open: false,
				queue_width: None,
				panel_open: true,
				panel_width: None,
				labels,
			},
			surface,
		)
	};

	if let Some(cross) = swept_widths().find(|&w| at(w, LabelState::default()).labels.footer) {
		let below = cross - 8.0;
		let shed_state = at(below, LabelState::default());
		assert!(!shed_state.labels.footer);

		let held = at(cross, shed_state.labels);
		assert!(!held.labels.footer);

		let restore_px = c.footer_compact_threshold_px + c.footer_hysteresis_px;
		let past = swept_widths().find(|&w| {
			surface.breakpoints.resolve(w).composer_footer_labels
				&& at(w, LabelState::default()).composer_px >= restore_px
		});
		if let Some(past) = past {
			let restored = at(past, held.labels);
			assert!(restored.labels.footer);
		}
	}

	if let Some(cross_rb) = swept_widths().find(|&w| at(w, LabelState::default()).labels.run_bar) {
		let below_rb = cross_rb - 8.0;
		let shed_rb = at(below_rb, LabelState::default());
		assert!(!shed_rb.labels.run_bar);
	}

	out.push(Observation::Report {
		name: "surface.composer.footer_hysteresis_px",
		text: format!("footer_hysteresis:{}", c.footer_hysteresis_px),
	});
	out.push(Observation::Report {
		name: "surface.composer.footer_compact_threshold_px",
		text: format!("footer_compact:{}", c.footer_compact_threshold_px),
	});
	out.push(Observation::Report {
		name: "surface.composer.run_bar_compact_threshold_px",
		text: format!("run_bar_compact:{}", c.run_bar_compact_threshold_px),
	});

	out
}
