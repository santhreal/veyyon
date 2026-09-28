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

use gpui::App;

use super::answer::{self, Incoming};

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
	answer::install(cx);
	cx.spawn(async move |cx| {
		while let Ok(request) = incoming.recv_async().await {
			cx.update(|cx| answer::answer(request, cx));
		}
	})
	.detach();
	Ok(())
}

fn accept(listener: &UnixListener, requests: &flume::Sender<Incoming>) {
	for stream in listener.incoming().flatten() {
		// A client whose threads cannot start is dropped with its stream;
		// the next client is served.
		serve(stream, requests.clone()).ok();
	}
}

/// Starts the reader and writer threads of one client.
///
/// The reader holds `hangup` and drops it when the client hangs up, which
/// ends the writer and drops the client's reply channel, so its parked waits
/// and frame subscription see it gone even though they still hold senders.
fn serve(stream: UnixStream, requests: flume::Sender<Incoming>) -> io::Result<()> {
	let mut writer = stream.try_clone()?;
	let (reply, replies) = flume::unbounded::<String>();
	let (hangup, hung_up) = flume::bounded::<()>(0);
	thread::Builder::new()
		.name("desktop-driver-write".into())
		.spawn(move || {
			loop {
				let next = flume::Selector::new()
					.recv(&replies, Result::ok)
					.recv(&hung_up, |_| None)
					.wait();
				let Some(line) = next else { break };
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
			drop(hangup);
		})?;
	Ok(())
}

#[cfg(test)]
mod tests {
	//! One client's threads carry each request line to the answering side and
	//! each reply back, and a client that hangs up disconnects its reply
	//! channel, which is how its parked waits learn it is gone.
	//!
	//! Gap: the accept loop and the app-side task that answers are not run;
	//! the answering side here is the test itself.

	use std::{
		io::{self, BufRead, BufReader, Write},
		os::unix::net::UnixStream,
		thread,
		time::{Duration, Instant},
	};

	use super::{Incoming, serve};

	const PATIENCE: Duration = Duration::from_secs(5);

	fn next(incoming: &flume::Receiver<Incoming>) -> io::Result<Incoming> {
		incoming.recv_timeout(PATIENCE).map_err(io::Error::other)
	}

	#[test]
	fn each_line_reaches_the_answerer_and_its_reply_reaches_the_client() -> io::Result<()> {
		let (client, server) = UnixStream::pair()?;
		client.set_read_timeout(Some(PATIENCE))?;
		let (requests, incoming) = flume::unbounded();
		serve(server, requests)?;
		(&client).write_all(b"first\n\n  \nsecond\n")?;
		let mut replies = BufReader::new(&client);
		for expected in ["first", "second"] {
			let request = next(&incoming)?;
			assert_eq!(request.line, expected, "blank lines are skipped");
			request
				.reply
				.send(format!("re {expected}"))
				.map_err(io::Error::other)?;
			let mut line = String::new();
			replies.read_line(&mut line)?;
			assert_eq!(line, format!("re {expected}\n"));
		}
		Ok(())
	}

	#[test]
	fn a_client_that_hangs_up_disconnects_its_reply_channel() -> io::Result<()> {
		let (client, server) = UnixStream::pair()?;
		let (requests, incoming) = flume::unbounded();
		serve(server, requests)?;
		(&client).write_all(b"{\"wait\":\"idle\"}\n")?;
		let request = next(&incoming)?;
		assert!(!request.reply.is_disconnected(), "the client is connected");
		drop(client);
		let deadline = Instant::now() + PATIENCE;
		while !request.reply.is_disconnected() {
			assert!(Instant::now() < deadline, "the reply channel outlived its client");
			thread::sleep(Duration::from_millis(5));
		}
		Ok(())
	}
}
