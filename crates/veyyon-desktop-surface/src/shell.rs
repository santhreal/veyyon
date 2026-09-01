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

use veyyon_desktop_kit::{
	ColorRole, RadiusStep, SpacingStep, StrokeStep, TextRamp, TextWeight, TintRole, TokenSet,
};
use veyyon_desktop_tokens::ShellSurfaceTokens;
use veyyon_gpui::{
	Context, Div, InteractiveElement, IntoElement, ParentElement, Render,
	StatefulInteractiveElement, Styled, Window, div, px,
};

mod session;

use crate::{
	intent::{Intent, Intents},
	layout::{LabelState, RightPanelPlacement, ShedInput, shell_widths},
	model::ShellState,
	panel::right_panel,
	queue::queue_rail,
	shell::session::session_surface,
	tokens::InstalledTokens,
};

/// The window's root view.
pub struct ShellView {
	installed: InstalledTokens,
	state:     ShellState,
	notice:    Option<String>,
	intents:   Intents,
	/// What the last frame settled the composer's labels on. Carried because
	/// the decision has hysteresis, so it is a function of the previous frame
	/// as well as of this width (§5.4).
	labels:    LabelState,
}

impl ShellView {
	/// Builds the root view from an installed token set and a state to draw.
	pub fn new(installed: InstalledTokens, state: ShellState) -> Self {
		Self {
			installed,
			state,
			notice: None,
			intents: Intents::new(),
			labels: LabelState::default(),
		}
	}

	/// Replaces the token set, after a reload applied a new one.
	pub fn set_tokens(&mut self, installed: InstalledTokens) {
		self.installed = installed;
	}

	/// Replaces the state to draw.
	pub fn set_state(&mut self, state: ShellState) {
		self.state = state;
	}

	/// What the shell is currently drawing.
	pub const fn state(&self) -> &ShellState {
		&self.state
	}

	/// The state to draw, for a projection that rewrites the host-owned fields
	/// in place and leaves the window-owned ones alone.
	pub const fn state_mut(&mut self) -> &mut ShellState {
		&mut self.state
	}

	/// Sets or clears the attention strip's message.
	///
	/// A reload that failed keeps the last good token set and reports the
	/// failure here, so the window stays usable and the operator still learns
	/// that the file they just saved was rejected.
	pub fn set_notice(&mut self, notice: Option<String>) {
		self.notice = notice;
	}

	/// Applies what the operator did, and records what a host must answer.
	///
	/// Every surface reaches the state through here and through nothing else,
	/// so what an interaction does is decided in one place rather than in each
	/// click handler.
	pub fn dispatch(&mut self, intent: Intent) {
		self.intents.dispatch(intent, &mut self.state);
	}

	/// Takes the intents a host has not seen yet.
	pub fn drain_intents(&mut self) -> Vec<Intent> {
		self.intents.drain()
	}

	/// The intents recorded and not yet drained.
	pub fn pending(&self) -> &[Intent] {
		self.intents.pending()
	}
}

impl Render for ShellView {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// The shed runs first: it settles the label state this frame draws
		// with, and settling it needs `self` mutably, which the token borrows
		// below would prevent.
		//
		// The session column's horizontal inset is what separates the window
		// from the composer's measure, so the shed is told the same value the
		// column applies rather than deriving its own.
		let chrome_px = self.installed.surface.shell.titlebar_height_px
			+ if self.notice.is_some() {
				attention_strip_height(&self.installed.set)
			} else {
				0.0
			};
		let widths = shell_widths(
			ShedInput {
				viewport_px:        f32::from(window.viewport_size().width),
				viewport_height_px: f32::from(window.viewport_size().height),
				chrome_height_px:   chrome_px,
				gutter_px:          f32::from(self.installed.set.spacing(SpacingStep::S4)),
				panel_open:         !self.state.tree.is_empty(),
				labels:             self.labels,
			},
			&self.installed.surface,
		);
		self.labels = widths.labels;

		let tokens = &self.installed.set;
		let surface = &self.installed.surface;

		let mut root = div()
			.flex()
			.flex_col()
			.size_full()
			.bg(tokens.color(ColorRole::Ground))
			.text_color(tokens.color(ColorRole::Foreground))
			.overflow_hidden()
			.child(titlebar(&self.state.title, self.state.drawer_open, &surface.shell, tokens, cx));

		if let Some(notice) = &self.notice {
			root = root.child(attention_strip(notice, tokens));
		}

		let panels = &surface.panels;

		// The columns row is the overlay's positioning parent, so an overlaid
		// right panel covers the queue and the transcript and leaves the
		// titlebar and the attention strip reachable above it.
		let mut columns = div()
			.relative()
			.flex()
			.flex_row()
			.w_full()
			.flex_1()
			.overflow_hidden();

		// A collapsed rail is absent, not zero-width: a zero-width column still
		// draws its right border, leaving a hairline against the window edge
		// with nothing behind it.
		if let Some(queue_px) = widths.queue_px {
			columns = columns.child(queue_rail(
				&self.state.sections,
				self.state.current_id,
				queue_px,
				widths.columns_px,
				&surface.queue,
				tokens,
				cx,
			));
		}

		columns = columns.child(session_surface(&self.state, &widths, &self.installed, cx));

		let tree = &self.state.tree;
		let tabs = &self.state.tabs;
		let active_tab = self.state.active_tab;
		columns = match widths.right_panel {
			RightPanelPlacement::Absent => columns,
			RightPanelPlacement::Inline { width_px } => {
				columns.child(right_panel(tabs, active_tab, tree, width_px, panels, tokens, cx))
			},
			// The panel takes its width from the window rather than from the
			// transcript, over a blurred scrim stating that what it covers is
			// still there (§5.6).
			RightPanelPlacement::Overlay { width_px } => columns.child(
				div()
					.absolute()
					.inset_0()
					.flex()
					.flex_row()
					.justify_end()
					.backdrop_blur(px(panels.right_panel_overlay_scrim_blur_px))
					.bg(tokens.scrim())
					.child(right_panel(tabs, active_tab, tree, width_px, panels, tokens, cx)),
			),
		};

		root.child(columns)
	}
}

/// The titlebar: window controls, the open session's name, the drawer control.
fn titlebar(
	title: &str,
	drawer_open: bool,
	geometry: &ShellSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
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
		.child(drawer_control(drawer_open, geometry, tokens, cx))
}

/// The titlebar's drawer control (§4.1).
///
/// The control states the drawer's position rather than naming an action: it is
/// filled while the drawer is docked and hollow while it is not, so the
/// titlebar answers "is there a terminal open" without the operator opening it
/// to find out.
fn drawer_control(
	open: bool,
	geometry: &ShellSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let ground = if open {
		tokens.row_selected()
	} else {
		tokens.transparent()
	};
	let hover = tokens.row_hover();

	div()
		.id("titlebar-drawer")
		.on_click(cx.listener(|view, _event, _window, cx| {
			view.dispatch(Intent::ToggleDrawer);
			cx.notify();
		}))
		.hover(move |style| style.bg(hover))
		.flex_shrink_0()
		.w(px(geometry.titlebar_control_px))
		.h(px(geometry.titlebar_control_px))
		.rounded(tokens.radius(RadiusStep::Sm))
		.border(tokens.stroke(StrokeStep::Hairline))
		.border_color(tokens.color(ColorRole::Hairline))
		.bg(ground)
}

/// What the attention strip takes off the top of the window.
///
/// The strip is one line of micro text between two insets, so its height is
/// those three values and never a literal. The shed needs it to know what the
/// columns row is left with, and the strip and this must not drift apart.
fn attention_strip_height(tokens: &TokenSet) -> f32 {
	f32::from(tokens.spacing(SpacingStep::S1)) * 2.0 + f32::from(tokens.line_height(TextRamp::Micro))
}

/// The attention strip: one line, above everything, that something is wrong.
fn attention_strip(notice: &str, tokens: &TokenSet) -> Div {
	let tint = tokens.tint(TintRole::Error);

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
