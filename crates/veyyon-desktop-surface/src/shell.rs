//! The shell: the window's titlebar and its layout regions (§4.2).
//!
//! The shell decides only where the regions go. It draws no content of its own
//! beyond the titlebar and the attention strip, so a region can be replaced
//! without touching layout, and layout can change without touching a region.
//!
//! Three columns, one row of chrome above them. The queue and the right panel
//! are fixed measures that give way to the middle, because the middle is the
//! surface being read; a window that gets narrower takes width from the panels
//! and leaves the transcript's line length alone.

use veyyon_desktop_kit::{ColorRole, SpacingStep, StrokeStep, TextRamp, TextWeight, TokenSet};
use veyyon_desktop_tokens::ShellSurfaceTokens;
use veyyon_gpui::{Context, Div, IntoElement, ParentElement, Render, Styled, Window, div, px};

use crate::{
	cards::card_stack,
	composer::{composer, opening_line, run_bar},
	drawer::terminal_drawer,
	model::ShellState,
	panel::right_panel,
	queue::queue_rail,
	tokens::InstalledTokens,
	transcript::transcript_column,
};

/// The window's root view.
pub struct ShellView {
	installed: InstalledTokens,
	state:     ShellState,
	notice:    Option<String>,
}

impl ShellView {
	/// Builds the root view from an installed token set and a state to draw.
	pub const fn new(installed: InstalledTokens, state: ShellState) -> Self {
		Self { installed, state, notice: None }
	}

	/// Replaces the token set, after a reload applied a new one.
	pub fn set_tokens(&mut self, installed: InstalledTokens) {
		self.installed = installed;
	}

	/// Replaces the state to draw.
	pub fn set_state(&mut self, state: ShellState) {
		self.state = state;
	}

	/// Sets or clears the attention strip's message.
	///
	/// A reload that failed keeps the last good token set and reports the
	/// failure here, so the window stays usable and the operator still learns
	/// that the file they just saved was rejected.
	pub fn set_notice(&mut self, notice: Option<String>) {
		self.notice = notice;
	}
}

impl Render for ShellView {
	fn render(&mut self, window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let tokens = &self.installed.set;
		let surface = &self.installed.surface;

		let mut root = div()
			.flex()
			.flex_col()
			.size_full()
			.bg(tokens.color(ColorRole::Ground))
			.text_color(tokens.color(ColorRole::Foreground))
			.overflow_hidden()
			.child(titlebar(&self.state.title, &surface.shell, tokens));

		if let Some(notice) = &self.notice {
			root = root.child(attention_strip(notice, tokens));
		}

		root.child(
			div()
				.flex()
				.flex_row()
				.w_full()
				.flex_1()
				.overflow_hidden()
				.child(queue_rail(&self.state.sections, &surface.queue, tokens))
				.child(session_surface(&self.state, &self.installed))
				.children((!self.state.tree.is_empty()).then(|| {
					// The panel's default width is what it takes when there is
					// room. On a narrow window it takes a share of the viewport
					// instead, because a fixed panel plus a fixed queue leaves
					// the transcript with whatever is left, and what is left is
					// the surface being read.
					let viewport = f32::from(window.viewport_size().width);
					let panels = &surface.panels;
					let width = panels
						.right_panel_default_width_px
						.min(viewport * panels.right_panel_max_viewport_ratio)
						.max(panels.right_panel_min_width_px);
					right_panel(
						&self.state.tabs,
						self.state.active_tab,
						&self.state.tree,
						width,
						panels,
						tokens,
					)
				})),
		)
	}
}

/// The titlebar: window controls, then the open session's name.
fn titlebar(title: &str, geometry: &ShellSurfaceTokens, tokens: &TokenSet) -> Div {
	let mut controls = div()
		.flex()
		.flex_row()
		.items_center()
		.flex_shrink_0()
		.gap(px(geometry.titlebar_control_gap_px));

	// Three controls, drawn as the ground they sit on lightened by the
	// hairline role. They are geometry here, not behaviour: the window manager
	// owns the actions, and the shell owns only the space they occupy.
	for _ in 0..3 {
		controls = controls.child(
			div()
				.w(px(geometry.titlebar_control_px))
				.h(px(geometry.titlebar_control_px))
				.rounded_full()
				.bg(tokens.color(ColorRole::Hairline)),
		);
	}

	div()
		.h(px(geometry.titlebar_height_px))
		.w_full()
		.flex_shrink_0()
		.flex()
		.flex_row()
		.items_center()
		.pl(px(geometry.titlebar_inset_left_px))
		.pr(px(geometry.titlebar_inset_right_px))
		.border_b(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.overflow_hidden()
		.child(controls)
		.child(
			div()
				.flex_1()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_center()
				.text_size(tokens.font_size(TextRamp::Small))
				.line_height(tokens.line_height(TextRamp::Small))
				.font_weight(tokens.font_weight(TextWeight::Medium))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(title.to_owned()),
		)
}

/// The attention strip: one line, above everything, that something is wrong.
fn attention_strip(notice: &str, tokens: &TokenSet) -> Div {
	let tint = tokens.tint(veyyon_desktop_kit::TintRole::Error);

	div()
		.w_full()
		.flex_shrink_0()
		.px(tokens.spacing(SpacingStep::S3))
		.py(tokens.spacing(SpacingStep::S1))
		.bg(tint.fill)
		.overflow_hidden()
		.whitespace_nowrap()
		.truncate()
		.text_size(tokens.font_size(TextRamp::Micro))
		.line_height(tokens.line_height(TextRamp::Micro))
		.text_color(tint.ink)
		.child(notice.to_owned())
}

/// The middle column: the transcript, the composer and the run bar.
fn session_surface(state: &ShellState, installed: &InstalledTokens) -> Div {
	let tokens = &installed.set;
	let surface = &installed.surface;

	// The transcript is anchored to the bottom of its region, so a short run
	// sits against the composer rather than stranded at the top of the window,
	// and a long run keeps its most recent end visible.
	//
	// A long run's older turns are clipped rather than scrolled. This fork
	// exposes no scroll on a plain container, so scrolling needs the
	// virtualized transcript list, which is not built yet; until it is, the
	// region shows the tail and nothing reaches the turns above it.
	let mut body = div()
		.flex()
		.flex_col()
		.justify_end()
		.w_full()
		.flex_1()
		.overflow_hidden()
		.px(tokens.spacing(SpacingStep::S4))
		.pt(tokens.spacing(SpacingStep::S4));

	body = if state.transcript.is_empty() {
		body.justify_center().child(opening_line(
			"What should this session do?",
			&surface.composer,
			tokens,
		))
	} else {
		body.child(transcript_column(
			&state.transcript,
			&surface.transcript,
			installed.user_turn_ground,
			tokens,
		))
	};

	div()
		.flex()
		.flex_col()
		.flex_1()
		.min_w_0()
		.h_full()
		.overflow_hidden()
		.gap(tokens.spacing(SpacingStep::S3))
		.pb(tokens.spacing(SpacingStep::S3))
		.child(body)
		.children((!state.cards.is_empty()).then(|| {
			// The stack shares the composer's measure and sits directly above
			// it, so a decision and the reply to it occupy one column.
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.flex()
				.flex_row()
				.justify_center()
				.child(
					div()
						.w_full()
						.max_w(px(surface.composer.max_width_px))
						.child(card_stack(&state.cards, &surface.attached_cards, tokens)),
				)
		}))
		.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.child(composer(&state.composed, &surface.composer, tokens)),
		)
		.child(
			div()
				.w_full()
				.px(tokens.spacing(SpacingStep::S4))
				.child(run_bar(state.run_status.clone(), &surface.composer, tokens)),
		)
		// The drawer docks at the bottom of the session column only, so the
		// queue and the right panel keep their full height beside it.
		.children(
			state
				.drawer
				.as_ref()
				.map(|lines| terminal_drawer(lines, &surface.panels, tokens)),
		)
}
