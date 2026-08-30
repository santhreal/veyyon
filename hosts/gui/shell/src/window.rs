//! The window: a frame over a source, and the keys that reveal its regions.
//!
//! The shell holds a [`Source`] and which regions are open, and nothing else.
//! Every value it draws arrives as a [`veyyon_gui_contract`] type, which today
//! comes from that crate's fixtures and later from a session over a transport —
//! the shell cannot tell the difference, which is the point of building it
//! against the fixtures first.

use gpui::{
	App, Context, Div, FocusHandle, Focusable, InteractiveElement, IntoElement, KeyDownEvent,
	ParentElement, Render, Styled, Window, div,
};
use veyyon_gui_contract::{
	session::overlay::{DialogViewModel, SelectOption},
	source::Source,
};
use veyyon_gui_kit::{
	Level,
	chrome::{chip, column, row, well},
	surface,
	text::{caption, label, title},
	theme::ActiveTheme,
	tokens::{layout, radius, space, stroke},
};
use veyyon_gui_theme::Role;

use crate::{
	frame::{Chrome, Command, command, frame},
	page,
};

/// A window over one source.
pub struct Shell {
	source: Box<dyn Source>,
	chrome: Chrome,
	focus:  FocusHandle,
}

impl Shell {
	pub fn new(source: Box<dyn Source>, cx: &mut App) -> Shell {
		Shell { source, chrome: Chrome::new(), focus: cx.focus_handle() }
	}

	/// Opens with regions revealed other than the default. What a capture of one
	/// state uses, so both arms of a differential come from one binary.
	pub fn chrome(mut self, chrome: Chrome) -> Shell {
		self.chrome = chrome;
		self
	}

	/// The regions currently revealed.
	pub fn revealed(&self) -> Chrome {
		self.chrome
	}

	fn on_key(&mut self, event: &KeyDownEvent, _window: &mut Window, cx: &mut Context<Shell>) {
		let stroke = &event.keystroke;
		let Some(command) = command(&stroke.key, stroke.modifiers.control, stroke.modifiers.platform)
		else {
			return;
		};
		self.chrome = match command {
			Command::ToggleSidebar => self.chrome.toggle_sidebar(),
			Command::ToggleTerminal => self.chrome.toggle_terminal(),
		};
		cx.notify();
	}
}

impl Focusable for Shell {
	fn focus_handle(&self, _cx: &App) -> FocusHandle {
		self.focus.clone()
	}
}

impl Render for Shell {
	fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		if !self.focus.is_focused(window) {
			window.focus(&self.focus, cx);
		}

		let value = self.source.frame();
		let route = self.source.route();
		let page = page::page(&route, cx);

		let mut root = div()
			.size_full()
			.track_focus(&self.focus)
			.on_key_down(cx.listener(Shell::on_key))
			.child(frame(&value, &route, self.chrome, page, cx));

		if let Some(dialog) = &value.dialog {
			root = root.child(modal(dialog, cx));
		}
		root
	}
}

/// A dialog on top of everything.
///
/// Full-bleed scrim, so the dialog is the only thing that reads as reachable.
/// The scrim is the window ground at partial alpha rather than black, which
/// keeps a light theme from going grey.
fn modal(value: &DialogViewModel, cx: &App) -> Div {
	let scrim = cx.color(Role::SurfaceWindow);
	div()
		.absolute()
		.inset_0()
		.flex()
		.items_center()
		.justify_center()
		.bg(gpui::Hsla { a: 0.72, ..scrim })
		.child(veyyon_gui_motion::dialog_in("dialog", dialog(value, cx)))
}

/// The dialog card.
fn dialog(value: &DialogViewModel, cx: &App) -> Div {
	let card = surface(Level::Overlay, cx)
		.w(layout::DIALOG)
		.p(space::LOOSE)
		.flex()
		.flex_col()
		.gap(space::BASE);

	match value {
		DialogViewModel::Confirm {
			title: heading,
			body,
			confirm_label,
			cancel_label,
			destructive,
			..
		} => card
			.child(title(heading.clone(), cx))
			.child(label(body.clone(), cx))
			.child(
				row(space::SNUG)
					.child(button(cancel_label.clone(), Role::TextSecondary, cx))
					.child(button(
						confirm_label.clone(),
						if *destructive {
							Role::StateError
						} else {
							Role::TextAccent
						},
						cx,
					)),
			),
		DialogViewModel::Select {
			title: heading,
			options,
			selected_index,
			multi,
			filterable,
			..
		} => card
			.child(title(heading.clone(), cx))
			.child(
				row(space::TIGHT)
					.children(multi.then(|| chip("multiple", Role::StateInfo, cx)))
					.children(filterable.then(|| chip("filterable", Role::TextMuted, cx))),
			)
			.children(options.iter().enumerate().map(|(index, option)| {
				choice(option, usize::try_from(*selected_index).ok() == Some(index), cx)
			})),
		DialogViewModel::Prompt { title: heading, placeholder, initial_value, masked, .. } => card
			.child(title(heading.clone(), cx))
			.children(masked.then(|| chip("hidden while typed", Role::TextMuted, cx)))
			.child(entry(placeholder, initial_value, *masked, cx)),
		DialogViewModel::ToolApproval { tool_name, input, impact, .. } => card
			.child(title(format!("Run {tool_name}?"), cx))
			.children(impact.as_ref().map(|text| label(text.clone(), cx)))
			.child(well(input.clone(), Role::TextPrimary, cx))
			.child(
				row(space::SNUG)
					.child(button("Reject", Role::StateError, cx))
					.child(button("Approve", Role::StateSuccess, cx)),
			),
	}
}

/// One option of a select dialog.
fn choice(option: &SelectOption, chosen: bool, cx: &App) -> Div {
	let disabled = option.disabled.unwrap_or(false);
	let role = if disabled {
		Role::TextMuted
	} else {
		Role::TextPrimary
	};
	let mut line = column(space::HAIR)
		.w_full()
		.px(space::SNUG)
		.py(space::TIGHT)
		.rounded(radius::SMALL)
		.child(label(option.label.clone(), cx).text_color(cx.color(role)));

	if chosen {
		line = line.bg(cx.color(Role::InteractionSelected));
	}
	if disabled {
		line = line.child(caption("unavailable", cx));
	}
	match &option.description {
		None => line,
		Some(text) => line.child(caption(text.clone(), cx)),
	}
}

/// A prompt's input line. Masked shows the character count rather than the
/// value, because a masked prompt is a credential.
fn entry(placeholder: &str, value: &str, masked: bool, cx: &App) -> Div {
	let shown = if value.is_empty() {
		placeholder.to_owned()
	} else if masked {
		"•".repeat(value.chars().count())
	} else {
		value.to_owned()
	};
	let role = if value.is_empty() {
		Role::TextMuted
	} else {
		Role::TextPrimary
	};
	well(shown, role, cx)
}

/// A button. Not interactive yet: there is nothing to send a
/// `UiEvent::DialogResult` to.
fn button(text: impl Into<gpui::SharedString>, role: Role, cx: &App) -> Div {
	let color = cx.color(role);
	div()
		.px(space::BASE)
		.py(space::TIGHT)
		.rounded(radius::SMALL)
		.border(stroke::HAIRLINE)
		.border_color(veyyon_gui_kit::chrome::edge(color))
		.bg(veyyon_gui_kit::chrome::wash(color))
		.text_color(color)
		.child(text.into())
}
