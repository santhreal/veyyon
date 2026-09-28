//! What the dock keeps for the autoswarm console of the shown session, and
//! what the console's controls send.
//!
//! Every value is the host's: a row sends the value alone and the console
//! states it back formatted. A text row is an editor that commits when Enter
//! is pressed in it or it loses the keyboard; the others send on the press.

use gpui::{Context, Entity, Subscription, Window, prelude::*};
use veyyon_desktop_model::{
	AutoswarmAction, AutoswarmFieldKind, AutoswarmFieldView, AutoswarmRequest, HostAction,
	SessionId, SurfaceId,
};
use veyyon_desktop_ui::editor::{Editor, EditorEvent, EditorMode};

use super::InteractionDock;
use crate::AppState;

/// The editor of one text row.
struct TextRow {
	field:         String,
	editor:        Entity<Editor>,
	_subscription: Subscription,
}

/// The console's editors and the ledger run opened.
#[derive(Default)]
pub(super) struct Console {
	session:             Option<SessionId>,
	rows:                Vec<TextRow>,
	/// The run of the ledger whose detail is shown.
	pub(super) open_run: Option<usize>,
}

impl Console {
	/// Follows the console of `session`: one editor per text row, holding the
	/// row's text unless it is being written in.
	pub(super) fn sync(
		&mut self,
		app: &Entity<AppState>,
		session: Option<&SessionId>,
		window: &mut Window,
		cx: &mut Context<InteractionDock>,
	) {
		if session != self.session.as_ref() {
			*self = Self { session: session.cloned(), ..Self::default() };
		}
		let texts: Vec<(String, String, Option<String>)> = session
			.and_then(|session| app.read(cx).autoswarm_console(session))
			.map(|console| {
				console
					.fields
					.iter()
					.filter(|field| field.kind == AutoswarmFieldKind::Text)
					.map(|field| {
						(
							field.id.clone(),
							field.text.clone().unwrap_or_default(),
							field.placeholder.clone(),
						)
					})
					.collect()
			})
			.unwrap_or_default();
		self
			.rows
			.retain(|row| texts.iter().any(|(field, ..)| *field == row.field));
		for (field, text, placeholder) in texts {
			if let Some(row) = self.rows.iter().find(|row| row.field == field) {
				row.editor.update(cx, |editor, cx| {
					if !editor.is_focused() && editor.text() != text {
						editor.set_text(&text, cx);
					}
				});
				continue;
			}
			let editor = cx.new(|cx| {
				let mut editor = Editor::new(EditorMode::SingleLine, window, cx);
				editor.set_placeholder(placeholder.unwrap_or_default(), cx);
				editor.set_text(&text, cx);
				editor
			});
			let committed = field.clone();
			let subscription = cx.subscribe(&editor, move |dock, _, event: &EditorEvent, cx| {
				if matches!(event, EditorEvent::Submit | EditorEvent::Blurred) {
					dock.commit_text(&committed, cx);
				}
			});
			self
				.rows
				.push(TextRow { field, editor, _subscription: subscription });
		}
	}

	/// The editor of text row `field`.
	pub(super) fn editor(&self, field: &str) -> Option<&Entity<Editor>> {
		self
			.rows
			.iter()
			.find(|row| row.field == field)
			.map(|row| &row.editor)
	}
}

impl InteractionDock {
	/// Sends the request `request` builds for the shown session's console,
	/// unless the host takes no request of its kind now.
	fn send_console(
		&self,
		request: impl FnOnce(SessionId) -> (AutoswarmRequest, SurfaceId),
		cx: &mut Context<Self>,
	) {
		let Some(session) = self.session.clone() else {
			return;
		};
		let (request, surface) = request(session);
		if self.app.read(cx).refusal(request.kind()).is_some() {
			return;
		}
		self.app.update(cx, |app, cx| {
			app.dispatch(HostAction::Autoswarm(request), surface, cx);
		});
	}

	/// Sets row `field` to `text`, `number` or `on`, by the kind it draws.
	pub(super) fn set_field(
		&self,
		field: &str,
		text: Option<String>,
		number: Option<i64>,
		on: Option<bool>,
		cx: &mut Context<Self>,
	) {
		self.send_console(
			|session| {
				let surface = SurfaceId::AutoswarmField(session.clone(), field.to_owned());
				let field = field.to_owned();
				(AutoswarmRequest::SetAutoswarmField { session, field, text, number, on }, surface)
			},
			cx,
		);
	}

	/// Sends what text row `field` holds when it differs from the console's.
	fn commit_text(&self, field: &str, cx: &mut Context<Self>) {
		let Some(editor) = self.console.editor(field) else {
			return;
		};
		let text = editor.read(cx).text().to_owned();
		let held = self.session.as_ref().and_then(|session| {
			let console = self.app.read(cx).autoswarm_console(session)?;
			console
				.fields
				.iter()
				.find(|row| row.id == field)
				.and_then(|row| row.text.clone())
		});
		if held.as_deref() != Some(text.as_str()) {
			self.set_field(field, Some(text), None, None, cx);
		}
	}

	/// Steps stepper `field` by `delta`, held to its bounds; sends nothing
	/// past them.
	pub(super) fn step_field(&self, field: &AutoswarmFieldView, delta: i64, cx: &mut Context<Self>) {
		if let Some(number) = stepped(field, delta) {
			self.set_field(&field.id, None, Some(number), None, cx);
		}
	}

	/// Runs `action`.
	pub(super) fn run_console_action(&self, action: AutoswarmAction, cx: &mut Context<Self>) {
		self.send_console(
			|session| {
				let surface =
					SurfaceId::AutoswarmActionButton(session.clone(), action.as_str().to_owned());
				(AutoswarmRequest::RunAutoswarmAction { session, action }, surface)
			},
			cx,
		);
	}

	/// Saves the setup under the name the console's save row holds.
	pub(super) fn save_preset(&self, field: &str, cx: &mut Context<Self>) {
		let Some(name) = self
			.console
			.editor(field)
			.map(|editor| editor.read(cx).text().trim().to_owned())
		else {
			return;
		};
		if name.is_empty() {
			return;
		}
		self.send_console(
			|session| {
				let surface = SurfaceId::AutoswarmPresetSaveButton(session.clone());
				(AutoswarmRequest::SaveAutoswarmPreset { session, name }, surface)
			},
			cx,
		);
	}

	/// Removes the saved preset the rows equal.
	pub(super) fn delete_preset(&self, cx: &mut Context<Self>) {
		self.send_console(
			|session| {
				let surface = SurfaceId::AutoswarmPresetDeleteButton(session.clone());
				(AutoswarmRequest::DeleteAutoswarmPreset { session }, surface)
			},
			cx,
		);
	}

	/// Closes the console, leaving the loop as it stands.
	pub(super) fn close_console(&self, cx: &mut Context<Self>) {
		self.send_console(
			|session| {
				let surface = SurfaceId::AutoswarmCloseButton(session.clone());
				(AutoswarmRequest::CloseAutoswarmConsole { session }, surface)
			},
			cx,
		);
	}

	/// Opens the detail of ledger run `index`, or closes it when open.
	pub(super) fn toggle_run(&mut self, index: usize, cx: &mut Context<Self>) {
		self.console.open_run = if self.console.open_run == Some(index) {
			None
		} else {
			Some(index)
		};
		cx.notify();
	}
}

/// The number a step of `delta` sends from stepper `field`, or `None` when it
/// holds no number or the step leaves its bounds.
pub(super) fn stepped(field: &AutoswarmFieldView, delta: i64) -> Option<i64> {
	let next = field.number?.checked_add(delta)?;
	let within = field.min.is_none_or(|min| next >= min) && field.max.is_none_or(|max| next <= max);
	within.then_some(next)
}

/// Whether segmented row `field` offers removing the preset it holds: its
/// selected option is one that can be removed.
pub(super) fn offers_delete(field: &AutoswarmFieldView) -> bool {
	field.kind == AutoswarmFieldKind::Segmented
		&& field
			.options
			.iter()
			.any(|option| option.selected && option.removable)
}
