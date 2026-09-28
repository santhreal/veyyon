//! What choosing a row does.

use veyyon_desktop_model::{HostAction, SurfaceId};
use veyyon_gpui::{Context, PathPromptOptions, Window};

use super::{ActionData, CommandPalette, Run, Scope};
use crate::actions::{panel, workspace};

impl CommandPalette {
	/// Runs `run`. A row that opens a subcommand list or asks for an argument
	/// keeps the palette open, and so does an argument that builds no request;
	/// every other row closes it first, so a window action reaches the element
	/// that held focus before the palette opened.
	pub(super) fn run(&mut self, run: Run, window: &mut Window, cx: &mut Context<Self>) {
		let filled = match run {
			Run::Subcommands(name) => return self.enter(Scope::Subcommands(name), window, cx),
			Run::Argument { line, hint, takes } => {
				return self.enter(Scope::Argument { line, hint, takes }, window, cx);
			},
			Run::Filled { takes, ref line, ref text } => {
				let session = self.app.read(cx).active_session().cloned();
				let Some(action) = takes.action(line, text, session) else {
					return;
				};
				Some(action)
			},
			Run::Action(_)
			| Run::ActionWith(_)
			| Run::Host(..)
			| Run::Command(_)
			| Run::OpenSession(_)
			| Run::CreateSession(_)
			| Run::CreateSessionInFolder => None,
		};
		self.close(window, cx);
		if let Some(action) = filled {
			self.app.update(cx, |app, cx| {
				app.dispatch(action, SurfaceId::PaletteInput, cx);
			});
			return;
		}
		match run {
			Run::Action(build) => window.dispatch_action(build(), cx),
			Run::ActionWith(ActionData::OpenSettings(page)) => {
				window.dispatch_action(Box::new(workspace::OpenSettings { page: Some(page) }), cx);
			},
			Run::ActionWith(ActionData::OpenFile { path, line }) => {
				window.dispatch_action(Box::new(panel::OpenFile { path, line }), cx);
			},
			Run::Host(action, surface) => {
				self.app.update(cx, |app, cx| {
					app.dispatch(action, surface, cx);
				});
			},
			Run::Command(text) => {
				self.app.update(cx, |app, cx| {
					if let Some(session) = app.active_session().cloned() {
						app.dispatch(
							HostAction::RunCommand { session, text },
							SurfaceId::PaletteInput,
							cx,
						);
					}
				});
			},
			Run::OpenSession(session) => {
				self.app.update(cx, |app, cx| {
					app.open_session(session, cx);
				});
			},
			Run::CreateSession(cwd) => {
				self.app.update(cx, |app, cx| {
					app.create_session(cwd, cx);
				});
			},
			Run::CreateSessionInFolder => Self::create_in_folder(cx),
			Run::Subcommands(_) | Run::Argument { .. } | Run::Filled { .. } => {},
		}
	}

	/// Asks the platform for a directory and starts a thread in it.
	fn create_in_folder(cx: &Context<Self>) {
		let picked = cx.prompt_for_paths(PathPromptOptions {
			files:       false,
			directories: true,
			multiple:    false,
			prompt:      Some("Start a thread here".into()),
		});
		cx.spawn(async move |this, cx| {
			let Ok(Ok(Some(paths))) = picked.await else {
				return;
			};
			let Some(dir) = paths.into_iter().next() else {
				return;
			};
			let cwd = dir.to_string_lossy().into_owned();
			this
				.update(cx, |this, cx| {
					this.app.update(cx, |app, cx| {
						app.create_session(Some(cwd), cx);
					});
				})
				.ok();
		})
		.detach();
	}
}
