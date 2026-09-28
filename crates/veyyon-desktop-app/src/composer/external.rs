//! Editing the draft in the editor `$VISUAL` or `$EDITOR` names.
//!
//! The draft is written to a file, the editor runs on it until it exits and,
//! when it exits with success, the file's text less one trailing newline
//! replaces the draft of the thread it was opened from: the shown draft, or
//! the saved one of a thread left meanwhile. An editor that exits with a
//! failure, or does not start, leaves the draft as it was and states why. A
//! graphical editor that returns at once is given the flag that keeps it
//! open until its file is closed. The editor is waited for off the window's
//! thread, one at a time per composer.

use std::{
	env, fs, io,
	path::{Path, PathBuf},
	process::{Command, ExitStatus},
	sync::atomic::{AtomicU64, Ordering},
};

use gpui::{App, AppContext as _, Context, Global};
use veyyon_desktop_model::SessionId;

use super::Composer;

/// Editors that fork and return before their file is edited, and the flags
/// that keep them running until it is closed.
const WAIT_FLAGS: &[(&str, &[&str])] = &[
	("code", &["--wait"]),
	("code-insiders", &["--wait"]),
	("codium", &["--wait"]),
	("vscodium", &["--wait"]),
	("cursor", &["--wait"]),
	("windsurf", &["--wait"]),
	("positron", &["--wait"]),
	("zed", &["--wait"]),
	("subl", &["--wait"]),
	("sublime_text", &["--wait"]),
	("atom", &["--wait"]),
	("gedit", &["--wait"]),
	("kate", &["--block"]),
	("mate", &["--wait"]),
	("gvim", &["--nofork"]),
	("mvim", &["--nofork"]),
	("notepad++", &["-multiInst", "-nosession"]),
];

/// Numbers the files this process writes drafts to.
static NEXT_FILE: AtomicU64 = AtomicU64::new(0);

/// The editor command line and the directory the draft's file is written in.
struct Configured {
	command: Option<String>,
	dir:     PathBuf,
}

impl Global for Configured {}

/// Opens drafts in `command`, writing their files in `dir`. `None` states
/// that no editor is set.
pub fn install(command: Option<String>, dir: PathBuf, cx: &mut App) {
	cx.set_global(Configured { command, dir });
}

/// The editor command line the environment sets: `$VISUAL`, else `$EDITOR`,
/// else Notepad on Windows.
#[must_use]
pub fn command_from_env() -> Option<String> {
	["VISUAL", "EDITOR"]
		.into_iter()
		.filter_map(|name| env::var(name).ok())
		.map(|value| value.trim().to_owned())
		.find(|value| !value.is_empty())
		.or_else(|| cfg!(windows).then(|| "notepad".to_owned()))
}

/// The program and arguments `command` runs, with the wait flag its editor
/// needs when the command line does not give one.
fn invocation(command: &str) -> Option<(String, Vec<String>)> {
	let mut words = command.split_whitespace().map(str::to_owned);
	let program = words.next()?;
	let mut args: Vec<String> = words.collect();
	let base = program
		.rsplit(['/', '\\'])
		.next()
		.unwrap_or(program.as_str())
		.to_lowercase();
	let base = base.strip_suffix(".exe").unwrap_or(base.as_str());
	if let Some((_, flags)) = WAIT_FLAGS.iter().find(|(name, _)| *name == base) {
		let waits = args
			.iter()
			.any(|arg| arg == "-w" || flags.contains(&arg.as_str()));
		if !waits {
			args.extend(flags.iter().map(|flag| (*flag).to_owned()));
		}
	}
	Some((program, args))
}

/// How one edit ended.
enum Outcome {
	Edited(String),
	Failed(ExitStatus),
	Error(io::Error),
}

/// Writes `text` to a file in `dir`, runs the editor on it and reads it back.
fn edit(program: &str, args: &[String], dir: &Path, text: &str) -> Outcome {
	let file = dir.join(format!(
		"draft-{}-{}.veyyon.md",
		std::process::id(),
		NEXT_FILE.fetch_add(1, Ordering::Relaxed)
	));
	let ran = fs::create_dir_all(dir)
		.and_then(|()| fs::write(&file, text))
		.and_then(|()| Command::new(program).args(args).arg(&file).status());
	let outcome = match ran {
		Ok(status) if status.success() => match fs::read_to_string(&file) {
			Ok(mut edited) => {
				if edited.ends_with('\n') {
					edited.pop();
				}
				Outcome::Edited(edited)
			},
			Err(error) => Outcome::Error(error),
		},
		Ok(status) => Outcome::Failed(status),
		Err(error) => Outcome::Error(error),
	};
	let _ = fs::remove_file(&file);
	outcome
}

impl Composer {
	/// `composer::EditDraftExternally`: opens the shown thread's draft in the
	/// editor the environment sets.
	pub(super) fn edit_externally(&mut self, cx: &mut Context<Self>) {
		let Some(session) = self.session.clone() else {
			return;
		};
		if self.editing {
			return;
		}
		let configured = cx.try_global::<Configured>();
		let Some((program, args)) = configured
			.and_then(|configured| configured.command.as_deref())
			.and_then(invocation)
		else {
			self.notice = Some("No editor is set: set $VISUAL or $EDITOR.".into());
			cx.notify();
			return;
		};
		let dir = configured.map_or_else(env::temp_dir, |configured| configured.dir.clone());
		let text = self.text(cx).to_owned();
		self.editing = true;
		self.notice = None;
		cx.spawn(async move |this, cx| {
			let run = program.clone();
			let outcome = cx
				.background_spawn(async move { edit(&run, &args, &dir, &text) })
				.await;
			let _ = this.update(cx, |this, cx| this.edited(&session, &program, outcome, cx));
		})
		.detach();
	}

	/// Puts the text the editor left in `session`'s draft, or states why it
	/// left none.
	fn edited(
		&mut self,
		session: &SessionId,
		program: &str,
		outcome: Outcome,
		cx: &mut Context<Self>,
	) {
		self.editing = false;
		let shown = self.session.as_ref() == Some(session);
		let notice = match outcome {
			Outcome::Edited(text) if shown => {
				self.set_text(&text, cx);
				None
			},
			Outcome::Edited(text) => {
				self.app.update(cx, |app, cx| {
					let mut draft = app.draft(session).cloned().unwrap_or_default();
					draft.draft_text = text;
					app.save_draft(session.clone(), draft, cx);
				});
				None
			},
			Outcome::Failed(status) => {
				Some(format!("{program} exited ({status}); the draft is unchanged."))
			},
			Outcome::Error(error) => Some(format!("Cannot edit the draft in {program}: {error}")),
		};
		if shown && let Some(notice) = notice {
			self.notice = Some(notice.into());
			cx.notify();
		}
	}
}
