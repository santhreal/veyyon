//! How the autoswarm console is drawn: the swarm on the branch, the setup
//! rows with the preset controls beside theirs, the notes under them, the
//! actions the swarm's state allows and the run ledger.

use std::fmt::Write as _;

use gpui::{AnyElement, Context, Div, SharedString, Window, div, prelude::*, relative};
use veyyon_desktop_model::{
	AutoswarmConsoleView, AutoswarmFieldKind, AutoswarmFieldView, AutoswarmRunView, HostActionKind,
};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton, Toggle, Tooltip},
	icons::IconName,
	theme::{ActiveTheme, TypeStyled, radius, space, text},
};

use super::{
	InteractionDock,
	console::{offers_delete, stepped},
	row::body_max,
};

/// The share of the console's width a row's label takes.
const LABEL_SHARE: f32 = 0.3;

impl InteractionDock {
	/// The console card, or `None` while the shown session has none open.
	pub(super) fn render_console(&self, window: &Window, cx: &Context<Self>) -> Option<AnyElement> {
		let session = self.session.as_ref()?;
		let app = self.app.read(cx);
		let console = app.autoswarm_console(session)?;
		let blocked = app.refusal(HostActionKind::RunAutoswarmAction);
		let palette = cx.theme().palette;
		let title = console
			.swarm
			.as_ref()
			.and_then(|swarm| swarm.name.clone().or_else(|| swarm.branch.clone()))
			.map_or_else(|| "Autoswarm".to_owned(), |name| format!("Autoswarm · {name}"));
		let header = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.child(
				div()
					.flex_1()
					.min_w_0()
					.truncate()
					.type_style(text::UI_MEDIUM)
					.text_color(palette.text.primary)
					.child(title),
			)
			.child(
				Button::new("dock-console-close", "Close")
					.variant(ButtonVariant::Ghost)
					.size(ButtonSize::Sm)
					.disabled(blocked.is_some())
					.on_click(cx.listener(|this, _, _, cx| this.close_console(cx))),
			);
		let swarm = match &console.swarm {
			Some(swarm) => {
				let mut line = format!("{} · {} runs", swarm.goal, swarm.runs);
				if let Some(best) = &swarm.best {
					let _ = write!(line, " · best {best}");
				}
				if let Some(running) = &swarm.running {
					let _ = write!(line, " · measuring {running}");
				}
				line
			},
			None => "No swarm is recorded on this branch. Start one to log a run.".to_owned(),
		};
		let setup = if console.is_read_only() {
			vec![muted("This console reads the swarm. Run /autoresearch to change its setup.", cx)]
		} else {
			self.render_setup(console, blocked.is_some(), cx)
		};
		let body = div()
			.id("dock-console-body")
			.max_h(body_max(window))
			.overflow_y_scroll()
			.flex()
			.flex_col()
			.gap(space::S2)
			.children(setup)
			.child(self.render_ledger(&console.runs, cx));
		Some(
			div()
				.id("dock-console")
				.flex()
				.flex_col()
				.gap(space::S2)
				.p(space::S3)
				.rounded(radius::XL)
				.border_1()
				.border_color(palette.border.default)
				.bg(palette.bg.surface)
				.type_style(text::SMALL)
				.text_color(palette.text.secondary)
				.child(header)
				.child(div().text_color(palette.text.muted).child(swarm))
				.children(blocked.map(|reason| div().text_color(palette.status.error).child(reason)))
				.child(body)
				.into_any_element(),
		)
	}

	/// The rows, the notes under them and the actions.
	fn render_setup(
		&self,
		console: &AutoswarmConsoleView,
		blocked: bool,
		cx: &Context<Self>,
	) -> Vec<AnyElement> {
		let palette = cx.theme().palette;
		let mut out: Vec<AnyElement> = console
			.fields
			.iter()
			.enumerate()
			.map(|(index, field)| {
				let saves = console.save_field.as_deref() == Some(field.id.as_str());
				let label = div()
					.id(("dock-console-label", index))
					.flex_none()
					.w(relative(LABEL_SHARE))
					.truncate()
					.text_color(palette.text.muted)
					.tooltip(Tooltip::text(field.hint.clone()))
					.child(field.label.clone());
				div()
					.flex()
					.items_center()
					.gap(space::S2)
					.min_h(space::S8)
					.child(label)
					.child(self.render_control(index, field, saves, blocked, cx))
					.into_any_element()
			})
			.collect();
		out.extend(
			console
				.notes
				.iter()
				.map(|note| muted(note.text.clone(), cx)),
		);
		let actions = console.actions.iter().enumerate().map(|(index, action)| {
			let run = action.action;
			let variant = if action.primary {
				ButtonVariant::Primary
			} else {
				ButtonVariant::Secondary
			};
			let button = Button::new(("dock-console-action", index), action.label.clone())
				.variant(variant)
				.size(ButtonSize::Sm)
				.disabled(blocked || action.blocker.is_some())
				.on_click(cx.listener(move |this, _, _, cx| this.run_console_action(run, cx)));
			let tip = action
				.blocker
				.clone()
				.unwrap_or_else(|| action.verb.clone());
			div()
				.id(("dock-console-action-tip", index))
				.tooltip(Tooltip::text(tip))
				.child(button)
		});
		out.push(
			div()
				.flex()
				.flex_wrap()
				.gap(space::S2)
				.children(actions)
				.into_any_element(),
		);
		if let Some(blocker) = console
			.primary()
			.and_then(|primary| primary.blocker.clone())
		{
			out.push(muted(blocker, cx));
		}
		out
	}

	/// The control row `field` draws, by its kind, and the value the console
	/// states beside it.
	fn render_control(
		&self,
		index: usize,
		field: &AutoswarmFieldView,
		saves: bool,
		blocked: bool,
		cx: &Context<Self>,
	) -> AnyElement {
		let palette = cx.theme().palette;
		let row = div()
			.flex()
			.flex_1()
			.min_w_0()
			.items_center()
			.gap(space::S2);
		let id = field.id.clone();
		match field.kind {
			AutoswarmFieldKind::Text => {
				let editor = self.console.editor(&field.id).cloned();
				let input = div()
					.flex_1()
					.min_w_0()
					.px(space::S2)
					.py(space::S1)
					.rounded(radius::MD)
					.border_1()
					.border_color(palette.border.default)
					.bg(palette.bg.app)
					.children(editor);
				row.child(input)
					.when(saves, |row| {
						row.child(
							Button::new("dock-console-save", "Save preset")
								.size(ButtonSize::Sm)
								.disabled(blocked)
								.on_click(cx.listener(move |this, _, _, cx| this.save_preset(&id, cx))),
						)
					})
					.into_any_element()
			},
			AutoswarmFieldKind::Stepper => {
				let (down, up) = (stepped(field, -1).is_none(), stepped(field, 1).is_none());
				let (less, more) = (field.clone(), field.clone());
				row.child(
					Button::new(("dock-console-less", index), "−")
						.size(ButtonSize::Sm)
						.disabled(blocked || down)
						.on_click(cx.listener(move |this, _, _, cx| this.step_field(&less, -1, cx))),
				)
				.child(
					div()
						.text_color(palette.text.primary)
						.child(field.display.clone()),
				)
				.child(
					Button::new(("dock-console-more", index), "+")
						.size(ButtonSize::Sm)
						.disabled(blocked || up)
						.on_click(cx.listener(move |this, _, _, cx| this.step_field(&more, 1, cx))),
				)
				.into_any_element()
			},
			AutoswarmFieldKind::Toggle => {
				let set = cx.listener(move |this, on: &bool, _, cx| {
					this.set_field(&id, None, None, Some(*on), cx);
				});
				row.child(
					Toggle::new(("dock-console-toggle", index), field.on.unwrap_or(false))
						.disabled(blocked)
						.on_change(move |on, window, cx| set(&on, window, cx)),
				)
				.child(
					div()
						.text_color(palette.text.muted)
						.child(field.display.clone()),
				)
				.into_any_element()
			},
			AutoswarmFieldKind::Segmented => {
				let options = field.options.iter().enumerate().map(|(at, option)| {
					let (id, value) = (id.clone(), option.value.clone());
					let variant = if option.selected {
						ButtonVariant::Secondary
					} else {
						ButtonVariant::Ghost
					};
					Button::new(("dock-console-option", at), option.label.clone())
						.variant(variant)
						.size(ButtonSize::Sm)
						.disabled(blocked)
						.on_click(cx.listener(move |this, _, _, cx| {
							this.set_field(&id, Some(value.clone()), None, None, cx);
						}))
				});
				div()
					.id(("dock-console-options", index))
					.flex()
					.flex_1()
					.min_w_0()
					.flex_wrap()
					.items_center()
					.gap(space::S1)
					.children(options)
					.when(offers_delete(field), |row| {
						row.child(
							IconButton::new("dock-console-delete", IconName::Trash2)
								.tooltip("Delete this preset")
								.disabled(blocked)
								.on_click(cx.listener(|this, _, _, cx| this.delete_preset(cx))),
						)
					})
					.into_any_element()
			},
		}
	}

	/// The runs logged so far, newest first; a click opens a run's detail.
	fn render_ledger(&self, runs: &[AutoswarmRunView], cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let heading = div().text_color(palette.text.primary).child("Runs");
		if runs.is_empty() {
			return div()
				.flex()
				.flex_col()
				.gap(space::S1)
				.child(heading)
				.child(muted("No run has been logged. Start the swarm to measure one.", cx))
				.into_any_element();
		}
		let rows = runs.iter().enumerate().map(|(index, run)| {
			let open = self.console.open_run == Some(index);
			let mut line = run.label.clone();
			if let Some(arm) = &run.arm {
				let _ = write!(line, " · {arm}");
			}
			let _ = write!(line, " · {}", run.metric);
			if let Some(delta) = &run.delta {
				let _ = write!(line, " ({delta})");
			}
			let ink = if run.best {
				palette.status.success
			} else {
				palette.text.secondary
			};
			div()
				.id(("dock-console-run", index))
				.flex()
				.flex_col()
				.px(space::S2)
				.py(space::S1)
				.rounded(radius::MD)
				.cursor_pointer()
				.hover(|style| style.bg(palette.bg.hover))
				.on_click(cx.listener(move |this, _, _, cx| this.toggle_run(index, cx)))
				.child(
					div()
						.flex()
						.gap(space::S2)
						.child(
							div()
								.flex_1()
								.min_w_0()
								.truncate()
								.text_color(ink)
								.child(line),
						)
						.child(
							div()
								.flex_none()
								.text_color(palette.text.muted)
								.child(run.outcome.clone()),
						),
				)
				.when(open, |row| {
					row.children(run.detail.iter().map(|detail| muted(detail.clone(), cx)))
				})
		});
		div()
			.flex()
			.flex_col()
			.gap(space::S0_5)
			.child(heading)
			.children(rows)
			.into_any_element()
	}
}

/// A muted line of the console.
fn muted(copy: impl Into<SharedString>, cx: &Context<InteractionDock>) -> AnyElement {
	let line: Div = div()
		.text_color(cx.theme().palette.text.muted)
		.child(copy.into());
	line.into_any_element()
}
