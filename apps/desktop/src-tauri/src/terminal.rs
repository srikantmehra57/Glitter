//! The integrated terminal: interactive shells on a PTY, one per open terminal
//! pane, each started in a granted workspace root. The commands in `lib.rs`
//! resolve grants and relay output; this module owns the processes.
//!
//! A terminal takes its keystrokes from the renderer. Unlike every other
//! native command it cannot authorize what it is asked to run, so opening one
//! is the user-visible act of trust (see DECISIONS.md).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

/// Shells open at once. A pane holds one; the cap bounds what a looping renderer can spawn.
pub const MAX_TERMINALS: usize = 8;
/// Bytes accepted per write: far more than a paste, far less than a flood.
pub const WRITE_LIMIT: usize = 64 * 1024;
/// Longest a held burst of output waits for more before it is emitted,
/// mirroring `FLUSH_MS` in `packages/glitter-bridge/src/output.ts`.
const OUTPUT_FLUSH_MS: Duration = Duration::from_millis(12);
/// A held burst this large is emitted at once instead of waiting out the
/// timer, mirroring `FLUSH_CHARS` in the bridge.
const OUTPUT_FLUSH_BYTES: usize = 64 * 1024;

pub enum Event {
    Output(Vec<u8>),
    /// The shell ended, with its exit code when the platform reported one.
    Exit(Option<u32>),
}

/// What the reader thread hands the coalescing thread. One channel carries
/// both so the exit stays ordered behind every output the reader sent.
enum ReadEvent {
    Output(Vec<u8>),
    Exited(Option<u32>),
}

struct Session {
    grant: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct Terminals {
    sessions: HashMap<String, Session>,
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        cols: cols.clamp(2, 500),
        rows: rows.clamp(1, 300),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The user's own shell as a login shell, so the PATH a GUI app never
/// inherits is set up the way their terminal sets it up.
fn shell_command(root: &Path) -> CommandBuilder {
    let shell = std::env::var("SHELL").ok().filter(|shell| Path::new(shell).is_absolute() && Path::new(shell).exists()).unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    cmd.arg("-l");
    cmd.cwd(root);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 35 && id.starts_with("pt-") && id[3..].chars().all(|ch| ch.is_ascii_hexdigit())
}

impl Terminals {
    /// Start a shell in `root`. `on_event` is called from a coalescing
    /// thread with merged bursts of output and once when the shell ends.
    pub fn open(&mut self, grant: &str, root: &Path, cols: u16, rows: u16, on_event: impl Fn(&str, Event) + Send + 'static) -> Result<String, String> {
        if self.sessions.len() >= MAX_TERMINALS {
            return Err("Too many terminals are open. Close one first.".into());
        }
        let pair = native_pty_system().openpty(size(cols, rows)).map_err(|err| format!("Could not open a terminal: {err}"))?;
        let mut child = pair.slave.spawn_command(shell_command(root)).map_err(|err| format!("Could not start your shell: {err}"))?;
        // The shell holds its own end; ours must close so the reader sees EOF when the shell exits.
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().map_err(|err| format!("Could not read from the terminal: {err}"))?;
        let writer = pair.master.take_writer().map_err(|err| format!("Could not write to the terminal: {err}"))?;
        let id = format!("pt-{}", uuid::Uuid::new_v4().simple());
        self.sessions.insert(
            id.clone(),
            Session {
                grant: grant.to_string(),
                master: pair.master,
                writer,
                killer: child.clone_killer(),
                pid: child.process_id(),
            },
        );
        let reader_id = id.clone();
        // Reads are at most 8 KiB, so a busy shell would otherwise put a
        // serialized `terminal-output` event on the wire per read — over a
        // hundred a second per MiB/s. A second thread coalesces the stream
        // the way the bridge merges deltas; the single channel keeps the
        // exit ordered behind every output chunk the reader produced.
        let (tx, rx) = std::sync::mpsc::channel::<ReadEvent>();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if tx.send(ReadEvent::Output(chunk[..read].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = tx.send(ReadEvent::Exited(child.wait().ok().map(|status| status.exit_code())));
        });
        std::thread::spawn(move || coalesce_output(&reader_id, rx, on_event));
        Ok(id)
    }

    pub fn write(&mut self, id: &str, data: &[u8]) -> Result<(), String> {
        if data.len() > WRITE_LIMIT {
            return Err("That is too much to send to the terminal at once.".into());
        }
        let session = self.sessions.get_mut(id).ok_or("That terminal has closed.")?;
        session.writer.write_all(data).and_then(|_| session.writer.flush()).map_err(|err| format!("Could not write to the terminal: {err}"))
    }

    pub fn resize(&mut self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.sessions.get(id).ok_or("That terminal has closed.")?;
        session.master.resize(size(cols, rows)).map_err(|err| format!("Could not resize the terminal: {err}"))
    }

    /// Forget a terminal whose shell has ended. Returns whether it was known.
    pub fn forget(&mut self, id: &str) -> bool {
        self.sessions.remove(id).is_some()
    }

    /// End a terminal: the shell and everything it started. Dropping the
    /// session closes the PTY, which hangs up whatever was still attached.
    pub fn close(&mut self, id: &str) {
        if let Some(mut session) = self.sessions.remove(id) {
            // The shell leads its own session and process group, so this reaches what it started.
            if let Some(pid) = session.pid {
                super::process::kill_tree(pid);
            }
            let _ = session.killer.kill();
        }
    }

    /// End every terminal opened through one of these grants.
    pub fn close_grants(&mut self, grants: &[String]) {
        let ids: Vec<String> = self.sessions.iter().filter(|(_, session)| grants.contains(&session.grant)).map(|(id, _)| id.clone()).collect();
        for id in ids {
            self.close(&id);
        }
    }

    pub fn close_all(&mut self) {
        let ids: Vec<String> = self.sessions.keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.sessions.len()
    }
}

/// One terminal's output, coalesced for IPC. Held bytes are emitted once
/// `OUTPUT_FLUSH_BYTES` have piled up or `OUTPUT_FLUSH_MS` after the first
/// held byte, whichever comes first — the same merge the bridge applies to
/// deltas (`queueDelta` in `packages/glitter-bridge/src/output.ts`). `Exited`
/// flushes what is held before the exit is reported, so a listener observes
/// the same ordering as an unmerged stream.
fn coalesce_output(id: &str, rx: Receiver<ReadEvent>, on_event: impl Fn(&str, Event)) {
    let mut pending: Vec<u8> = Vec::new();
    let mut deadline: Option<Instant> = None;
    loop {
        let next = match deadline {
            // recv_timeout(0) is a non-blocking drain: a passed deadline still
            // picks up already-queued output before the held bytes go out.
            Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
            None => rx.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        match next {
            Ok(ReadEvent::Output(bytes)) => {
                if pending.is_empty() {
                    deadline = Some(Instant::now() + OUTPUT_FLUSH_MS);
                }
                pending.extend_from_slice(&bytes);
                if pending.len() >= OUTPUT_FLUSH_BYTES {
                    on_event(id, Event::Output(std::mem::take(&mut pending)));
                    deadline = None;
                }
            }
            Ok(ReadEvent::Exited(code)) => {
                if !pending.is_empty() {
                    on_event(id, Event::Output(std::mem::take(&mut pending)));
                }
                on_event(id, Event::Exit(code));
                return;
            }
            Err(RecvTimeoutError::Timeout) => {
                // A deadline only exists while bytes are held.
                on_event(id, Event::Output(std::mem::take(&mut pending)));
                deadline = None;
            }
            Err(RecvTimeoutError::Disconnected) => {
                // The reader always sends Exited before it dies; a bare
                // disconnect means it died first — deliver what is held, then
                // an exit with no code so the pane is not left "running".
                if !pending.is_empty() {
                    on_event(id, Event::Output(std::mem::take(&mut pending)));
                }
                on_event(id, Event::Exit(None));
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{coalesce_output, Event, ReadEvent, OUTPUT_FLUSH_BYTES};
    use std::sync::mpsc::{channel, Receiver};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    enum Seen {
        Output(Vec<u8>),
        Exit(Option<u32>),
    }

    fn run(rx: Receiver<ReadEvent>) -> (thread::JoinHandle<()>, Arc<Mutex<Vec<Seen>>>) {
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::new(Mutex::new(Vec::new()));
        let into = Arc::clone(&seen);
        let handle = thread::spawn(move || {
            coalesce_output("pt-test", rx, move |_, event| {
                into.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).push(match event {
                    Event::Output(bytes) => Seen::Output(bytes),
                    Event::Exit(code) => Seen::Exit(code),
                });
            });
        });
        (handle, seen)
    }

    /// Poll briefly so the deadline assertion below does not depend on the
    /// coalescing thread being scheduled inside one sleep.
    fn wait_for(seen: &Arc<Mutex<Vec<Seen>>>, count: usize) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if seen.lock().unwrap_or_else(|p| p.into_inner()).len() >= count {
                return true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        false
    }

    #[test]
    fn held_output_flushes_before_the_exit_is_reported() {
        let (tx, rx) = channel();
        // Sent ahead of the listener: channel order, not timing, decides.
        tx.send(ReadEvent::Output(b"one".to_vec())).expect("send");
        tx.send(ReadEvent::Output(b"two".to_vec())).expect("send");
        tx.send(ReadEvent::Exited(Some(3))).expect("send");
        drop(tx);
        let (handle, seen) = run(rx);
        handle.join().expect("coalescer finishes");
        let seen = seen.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(seen.len(), 2, "the held reads merge into one event before the exit");
        match &seen[0] {
            Seen::Output(bytes) => assert_eq!(bytes, b"onetwo"),
            _ => panic!("the merged output leads"),
        }
        assert!(matches!(seen[1], Seen::Exit(Some(3))), "the exit follows with its code");
    }

    #[test]
    fn a_full_burst_emits_instead_of_merging_past_the_cap() {
        let (tx, rx) = channel();
        tx.send(ReadEvent::Output(vec![b'x'; OUTPUT_FLUSH_BYTES])).expect("send");
        tx.send(ReadEvent::Output(b"tail".to_vec())).expect("send");
        tx.send(ReadEvent::Exited(None)).expect("send");
        drop(tx);
        let (handle, seen) = run(rx);
        handle.join().expect("coalescer finishes");
        let seen = seen.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(seen.len(), 3, "the full burst leaves before the tail merges");
        assert!(matches!(&seen[0], Seen::Output(bytes) if bytes.len() == OUTPUT_FLUSH_BYTES));
        assert!(matches!(&seen[1], Seen::Output(bytes) if bytes == b"tail"));
        assert!(matches!(seen[2], Seen::Exit(None)), "a missing code still reports");
    }

    #[test]
    fn held_output_leaves_at_the_deadline_without_an_exit() {
        let (tx, rx) = channel();
        tx.send(ReadEvent::Output(b"abc".to_vec())).expect("send");
        let (handle, seen) = run(rx);
        assert!(wait_for(&seen, 1), "the deadline flushed the held bytes");
        // The thread still waits on the channel: the deadline did not end it.
        assert!(!handle.is_finished());
        tx.send(ReadEvent::Exited(Some(0))).expect("send");
        drop(tx);
        handle.join().expect("coalescer finishes");
        let seen = seen.lock().unwrap_or_else(|p| p.into_inner());
        assert_eq!(seen.len(), 2, "the deadline emit and the exit are separate");
        assert!(matches!(&seen[0], Seen::Output(bytes) if bytes == b"abc"));
        assert!(matches!(seen[1], Seen::Exit(Some(0))));
    }

    #[test]
    fn a_dropped_reader_still_delivers_held_output_then_exits() {
        let (tx, rx) = channel();
        tx.send(ReadEvent::Output(b"tail".to_vec())).expect("send");
        drop(tx);
        let (handle, seen) = run(rx);
        handle.join().expect("coalescer finishes");
        let seen = seen.lock().unwrap_or_else(|p| p.into_inner());
        // A reader that dies without Exited must not leave the pane "running":
        // the held bytes flush first, then an exit with no code.
        assert_eq!(seen.len(), 2, "the flush and the exit both reach the listener");
        assert!(matches!(&seen[0], Seen::Output(bytes) if bytes == b"tail"));
        assert!(matches!(seen[1], Seen::Exit(None)), "a dead reader reports an exit with no code");
    }
}
