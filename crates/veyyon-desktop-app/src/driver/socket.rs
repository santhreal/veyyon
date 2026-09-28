//! The driver socket: an accept thread and one reader and one writer thread
//! per client feed requests to the app's foreground executor, which answers
//! them against the focused window.

use std::{
	io::{self, BufRead, BufReader, Write},
	os::unix::{
		fs::FileTypeExt,
		net::{UnixListener, UnixStream},
	},
	path::Path,
	thread,
};

use gpui::{AnyWindowHandle, App, Global, Keystroke, Modifiers, Window};
use serde_json::Value;

use super::{
	probe,
	protocol::{self, Condition, Request},
};

/// A request line and where its reply goes.
struct Incoming {
	line:  String,
	reply: flume::Sender<String>,
}

/// A `wait` request whose condition did not hold yet.
struct Wait {
	id:        Value,
	condition: Condition,
	reply:     flume::Sender<String>,
}

/// The clients subscribed to frame events, the painted frame count and the
/// waits checked after each frame.
#[derive(Default)]
struct Frames {
	subscribers: Vec<flume::Sender<String>>,
	painted:     u64,
	waits:       Vec<Wait>,
}

impl Global for Frames {}

/// Opens the driver socket at `path` and answers its clients until the app
/// quits. A socket file left at `path` by an earlier process is replaced.
///
/// # Errors
///
/// Returns the error of binding the socket, or `AlreadyExists` when `path`
/// holds a file that is not a socket.
pub fn start(path: &Path, cx: &mut App) -> io::Result<()> {
	match std::fs::symlink_metadata(path) {
		Ok(meta) if meta.file_type().is_socket() => std::fs::remove_file(path)?,
		Ok(_) => {
			return Err(io::Error::new(
				io::ErrorKind::AlreadyExists,
				format!("{} exists and is not a socket", path.display()),
			));
		},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {},
		Err(error) => return Err(error),
	}
	let listener = UnixListener::bind(path)?;
	let (requests, incoming) = flume::unbounded();
	thread::Builder::new()
		.name("desktop-driver".into())
		.spawn(move || accept(&listener, &requests))?;
	super::enable();
	cx.set_global(Frames::default());
	cx.spawn(async move |cx| {
		while let Ok(request) = incoming.recv_async().await {
			cx.update(|cx| answer(request, cx));
		}
	})
	.detach();
	Ok(())
}

fn accept(listener: &UnixListener, requests: &flume::Sender<Incoming>) {
	for stream in listener.incoming().flatten() {
		if serve(stream, requests.clone()).is_err() {
			continue;
		}
	}
}

/// Starts the reader and writer threads of one client.
fn serve(stream: UnixStream, requests: flume::Sender<Incoming>) -> io::Result<()> {
	let mut writer = stream.try_clone()?;
	let (reply, replies) = flume::unbounded::<String>();
	thread::Builder::new()
		.name("desktop-driver-write".into())
		.spawn(move || {
			for line in replies.iter() {
				if writeln!(writer, "{line}")
					.and_then(|()| writer.flush())
					.is_err()
				{
					break;
				}
			}
		})?;
	thread::Builder::new()
		.name("desktop-driver-read".into())
		.spawn(move || {
			for line in BufReader::new(stream).lines() {
				let Ok(line) = line else { break };
				if line.trim().is_empty() {
					continue;
				}
				if requests
					.send(Incoming { line, reply: reply.clone() })
					.is_err()
				{
					break;
				}
			}
		})?;
	Ok(())
}

fn answer(request: Incoming, cx: &mut App) {
	let (id, parsed) = protocol::parse(&request.line);
	let reply = match parsed {
		Err(message) => protocol::error(&id, &message),
		Ok(Request::Dispatch { name, args }) => match dispatch(&name, args, cx) {
			Ok(()) => protocol::ok(&id),
			Err(message) => protocol::error(&id, &message),
		},
		Ok(Request::Type(text)) => match in_window(cx, |window, cx| type_text(&text, window, cx)) {
			Ok(()) => protocol::ok(&id),
			Err(message) => protocol::error(&id, &message),
		},
		Ok(Request::Bounds(target)) => {
			match focused(cx).and_then(|window| super::bounds(cx, window.window_id(), &target)) {
				Some(bounds) => protocol::bounds(&id, bounds),
				None => protocol::error(&id, &format!("no target `{target}` is laid out")),
			}
		},
		Ok(Request::SubscribeFrames) => {
			cx.default_global::<Frames>()
				.subscribers
				.push(request.reply.clone());
			protocol::ok(&id)
		},
		Ok(Request::Wait(condition)) => match holds(&condition, cx) {
			Ok(true) => protocol::ok(&id),
			Ok(false) => {
				let wait = Wait { id, condition, reply: request.reply };
				cx.default_global::<Frames>().waits.push(wait);
				return;
			},
			Err(message) => protocol::error(&id, &message),
		},
	};
	// A client that hung up before its reply needs none.
	request.reply.send(reply).ok();
}

fn dispatch(name: &str, args: Option<serde_json::Value>, cx: &mut App) -> Result<(), String> {
	let action = cx
		.build_action(name, args)
		.map_err(|error| error.to_string())?;
	in_window(cx, move |window, cx| window.dispatch_action(action, cx))
}

/// Whether `condition` holds in the focused window now.
fn holds(condition: &Condition, cx: &mut App) -> Result<bool, String> {
	match condition {
		Condition::Idle => in_window(cx, |window, _| probe::frame_pending(window))?
			.map(|pending| !pending)
			.map_err(str::to_owned),
		Condition::Text { target, contains } => {
			let window = focused(cx).ok_or_else(|| "no window is open".to_owned())?;
			// A target not laid out yet is not drawn yet: the wait goes on.
			let Some(bounds) = super::bounds(cx, window.window_id(), target) else {
				return Ok(false);
			};
			in_window(cx, |window, _| probe::rendered_text(window, bounds))?
				.map(|runs| runs.concat().contains(contains.as_str()))
				.map_err(str::to_owned)
		},
	}
}

/// Answers every parked wait whose condition holds after a frame, and drops
/// the waits of clients that hung up.
fn settle_waits(cx: &mut App) {
	let waits = std::mem::take(&mut cx.default_global::<Frames>().waits);
	let mut parked = Vec::with_capacity(waits.len());
	for wait in waits {
		let reply = match holds(&wait.condition, cx) {
			Ok(true) => protocol::ok(&wait.id),
			Ok(false) if !wait.reply.is_disconnected() => {
				parked.push(wait);
				continue;
			},
			Ok(false) => continue,
			Err(message) => protocol::error(&wait.id, &message),
		};
		wait.reply.send(reply).ok();
	}
	cx.default_global::<Frames>().waits.append(&mut parked);
}

/// Types `text` one keystroke at a time through the window's key dispatch
/// and its focused input handler, as a keyboard would.
fn type_text(text: &str, window: &mut Window, cx: &mut App) {
	for ch in text.chars() {
		let (key, key_char) = match ch {
			' ' => ("space".to_owned(), Some(" ".to_owned())),
			'\n' => ("enter".to_owned(), None),
			'\t' => ("tab".to_owned(), None),
			ch => (ch.to_lowercase().collect(), Some(ch.to_string())),
		};
		let modifiers = Modifiers { shift: ch.is_uppercase(), ..Modifiers::default() };
		window.dispatch_keystroke(Keystroke { modifiers, key, key_char }, cx);
	}
}

/// The window requests act on: the active one, else the first open one.
fn focused(cx: &App) -> Option<AnyWindowHandle> {
	cx.active_window().or_else(|| cx.windows().first().copied())
}

fn in_window<R>(cx: &mut App, f: impl FnOnce(&mut Window, &mut App) -> R) -> Result<R, String> {
	let window = focused(cx).ok_or_else(|| "no window is open".to_owned())?;
	window
		.update(cx, |_, window, cx| f(window, cx))
		.map_err(|error| error.to_string())
}

/// Reports a painted frame to every subscribed client.
pub(super) fn frame_painted(_: &mut Window, cx: &mut App) {
	if !cx.has_global::<Frames>() {
		return;
	}
	let t_ns = monotonic_ns();
	let frames = cx.global_mut::<Frames>();
	frames.painted += 1;
	let event = protocol::frame(frames.painted, t_ns);
	frames
		.subscribers
		.retain(|client| client.send(event.clone()).is_ok());
	if !frames.waits.is_empty() {
		// Checked once the frame is presented, when the window reports on it.
		cx.defer(settle_waits);
	}
}

/// Nanoseconds on `CLOCK_MONOTONIC`, the clock the bench's fake model stamps
/// its tokens with.
fn monotonic_ns() -> u64 {
	let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
	// SAFETY: `now` is a valid, writable timespec for the whole call.
	let status = unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &raw mut now) };
	if status != 0 {
		return 0;
	}
	(now.tv_sec as u64)
		.saturating_mul(1_000_000_000)
		.saturating_add(now.tv_nsec as u64)
}
