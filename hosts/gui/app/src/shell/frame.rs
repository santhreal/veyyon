//! One render transaction and its bounded wake scheduling.

use std::time::Duration;

use gpui::{
	App, Context, Focusable, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	MouseMoveEvent, ParentElement, Render, Styled, Window, div, prelude::FluentBuilder, px,
};
use veyyon_gui_core::{UiCommand, navigation::Route};
use veyyon_gui_features::{
	settings::SettingsSearch,
	shell::{self as feature_shell, LayoutPlan, PanelSizes, Placement, SurfaceRefs},
};
use veyyon_gui_kit::{
	motion::Wake,
	paint,
	theme::{Appearance, Theme, install_theme, layout, radius, set_base_font, size},
	ui::{Toast, Tone},
};

use super::{Panel, Shell};
use crate::chrome;

impl Focusable for Shell {
	fn focus_handle(&self, _: &App) -> gpui::FocusHandle {
		self.handles.focus.shell.clone()
	}
}

/// The names the frame declares for the route it is drawing.
///
/// A route-scoped binding needs a name on an element in the focus path, and the
/// frame is the only element every route has: a file tree that nothing focused
/// declares its context to nobody. `Shell` is always there so a chord that
/// applies on every route is written once.
///
/// A field's own name is nearer the keystroke than these, so the caret keeps
/// the arrow keys wherever a field holds the keyboard.
fn route_context(route: Route) -> &'static str {
	match route {
		Route::Conversation => "Shell Conversation",
		Route::Changes => "Shell Changes",
		Route::Files => "Shell Files",
		Route::Agents => "Shell Agents",
		Route::Settings(_) => "Shell Settings",
		Route::History => "Shell History",
	}
}

impl Render for Shell {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		// What a field's own event could not do for want of a window. A
		// subscription reaches no window at all, so the effects a submitted
		// field raised are executed here, before the frame reads the state they
		// change, and the keyboard is placed against the overlay stack the
		// store now holds however it came to hold it.
		let deferred = std::mem::take(&mut self.deferred_effects);
		if !deferred.is_empty() {
			self.perform_shell_effects(deferred, window, cx);
		}
		self.reconcile_the_keyboard(window, cx);
		// The palette is a preference and a live preview, and every token a
		// frame reads comes from `Theme::get`, so it is installed here rather
		// than at startup: set once when the process began, a reader who chose
		// another theme kept the old window with one row of the settings page
		// redrawn. The preview wins while the pointer is on a row, so leaving
		// the row restores the persisted choice on the next frame with no
		// second code path.
		let appearance = if self.store.frontend.preferences.dark {
			Appearance::Dark
		} else {
			Appearance::Light
		};
		let chosen = self
			.store
			.frontend
			.theme_preview
			.as_deref()
			.or(self.store.frontend.preferences.theme.as_deref());
		install_theme(chosen, appearance, cx);
		// Before anything reads a token: every metric that holds a glyph is a
		// function of this, so a frame that draws before it is installed draws
		// the previous size's rows around the new size's text.
		set_base_font(u32::from(self.store.frontend.preferences.font_size_milli_px));
		let reduced = cx.reduce_motion() || self.store.frontend.preferences.reduced_motion;
		self.now = paint::begin(reduced, cx);
		let viewport = window.viewport_size();
		let width = f32::from(viewport.width);
		let height = f32::from(viewport.height) - layout::titlebar();
		let before = self.store.frontend.panels.clone();
		let _ = self.store.dispatch(UiCommand::ConstrainPanels {
			width_milli_px:  (width * 1000.0) as u32,
			height_milli_px: (height * 1000.0) as u32,
		});
		if self.drag.is_some() && before != self.store.frontend.panels {
			self.cancel_panel_drag(cx);
		}

		let handles = &mut self.handles;
		let settings_search = SettingsSearch {
			settings:   &handles.editors.settings,
			models:     &handles.editors.models,
			providers:  &handles.editors.providers,
			mcp:        &handles.editors.mcp,
			extensions: &handles.editors.extensions,
		};
		let slots = feature_shell::compose(
			&self.store,
			SurfaceRefs {
				session_shelf:       &handles.session_shelf,
				session_search:      &handles.editors.sessions,
				timeline:            &handles.timeline,
				composer:            &handles.editors.composer,
				changes:             &handles.changes,
				changes_search:      &handles.editors.changes_search,
				changes_scroll:      &handles.scrolls.changes_tree,
				diff:                &handles.diff,
				files:               &mut handles.files,
				agents_search:       &handles.editors.agents,
				agents_scroll:       &handles.scrolls.agents_tree,
				agent_detail_scroll: &handles.scrolls.agent_detail,
				settings_search:     &settings_search,
				settings_scroll:     &handles.scrolls.settings,
				inspector_scroll:    &handles.scrolls.inspector,
				problems_search:     &handles.editors.problems,
				bottom_scroll:       &handles.scrolls.bottom,
				terminal:            handles.terminal.as_deref_mut(),
				output:              handles.output.as_deref_mut(),
			},
			window,
			cx,
		);
		// One sample per frame, shared by the placement, the body and the drag
		// seams: a seam that read the stored width would sit at the panel's
		// final edge while the panel itself was still on its way there.
		let sizes = PanelSizes::sample(&self.store.frontend.panels, cx);
		let plan = LayoutPlan::resolve(width, sizes);
		let body = feature_shell::render_body(&self.store, plan, sizes, slots, cx);
		let seams = self.seams(plan, sizes, width, height, cx);
		let drag_surface = self.drag_surface(cx);
		let toast = self.notice.as_ref().map(|notice| {
			div()
				.absolute()
				.right(px(layout::OVERLAY_MARGIN))
				.bottom(px(layout::OVERLAY_MARGIN))
				.child(
					Toast::new(
						"shell.notice",
						veyyon_gui_kit::motion::owner(
							veyyon_gui_kit::motion::OwnerNamespace::Shell,
							"notice",
							"global",
						),
						notice.clone(),
					)
					.tone(Tone::Warn),
				)
		});
		let overlay = self.render_overlay(cx);
		let theme = Theme::get(cx);
		let frame = div()
			.key_context(route_context(self.store.frontend.route))
			.track_focus(&self.handles.focus.shell)
			// The frame is focusable so a route that draws no field still answers
			// to a keystroke, and the toolkit moves focus to a focusable element
			// on press. Suppressing that here keeps a press on chrome from
			// taking the keyboard out of the field the reader is typing in: a
			// press that landed on a field has already moved focus and set this
			// same flag, so the only press this changes is one that hit nothing.
			.on_any_mouse_down(|_, window, _| window.prevent_default())
			.relative()
			.size_full()
			.flex()
			.flex_col()
			.bg(theme.ground)
			.text_color(theme.text)
			.text_size(px(size::body()))
			.font_family(theme.font_ui)
			.when(chrome::owns_frame(window), |element| {
				element.rounded(px(radius::SHEET)).overflow_hidden()
			})
			.on_action(cx.listener(Self::act))
			.child(chrome::titlebar(&self.store, window, cx))
			.child(body)
			.children(seams.into_iter().flatten())
			.children(toast)
			.children(drag_surface)
			.children(chrome::resize_edges(window))
			.children(overlay);
		match paint::finish(window, cx).wake {
			Wake::None => self.wake_at = None,
			Wake::NextVsync => {},
			Wake::At(deadline) => self.schedule_at(deadline, cx),
		}
		frame
	}
}

impl Shell {
	fn seams(
		&self,
		plan: LayoutPlan,
		sizes: PanelSizes,
		width: f32,
		height: f32,
		cx: &mut Context<Self>,
	) -> [Option<gpui::Stateful<gpui::Div>>; 3] {
		[
			matches!(plan.sidebar, Placement::Inline)
				.then(|| self.seam(Panel::Sidebar, layout::activity_rail() + sizes.sidebar, true, cx)),
			matches!(plan.inspector, Placement::Inline)
				.then(|| self.seam(Panel::Inspector, width - sizes.inspector, true, cx)),
			matches!(plan.bottom, Placement::Dock)
				.then(|| self.seam(Panel::Bottom, height - sizes.bottom, false, cx)),
		]
	}

	fn seam(
		&self,
		panel: Panel,
		at: f32,
		vertical: bool,
		cx: &mut Context<Self>,
	) -> gpui::Stateful<gpui::Div> {
		let mut seam = div()
			.id(match panel {
				Panel::Sidebar => "sidebar-seam",
				Panel::Inspector => "inspector-seam",
				Panel::Bottom => "bottom-seam",
			})
			.absolute()
			.bg(Theme::get(cx).stroke);
		seam = if vertical {
			seam
				.left(px(at - layout::HANDLE_HIT / 2.0))
				.top(px(layout::titlebar()))
				.bottom(px(0.0))
				.w(px(layout::HANDLE_HIT))
				.cursor_col_resize()
		} else {
			seam
				.left(px(layout::activity_rail()))
				.right(px(0.0))
				.top(px(layout::titlebar() + at - layout::HANDLE_HIT / 2.0))
				.h(px(layout::HANDLE_HIT))
				.cursor_row_resize()
		};
		seam.on_mouse_down(
			MouseButton::Left,
			cx.listener(move |shell, event: &MouseDownEvent, window, cx| {
				let position = if vertical {
					f32::from(event.position.x)
				} else {
					f32::from(event.position.y)
				};
				shell.begin_panel_drag(panel, position, window, cx);
			}),
		)
	}

	fn drag_surface(&self, cx: &mut Context<Self>) -> Option<gpui::Div> {
		let drag = self.drag?;
		Some(
			div()
				.absolute()
				.inset_0()
				.cursor(if matches!(drag.panel, Panel::Bottom) {
					gpui::CursorStyle::ResizeUpDown
				} else {
					gpui::CursorStyle::ResizeLeftRight
				})
				.on_mouse_move(
					cx.listener(|shell, event: &MouseMoveEvent, _, cx| shell.move_panel_drag(event, cx)),
				)
				.on_mouse_up(MouseButton::Left, cx.listener(|shell, _, _, cx| shell.end_panel_drag(cx)))
				.on_mouse_up_out(
					MouseButton::Left,
					cx.listener(|shell, _, _, cx| shell.cancel_panel_drag(cx)),
				),
		)
	}

	fn schedule_at(&mut self, deadline: u64, cx: &mut Context<Self>) {
		if self.wake_at == Some(deadline) {
			return;
		}
		self.wake_at = Some(deadline);
		let wait = deadline.saturating_sub(self.now);
		cx.spawn(async move |this, cx| {
			cx.background_executor()
				.timer(Duration::from_millis(wait))
				.await;
			let _ = this.update(cx, |shell, cx| {
				shell.wake_at = None;
				cx.notify();
			});
		})
		.detach();
	}
}
