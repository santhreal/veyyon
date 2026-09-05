//! How files reach the composer: the picker, a drop, a paste (§5.4).
//!
//! Every route ends in one place, `attach`, which admits what was read
//! against the prompt's ceiling and either records the attachment or reports
//! why it was refused — under the composer, where the operator is looking,
//! rather than on the attention strip, which is for the window. Files are
//! read off the main thread: a 20 MiB clip must not hold a frame.

use std::{path::PathBuf, sync::Arc};

use veyyon_gpui::{AppContext, ClipboardEntry, ClipboardItem, Context, PathPromptOptions};

use crate::{
	ShellView,
	composer::{Attachment, AttachmentError, ComposerLocal, MediaType, Payload, read_media},
	intent::Intent,
};

/// What the composer draws that is the window's and not the state's.
#[derive(Debug, Default)]
pub struct AttachState {
	/// Files from outside the window are over the composer's float.
	dropping: bool,
	/// Why the last attachment was refused, until the next one lands.
	notice:   Option<String>,
	/// How many clipboard images have been pasted, for their names.
	pasted:   u32,
}

impl ShellView {
	/// The composer's window-owned state, for the render.
	#[must_use]
	pub fn composer_local(&self) -> ComposerLocal<'_> {
		ComposerLocal { dropping: self.attach.dropping, notice: self.attach.notice.as_deref() }
	}

	/// Records whether files are over the composer; `true` when that changed.
	pub const fn set_dropping(&mut self, over: bool) -> bool {
		let changed = self.attach.dropping != over;
		self.attach.dropping = over;
		changed
	}

	/// Clears the composer's refusal line.
	pub fn clear_composer_notice(&mut self) {
		self.attach.notice = None;
	}

	/// Opens the platform's file prompt and attaches every file the operator
	/// picks. A cancelled prompt attaches nothing; a prompt the platform
	/// could not open is reported on the attention strip, since the operator
	/// asked for something and got no dialog.
	pub fn pick_attachments(&mut self, cx: &mut Context<Self>) {
		let receiver = cx.prompt_for_paths(PathPromptOptions {
			files:       true,
			directories: false,
			multiple:    true,
			prompt:      Some("Attach".into()),
		});
		cx.spawn(async move |this, cx| {
			let picked = receiver.await;
			let _ = this.update(cx, |view, cx| {
				match picked {
					Ok(Ok(Some(paths))) => view.attach_paths(paths, cx),
					Ok(Ok(None)) => {},
					Ok(Err(error)) => {
						view.set_notice(Some(format!("File prompt failed: {error:#}")));
					},
					Err(_cancelled) => {
						view.set_notice(Some("File prompt closed before answering".to_owned()));
					},
				}
				cx.notify();
			});
		})
		.detach();
	}

	/// Opens the platform's path prompt for the setting `key` and writes the
	/// one path the operator picks to it. A cancelled prompt writes nothing;
	/// a prompt the platform could not open is reported on the attention
	/// strip, as for an attachment.
	pub fn pick_setting_path(&mut self, key: String, cx: &mut Context<Self>) {
		let receiver = cx.prompt_for_paths(PathPromptOptions {
			files:       true,
			directories: true,
			multiple:    false,
			prompt:      Some("Choose".into()),
		});
		cx.spawn(async move |this, cx| {
			let picked = receiver.await;
			let _ = this.update(cx, |view, cx| {
				match picked {
					Ok(Ok(Some(paths))) => {
						if let Some(path) = paths.into_iter().next() {
							let value = serde_json::Value::String(path.display().to_string());
							view.dispatch(Intent::SettingChanged { key, value });
						}
					},
					Ok(Ok(None)) => {},
					Ok(Err(error)) => {
						view.set_notice(Some(format!("Path prompt failed: {error:#}")));
					},
					Err(_cancelled) => {
						view.set_notice(Some("Path prompt closed before answering".to_owned()));
					},
				}
				cx.notify();
			});
		})
		.detach();
	}

	/// Reads `paths` off the main thread and attaches each that is an image
	/// or a clip within the ceilings, in the order given.
	pub fn attach_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
		if paths.is_empty() {
			return;
		}
		let read = cx.background_spawn(async move {
			paths
				.into_iter()
				.map(|path| {
					read_media(&path).map(|(media, payload)| Attachment::from_path(path, media, payload))
				})
				.collect::<Vec<_>>()
		});
		cx.spawn(async move |this, cx| {
			let results = read.await;
			let _ = this.update(cx, |view, cx| {
				for result in results {
					view.attach(result);
				}
				cx.notify();
			});
		})
		.detach();
	}

	/// Attaches what a paste held when it held no text: each image as a
	/// pasted image, each copied file by its path.
	pub fn attach_clipboard(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) {
		let mut paths = Vec::new();
		for entry in item.entries() {
			match entry {
				ClipboardEntry::Image(image) => {
					let result = match MediaType::from_image_format(image.format()) {
						Some(media) => {
							self.attach.pasted += 1;
							Ok(Attachment::from_clipboard(
								self.attach.pasted,
								media,
								Payload::Image(Arc::new(image.clone())),
							))
						},
						None => Err(AttachmentError::ClipboardFormat { format: image.format() }),
					};
					self.attach(result);
				},
				ClipboardEntry::ExternalPaths(external) => {
					paths.extend(external.paths().iter().cloned());
				},
				ClipboardEntry::String(_) => {},
			}
		}
		self.attach_paths(paths, cx);
		cx.notify();
	}

	/// Admits one read attachment against the prompt's ceiling and records
	/// it, or records why it was refused.
	pub fn attach(&mut self, result: Result<Attachment, AttachmentError>) {
		let admitted =
			result.and_then(|attachment| self.state.composer.admit(&attachment).map(|()| attachment));
		match admitted {
			Ok(attachment) => {
				self.attach.notice = None;
				self.dispatch(Intent::Attach(attachment));
			},
			Err(error) => self.attach.notice = Some(error.to_string()),
		}
	}
}
