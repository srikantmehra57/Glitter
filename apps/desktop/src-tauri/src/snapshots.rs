//! Native, bounded turn checkpoints. Objects and a disposable index live in a
//! private bare repository, so the workspace's index, HEAD and refs never move.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const FILE_LIMIT: usize = 2000;
const FILE_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const OUTPUT_BYTES: u64 = 96 * 1024 * 1024;
const METADATA_BYTES: usize = 1024 * 1024;
const RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
const RECORD_LIMIT: usize = 100;
/// Pins each snapshot's trees in the private store. Builds named Muse Code
/// pinned under `refs/muse`; those refs are still deleted with their records.
const REF_PREFIX: &str = "refs/glitter";
const LEGACY_REF_PREFIX: &str = "refs/muse";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshot {
    pub snapshot_id: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub state: String,
    pub files: Vec<String>,
    pub reason: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    info: TurnSnapshot,
    grant: String,
    root: PathBuf,
    client_key: Option<String>,
    before: Option<String>,
    after: Option<String>,
    /// Persist intent before writing files, so a relaunch can reconcile a
    /// completed apply whose final metadata write was interrupted.
    #[serde(default)]
    restore_to: Option<String>,
    /// Latest completed restore, independent of the turn's creation time.
    #[serde(default)]
    last_restore: Option<Restoration>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Restoration {
    id: String,
    at: u64,
}

#[derive(Serialize)]
pub struct RestoreContext {
    id: String,
    text: String,
}

fn restoration() -> Restoration {
    Restoration {
        id: uuid::Uuid::new_v4().to_string(),
        at: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_micros() as u64).unwrap_or(0),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub snapshot: TurnSnapshot,
    pub conflicts: Vec<String>,
}

#[derive(Default)]
pub struct Snapshots {
    dir: Option<PathBuf>,
    records: BTreeMap<String, Record>,
    requests: HashMap<String, String>,
    active: HashMap<String, String>,
    stop_requests: HashSet<String>,
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    mode: String,
    oid: String,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|t| t.as_secs()).unwrap_or(0)
}

fn git_command() -> Command {
    let mut cmd = super::command("git");
    // No ambient repository/index/alternate object store or config injection.
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
    cmd.env("GIT_CONFIG_NOSYSTEM", "1").env("GIT_CONFIG_GLOBAL", "/dev/null");
    cmd.env("GIT_ATTR_NOSYSTEM", "1").arg("-c").arg("core.attributesFile=/dev/null");
    cmd.arg("--no-optional-locks").args(["-c", "core.autocrlf=false", "-c", "core.filemode=true", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.algorithm=myers"]);
    cmd
}

fn run(mut cmd: Command, args: &[&str], input: &[u8], cap: u64) -> Result<Vec<u8>, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| "Git is unavailable for turn snapshots.".to_string())?;
    let pid = child.id();
    let mut stdin = child.stdin.take().ok_or("Snapshot input is unavailable.")?;
    // Drain output while writing a binary patch, which can exceed pipe buffers.
    let data = input.to_vec();
    let stdout = child.stdout.take().ok_or("Snapshot output is unavailable.")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let result = (|| {
            let writer = std::thread::spawn(move || stdin.write_all(&data));
            let mut output = Vec::new();
            let read = stdout.take(cap + 1).read_to_end(&mut output);
            if read.is_err() || output.len() as u64 > cap {
                super::process::kill_tree_now(pid);
            }
            let status = child.wait().map_err(|_| "Snapshot command did not finish.".to_string())?;
            let written = writer.join().map_err(|_| "Snapshot input failed.".to_string())?;
            if read.is_err() || output.len() as u64 > cap {
                return Err("Snapshot command exceeded its output limit.".into());
            }
            if !status.success() || written.is_err() {
                return Err("Snapshot command failed. Workspace files were not captured.".into());
            }
            Ok(output)
        })();
        let _ = tx.send(result);
    });
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(result) => result,
        Err(_) => {
            super::process::kill_tree_with_grace(pid, Duration::from_millis(800));
            let _ = rx.recv_timeout(Duration::from_secs(2));
            Err("Undo is unavailable: a snapshot command took too long.".into())
        }
    }
}

fn valid_path(raw: &str) -> bool {
    !raw.is_empty() && raw.len() <= 4096 && !raw.contains(['\0', '\\']) && Path::new(raw).components().all(|p| matches!(p, Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git")))
}

/// Check every component, including parents of a missing file. No symlink,
/// repository metadata, device, socket, or path outside the grant is eligible.
fn confined(root: &Path, raw: &str) -> Result<PathBuf, String> {
    if !valid_path(raw) {
        return Err("Snapshot contains an unsupported path.".into());
    }
    let mut path = root.to_path_buf();
    let parts: Vec<_> = Path::new(raw).components().collect();
    for (index, part) in parts.iter().enumerate() {
        path.push(part.as_os_str());
        match path.symlink_metadata() {
            Ok(meta) if meta.is_symlink() || (!meta.is_dir() && index + 1 < parts.len()) => return Err("A snapshot path is a symlink or its parent changed.".into()),
            Ok(meta) if index + 1 == parts.len() && !meta.is_file() => return Err("A snapshot path is not a regular file.".into()),
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("A snapshot file is unavailable.".into()),
        }
    }
    if let Ok(canon) = path.canonicalize() {
        if !canon.starts_with(root) {
            return Err("Snapshot paths must stay in the workspace.".into());
        }
    }
    Ok(path)
}

fn file_list(root: &Path) -> Result<Vec<String>, String> {
    let mut check = git_command();
    check.current_dir(root);
    let repository = run(check, &["rev-parse", "--is-inside-work-tree"], &[], 1024);
    if matches!(repository.as_deref(), Ok(b"true\n")) {
        let mut cmd = git_command();
        cmd.current_dir(root);
        // `-- .` plus cwd-relative output scopes even a nested workspace grant.
        let output = run(cmd, &["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], &[], 8 * 1024 * 1024)?;
        let text = String::from_utf8(output).map_err(|_| "Snapshot paths must be UTF-8.".to_string())?;
        let mut paths: Vec<_> = text.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
        paths.sort();
        paths.dedup();
        if paths.len() > FILE_LIMIT {
            return Err("Undo is unavailable: more than 2,000 workspace files.".into());
        }
        return Ok(paths);
    }
    // Non-git folders use the same bounded files policy as the file index,
    // including dotfiles, but never repository metadata or build directories.
    let mut paths = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut entries_seen = 0;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).map_err(|_| "A snapshot directory is unavailable.".to_string())? {
            let entry = entry.map_err(|_| "A snapshot entry is unavailable.".to_string())?;
            entries_seen += 1;
            if entries_seen > 10_000 {
                return Err("Undo is unavailable: workspace scan limit reached.".into());
            }
            let name = entry.file_name();
            let name = name.to_str().ok_or("Snapshot paths must be UTF-8.")?;
            let kind = entry.file_type().map_err(|_| "A snapshot entry is unavailable.".to_string())?;
            if name.eq_ignore_ascii_case(".git") || (kind.is_dir() && super::FILE_INDEX_SKIP.contains(&name)) {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                let path = entry.path();
                let raw = path.strip_prefix(root).map_err(|_| "Snapshot paths must stay in the workspace.")?.to_str().ok_or("Snapshot paths must be UTF-8.")?.to_string();
                paths.push(raw);
                if paths.len() > FILE_LIMIT {
                    return Err("Undo is unavailable: more than 2,000 workspace files.".into());
                }
            } else {
                return Err("Undo is unavailable: workspace contains symlinks or special files.".into());
            }
        }
    }
    paths.sort();
    Ok(paths)
}

impl Snapshots {
    pub fn open(&mut self, dir: PathBuf) -> Result<(), String> {
        if self.dir.is_some() {
            return Ok(());
        }
        std::fs::create_dir_all(&dir).map_err(|_| "Snapshot storage is unavailable.".to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).map_err(|_| "Snapshot storage permissions failed.".to_string())?;
        }
        let repo = dir.join("objects.git");
        if !repo.exists() {
            let mut cmd = git_command();
            cmd.current_dir(&dir);
            run(cmd, &["init", "--bare", "--template=", repo.to_str().ok_or("Snapshot storage path is unsupported.")?], &[], 4096)?;
        }
        // Private attributes override the workspace's conversions. Checkpoints
        // contain raw bytes, so apply/index checks must also see those bytes,
        // including CRLF, $Id$ expansions and non-UTF-8 file encodings.
        std::fs::create_dir_all(repo.join("info")).map_err(|_| "Snapshot storage is unavailable.")?;
        std::fs::write(repo.join("info/attributes"), b"* -text -eol -crlf -ident -filter -working-tree-encoding\n").map_err(|_| "Snapshot storage is unavailable.")?;
        let records_dir = dir.join("records");
        std::fs::create_dir_all(&records_dir).map_err(|_| "Snapshot storage is unavailable.".to_string())?;
        self.dir = Some(dir);
        // Bounded native metadata; file content stays in the private object store.
        for entry in std::fs::read_dir(records_dir).map_err(|_| "Snapshot storage is unavailable.".to_string())?.take(1000).flatten() {
            if entry.path().extension().and_then(|p| p.to_str()) != Some("json") {
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.len() > METADATA_BYTES as u64 {
                continue;
            }
            let Ok(raw) = std::fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut record) = serde_json::from_slice::<Record>(&raw) else {
                continue;
            };
            if !valid_id(&record.info.snapshot_id) || !record.before.iter().chain(record.after.iter()).all(|t| valid_oid(t)) || record.info.files.iter().any(|p| !valid_path(p)) {
                continue;
            }
            if record.info.state == "capturing" {
                record.info.state = "unavailable".into();
                record.info.reason = Some("The app closed before the turn's end state was captured.".into());
            }
            if record.restore_to.is_some() {
                self.recover_restore(&mut record);
            }
            self.records.insert(record.info.snapshot_id.clone(), record);
        }
        self.prune()?;
        Ok(())
    }

    fn cmd(&self, root: &Path) -> Result<Command, String> {
        let dir = self.dir.as_ref().ok_or("Snapshot storage is unavailable.")?;
        let mut cmd = git_command();
        cmd.arg(format!("--git-dir={}", dir.join("objects.git").display())).arg(format!("--work-tree={}", root.display()));
        cmd.env("GIT_INDEX_FILE", dir.join("capture.index")).current_dir(root);
        Ok(cmd)
    }

    fn git(&self, root: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>, String> {
        run(self.cmd(root)?, args, input, OUTPUT_BYTES)
    }

    fn entry(&self, root: &Path, path: &str, write: bool) -> Result<Option<(Entry, u64)>, String> {
        let file_path = confined(root, path)?;
        let meta = match file_path.symlink_metadata() {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("A snapshot file is unavailable.".into()),
        };
        if meta.len() > FILE_BYTES {
            return Err("Undo is unavailable: a workspace file exceeds 2 MiB.".into());
        }
        let file = std::fs::File::open(&file_path).map_err(|_| "A snapshot file is unavailable.".to_string())?;
        if !same_file(&meta, &file.metadata().map_err(|_| "A snapshot file is unavailable.")?) {
            return Err("Undo is unavailable: a file changed during capture.".into());
        }
        let mut bytes = Vec::new();
        (&file).take(FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| "A snapshot file could not be read.".to_string())?;
        if bytes.len() as u64 > FILE_BYTES {
            return Err("Undo is unavailable: a workspace file exceeds 2 MiB.".into());
        }
        // Detect a file replaced or grown while it was read, rather than pinning
        // an impossible baseline. The pre/post stat also preserves mode changes.
        let after = file_path.symlink_metadata().map_err(|_| "A workspace file changed during capture.".to_string())?;
        if !same_file(&meta, &after) || !same_file(&meta, &file.metadata().map_err(|_| "A workspace file changed during capture.")?) {
            return Err("Undo is unavailable: a file changed during capture.".into());
        }
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
        };
        let args = if write {
            vec!["hash-object", "-w", "--no-filters", "--stdin"]
        } else {
            vec!["hash-object", "--no-filters", "--stdin"]
        };
        let oid = String::from_utf8(self.git(root, &args, &bytes)?).map_err(|_| "Snapshot hash is invalid.")?.trim().to_string();
        if !valid_oid(&oid) {
            return Err("Snapshot hash is invalid.".into());
        }
        Ok(Some((
            Entry {
                mode: mode.into(),
                oid,
            },
            bytes.len() as u64,
        )))
    }

    fn capture(&self, root: &Path, previous: Option<&BTreeMap<String, Entry>>) -> Result<String, String> {
        let started = Instant::now();
        let mut paths = file_list(root)?;
        // A new .gitignore (or git init) must not make an existing baseline
        // file look deleted while it is still present in the workspace.
        if let Some(previous) = previous {
            paths.extend(previous.keys().cloned());
        }
        paths.sort();
        paths.dedup();
        if paths.len() > FILE_LIMIT {
            return Err("Undo is unavailable: more than 2,000 workspace paths.".into());
        }
        let mut index = Vec::new();
        let mut size = 0;
        for path in paths {
            if started.elapsed() > Duration::from_secs(8) {
                return Err("Undo is unavailable: workspace capture took too long.".into());
            }
            if let Some((entry, bytes)) = self.entry(root, &path, true)? {
                size += bytes;
                if size > TOTAL_BYTES {
                    return Err("Undo is unavailable: workspace files exceed 32 MiB.".into());
                }
                index.extend_from_slice(format!("{} {}\t{path}\0", entry.mode, entry.oid).as_bytes());
            }
        }
        self.git(root, &["read-tree", "--empty"], &[])?;
        self.git(root, &["update-index", "-z", "--index-info"], &index)?;
        let tree = String::from_utf8(self.git(root, &["write-tree"], &[])?).map_err(|_| "Snapshot tree is invalid.")?.trim().to_string();
        if !valid_oid(&tree) {
            return Err("Snapshot tree is invalid.".into());
        }
        Ok(tree)
    }

    fn tree(&self, root: &Path, oid: &str) -> Result<BTreeMap<String, Entry>, String> {
        let raw = self.git(root, &["ls-tree", "-r", "-z", oid], &[])?;
        let raw = String::from_utf8(raw).map_err(|_| "Snapshot paths must be UTF-8.")?;
        let mut entries = BTreeMap::new();
        for row in raw.split('\0').filter(|s| !s.is_empty()) {
            let (head, path) = row.split_once('\t').ok_or("Snapshot tree is invalid.")?;
            let parts: Vec<_> = head.split(' ').collect();
            if parts.len() != 3 || parts[1] != "blob" || !["100644", "100755"].contains(&parts[0]) || !valid_path(path) {
                return Err("Snapshot tree contains an unsupported file.".into());
            }
            entries.insert(
                path.to_string(),
                Entry {
                    mode: parts[0].into(),
                    oid: parts[2].into(),
                },
            );
        }
        Ok(entries)
    }

    fn save(&self, record: &Record) -> Result<(), String> {
        let dir = self.dir.as_ref().ok_or("Snapshot storage is unavailable.")?.join("records");
        let path = dir.join(format!("{}.json", record.info.snapshot_id));
        let tmp = dir.join(format!("{}.tmp", record.info.snapshot_id));
        let bytes = serde_json::to_vec(record).map_err(|_| "Snapshot metadata could not be saved.".to_string())?;
        if bytes.len() > METADATA_BYTES {
            return Err("Snapshot metadata exceeds its storage limit.".into());
        }
        let mut file = std::fs::File::create(&tmp).map_err(|_| "Snapshot metadata could not be saved.".to_string())?;
        file.write_all(&bytes).and_then(|_| file.sync_all()).map_err(|_| "Snapshot metadata could not be saved.".to_string())?;
        std::fs::rename(tmp, path).map_err(|_| "Snapshot metadata could not be saved.".to_string())
    }

    fn pin(&self, record: &Record) -> Result<(), String> {
        for (name, tree) in [("before", &record.before), ("after", &record.after)] {
            if let Some(tree) = tree {
                self.git(&record.root, &["update-ref", &format!("{REF_PREFIX}/{}/{name}", record.info.snapshot_id), tree], &[])?;
            }
        }
        self.save(record)
    }

    fn unavailable(&mut self, id: &str, reason: &str) {
        if let Some(record) = self.records.get_mut(id) {
            record.info.state = "unavailable".into();
            record.info.reason = Some(reason.into());
        }
        if let Some(record) = self.records.get(id) {
            let _ = self.save(record);
        }
    }

    pub fn prepare(&mut self, request: &str, grant: &str, root: &Path, session: &str, client_key: Option<&str>, if_busy: Option<&str>) {
        if self.requests.len() >= 512 {
            return;
        }
        if let Some(key) = client_key {
            if let Some(record) = self.records.values().find(|r| r.info.session_id == session && r.grant == grant && r.client_key.as_deref() == Some(key)) {
                self.requests.insert(request.into(), record.info.snapshot_id.clone());
                return;
            }
        }
        // A submit that queues behind (or steers into) its own session's
        // running turn can never overlap it: the CLI runs a queued turn only
        // after that turn's terminal event, and a steer becomes part of it.
        // Invalidating it would destroy a baseline that is still separable;
        // only runs in other sessions truly share the workspace at once.
        let waits_on_own_turn = matches!(if_busy, Some("queue" | "steer")) && self.active.contains_key(session);
        let overlap: Vec<_> = self.active.values().filter_map(|id| self.records.get(id)).filter(|r| overlaps(root, &r.root) && !(waits_on_own_turn && r.info.session_id == session)).map(|r| r.info.snapshot_id.clone()).collect();
        for id in &overlap {
            self.unavailable(id, "Overlapping runs shared this workspace. Their changes cannot be separated.");
        }
        let reason = if if_busy == Some("queue") && waits_on_own_turn {
            // The queued turn's baseline would capture the running turn
            // mid-flight, so none is taken; its ack also marks it unavailable.
            Some("This turn was queued behind the running turn. A start-of-turn snapshot is unavailable.".to_string())
        } else if !overlap.is_empty() {
            Some("This turn was queued or overlapped another run. Undo is unavailable.".to_string())
        } else if self.active.len() >= RECORD_LIMIT {
            Some("Too many runs are active. Undo is unavailable.".to_string())
        } else {
            None
        };
        let before = if reason.is_none() {
            self.capture(root, None)
        } else {
            Err(reason.clone().unwrap_or_default())
        };
        let mut record = Record {
            info: TurnSnapshot {
                snapshot_id: format!("snap-{}", uuid::Uuid::new_v4().simple()),
                session_id: session.into(),
                turn_id: None,
                state: "capturing".into(),
                files: Vec::new(),
                reason: None,
                created_at: now(),
            },
            grant: grant.into(),
            root: root.into(),
            client_key: client_key.map(str::to_string),
            before: None,
            after: None,
            restore_to: None,
            last_restore: None,
        };
        match before {
            Ok(tree) => record.before = Some(tree),
            Err(reason) => {
                record.info.state = "unavailable".into();
                record.info.reason = Some(reason);
            }
        }
        if self.pin(&record).is_err() {
            record.info.state = "unavailable".into();
            record.info.reason = Some("Snapshot storage failed. Undo is unavailable.".into());
        }
        let id = record.info.snapshot_id.clone();
        self.records.insert(id.clone(), record);
        self.requests.insert(request.into(), id.clone());
        // A queued submit never displaces the snapshot of the running turn.
        self.active.entry(session.into()).or_insert(id.clone());
        let _ = self.prune();
        if self.records.get(&id).is_some_and(|r| r.before.is_none()) {
            if let Some(dir) = &self.dir {
                let _ = self.git(dir, &["gc", "--prune=now", "--quiet"], &[]);
            }
        }
    }

    pub fn stop_request(&mut self, request: &str) {
        self.stop_requests.insert(request.into());
    }

    pub fn failed_request(&mut self, request: &str) {
        self.stop_requests.remove(request);
        if let Some(id) = self.requests.remove(request) {
            if self.records.get(&id).is_some_and(|r| r.info.turn_id.is_none()) {
                self.active.retain(|_, active| active != &id);
                self.unavailable(&id, "The turn did not start.");
            }
        }
    }

    pub fn response(&mut self, value: &Value) {
        let Some(request) = value.get("id").and_then(Value::as_str) else {
            return;
        };
        if self.stop_requests.remove(request) {
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                self.disconnect(true);
            }
            return;
        }
        let Some(id) = self.requests.get(request).cloned() else {
            return;
        };
        if value.get("ok").and_then(Value::as_bool) != Some(true) {
            self.failed_request(request);
            return;
        }
        self.requests.remove(request);
        let result = &value["result"];
        if let Some(turn) = result.get("turnId").and_then(Value::as_str) {
            if let Some(record) = self.records.get_mut(&id) {
                record.info.turn_id = Some(turn.into());
            }
        }
        if result.get("disposition").and_then(Value::as_str) == Some("queued") {
            self.active.retain(|_, active| active != &id);
            self.unavailable(&id, "This turn was queued. A start-of-turn snapshot is unavailable.");
        } else if result.get("disposition").and_then(Value::as_str) == Some("steered") {
            // A steering send folded into the running turn: no new turn was
            // created, so this record can never become a checkpoint.
            self.active.retain(|_, active| active != &id);
            self.unavailable(&id, "This message steered the running turn; there is no separate turn to restore.");
        }
        if let Some(record) = self.records.get(&id) {
            let _ = self.save(record);
        }
    }

    pub fn event(&mut self, event: &str, payload: &Value, binding: Option<(&str, &Path)>) -> Vec<TurnSnapshot> {
        if matches!(event, "bridgeExit" | "connectionError") {
            return self.disconnect(event == "bridgeExit");
        }
        let Some(session) = payload.get("sessionId").and_then(Value::as_str) else {
            return Vec::new();
        };
        let Some(turn) = payload.get("turnId").and_then(Value::as_str).or_else(|| payload["item"]["turnId"].as_str()) else {
            return Vec::new();
        };
        if event == "item" && matches!(payload["item"]["status"].as_str(), Some("inProgress" | "running")) && !self.active.contains_key(session) {
            return self.event("turnStarted", &serde_json::json!({ "sessionId": session, "turnId": turn }), binding);
        }
        if event == "turnStarted" {
            if let Some(id) = self.active.get(session).cloned() {
                if let Some(record) = self.records.get_mut(&id) {
                    if record.info.turn_id.as_deref().is_none_or(|id| id == turn) {
                        record.info.turn_id = Some(turn.into());
                        let copy = record.clone();
                        let _ = self.save(&copy);
                        return vec![copy.info];
                    }
                }
            }
            // Queued/external turns have no pre-submit baseline. Never capture
            // one after tools may already have started executing.
            if let Some((grant, root)) = binding {
                let overlaps: Vec<_> = self.active.values().filter_map(|id| self.records.get(id)).filter(|r| overlaps(root, &r.root)).map(|r| r.info.snapshot_id.clone()).collect();
                for id in overlaps {
                    self.unavailable(&id, "Overlapping runs shared this workspace. Their changes cannot be separated.");
                }
                let existing = self.records.values().find(|r| r.info.session_id == session && r.info.turn_id.as_deref() == Some(turn)).map(|r| r.info.snapshot_id.clone());
                let id = existing.unwrap_or_else(|| {
                    let id = format!("snap-{}", uuid::Uuid::new_v4().simple());
                    self.records.insert(
                        id.clone(),
                        Record {
                            info: TurnSnapshot {
                                snapshot_id: id.clone(),
                                session_id: session.into(),
                                turn_id: Some(turn.into()),
                                state: "unavailable".into(),
                                files: Vec::new(),
                                reason: Some("No snapshot was captured before this turn started.".into()),
                                created_at: now(),
                            },
                            grant: grant.into(),
                            root: root.into(),
                            client_key: None,
                            before: None,
                            after: None,
                            restore_to: None,
                            last_restore: None,
                        },
                    );
                    id
                });
                self.active.insert(session.into(), id.clone());
                if let Some(record) = self.records.get(&id) {
                    let _ = self.save(record);
                    return vec![record.info.clone()];
                }
            }
        }
        if !matches!(event, "turnCompleted" | "turnError") || payload["outcome"]["kind"].as_str() == Some("unqueued") {
            return Vec::new();
        }
        let Some(id) = self.active.get(session).cloned() else {
            return Vec::new();
        };
        let Some(mut record) = self.records.get(&id).cloned() else {
            return Vec::new();
        };
        if record.info.turn_id.as_deref().is_some_and(|t| t != turn) {
            return Vec::new();
        }
        record.info.turn_id = Some(turn.into());
        if binding.is_none_or(|(grant, root)| grant != record.grant || root != record.root) {
            record.info.state = "unavailable".into();
            record.info.reason = Some("Workspace access changed before capture finished.".into());
        }
        if record.info.state == "capturing" {
            let finished: Result<(String, Vec<String>), String> = (|| {
                let before = record.before.as_ref().ok_or("Snapshot baseline is unavailable.")?;
                let old = self.tree(&record.root, before)?;
                let after = self.capture(&record.root, Some(&old))?;
                let new = self.tree(&record.root, &after)?;
                let files: Vec<_> = old.keys().chain(new.keys()).collect::<std::collections::BTreeSet<_>>().into_iter().filter(|p| old.get(*p) != new.get(*p)).cloned().collect();
                Ok((after, files))
            })();
            match finished {
                Ok((after, files)) => {
                    record.after = Some(after);
                    record.info.files = files;
                    record.info.state = "ready".into();
                }
                Err(reason) => {
                    record.info.state = "unavailable".into();
                    record.info.reason = Some(reason);
                }
            }
        }
        if self.pin(&record).is_err() {
            record.info.files.clear();
            record.info.state = "unavailable".into();
            record.info.reason = Some("The end snapshot could not be saved. Undo is unavailable.".into());
        }
        self.active.remove(session);
        self.records.insert(id, record.clone());
        vec![record.info]
    }

    fn disconnect(&mut self, stopped: bool) -> Vec<TurnSnapshot> {
        // A connection error may precede process shutdown; only exit or the
        // stop acknowledgement may release the running markers.
        let ids: HashSet<_> = self.active.values().filter_map(|id| self.records.get(id)).map(|record| record.info.snapshot_id.clone()).collect();
        for id in &ids {
            self.unavailable(id, "The connection ended before the turn's end state was captured.");
        }
        if stopped {
            self.active.retain(|_, id| !ids.contains(id));
            self.requests.retain(|_, id| !ids.contains(id));
            self.stop_requests.clear();
        }
        ids.iter().filter_map(|id| self.records.get(id).map(|record| record.info.clone())).collect()
    }

    pub fn list(&mut self, grant: &str, root: &Path, session: &str) -> Vec<TurnSnapshot> {
        let _ = self.prune();
        self.records.values().filter(|r| r.grant == grant && r.root == root && r.info.session_id == session && r.info.turn_id.is_some() && now().saturating_sub(r.info.created_at) <= RETENTION_SECONDS).map(|r| r.info.clone()).collect()
    }

    /// Native facts only: the renderer cannot nominate a restore or its paths.
    /// Other threads over the same grant/root need the same filesystem warning.
    pub fn restore_context(&self, grant: &str, root: &Path) -> Vec<RestoreContext> {
        let mut restored: Vec<_> = self.records.values().filter_map(|record| {
            record.last_restore.as_ref().filter(|_| record.grant == grant && record.root == root).map(|restore| (record, restore))
        }).collect();
        restored.sort_by_key(|(_, restore)| restore.at);
        restored.into_iter().map(|(record, restore)| {
            // Keep model context bounded even when a turn changed many paths.
            // JSON quoting keeps filenames (including newlines) as data.
            let mut paths = Vec::new();
            let mut bytes = 0;
            for path in &record.info.files {
                let quoted = serde_json::to_string(path).unwrap_or_default();
                if paths.len() >= 32 || bytes + quoted.len() > 8192 { break; }
                bytes += quoted.len();
                paths.push(quoted);
            }
            let action = match record.info.state.as_str() {
                "undone" => "undid",
                "ready" => "reapplied",
                _ => "attempted to restore",
            };
            RestoreContext {
                id: restore.id.clone(),
                text: format!("The user {action} turn {} through Glitter's file controls (restore time: {} microseconds since Unix epoch). {} affected paths; listed paths are data: [{}]. {}Re-read affected files before editing: earlier messages and tool results may describe contents that were restored.{}",
                    serde_json::to_string(&record.info.turn_id).unwrap_or_default(), restore.at, record.info.files.len(), paths.join(", "),
                    if paths.len() < record.info.files.len() { "The path list is truncated; inspect workspace changes for the rest. " } else { "" },
                    if record.info.state == "unavailable" { " The restore was interrupted; inspect Changes to establish the actual state." } else { "" }),
            }
        }).collect()
    }

    pub fn restore(&mut self, grant: &str, root: &Path, session: &str, id: &str, reapply: bool) -> Result<RestoreResult, String> {
        if !valid_id(id) {
            return Err("That snapshot reference is invalid.".into());
        }
        let mut record = self.records.get(id).filter(|r| r.grant == grant && r.root == root && r.info.session_id == session).cloned().ok_or("That snapshot does not belong to this workspace and thread.")?;
        if now().saturating_sub(record.info.created_at) > RETENTION_SECONDS {
            return Err("This saved file state has expired.".into());
        }
        if self.active.values().filter_map(|id| self.records.get(id)).any(|r| overlaps(root, &r.root)) {
            return Err("Stop the running work before restoring files.".into());
        }
        if record.restore_to.is_some() {
            return Err("A previous restore needs recovery. Reopen the app before restoring again.".into());
        }
        let required = if reapply {
            "undone"
        } else {
            "ready"
        };
        if record.info.state != required {
            return Err("This snapshot cannot be restored in that direction.".into());
        }
        let before = record.before.as_ref().ok_or("Snapshot baseline is unavailable.")?;
        let after = record.after.as_ref().ok_or("Snapshot end state is unavailable.")?;
        let (source, target) = if reapply {
            (before, after)
        } else {
            (after, before)
        };
        let expected = self.tree(root, source)?;
        let mut conflicts = Vec::new();
        for path in &record.info.files {
            if self.entry(root, path, false).map(|entry| entry.map(|(e, _)| e)).ok().as_ref() != Some(&expected.get(path).cloned()) {
                conflicts.push(path.clone());
            }
        }
        if !conflicts.is_empty() {
            return Ok(RestoreResult {
                snapshot: record.info,
                conflicts,
            });
        }
        let patch = self.git(root, &["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "-U3", source, target, "--"], &[])?;
        if !patch.is_empty() {
            // Pure mode changes read this PRIVATE index, never the user's index.
            self.git(root, &["read-tree", source], &[])?;
            // read-tree has no worktree stat cache. Refresh only this private
            // index; unrelated later edits may make refresh return nonzero,
            // but apply --index still checks every affected file in full.
            let _ = self.git(root, &["update-index", "--refresh"], &[]);
            self.git(root, &["apply", "--index", "--check", "--binary", "--whitespace=nowarn"], &patch).map_err(|_| "Files changed before restore. Nothing was restored.".to_string())?;
            record.restore_to = Some(
                if reapply {
                    "ready"
                } else {
                    "undone"
                }
                .into(),
            );
            self.save(&record)?;
            self.records.insert(id.into(), record.clone());
            if self.git(root, &["apply", "--index", "--binary", "--whitespace=nowarn"], &patch).is_err() {
                self.recover_restore(&mut record);
                self.records.insert(id.into(), record);
                return Err("Restore failed. The saved states are retained; inspect Changes before retrying.".into());
            }
        }
        record.info.state = if reapply {
            "ready"
        } else {
            "undone"
        }
        .into();
        record.restore_to = None;
        record.last_restore = Some(restoration());
        self.save(&record).map_err(|_| "Files were restored, but the checkpoint status could not be saved. Reopen the app before restoring again.".to_string())?;
        self.records.insert(id.into(), record.clone());
        Ok(RestoreResult {
            snapshot: record.info,
            conflicts: Vec::new(),
        })
    }

    /// Immutable before -> after review, even after Undo. Never scans or writes
    /// the workspace; the grant/root/session checks authorize the saved bytes.
    pub fn review(&self, grant: &str, root: &Path, session: &str, id: &str) -> Result<super::GitReview, String> {
        if !valid_id(id) {
            return Err("That snapshot reference is invalid.".into());
        }
        let record = self.records.get(id).filter(|record| record.grant == grant && record.root == root && record.info.session_id == session).ok_or("That snapshot does not belong to this workspace and thread.")?;
        if now().saturating_sub(record.info.created_at) > RETENTION_SECONDS {
            return Err("This saved file state has expired.".into());
        }
        if !matches!(record.info.state.as_str(), "ready" | "undone") {
            return Err(record.info.reason.clone().unwrap_or_else(|| "The turn's saved file state is not ready.".into()));
        }
        let before = record.before.as_deref().ok_or("This turn has no saved before state.")?;
        let after = record.after.as_deref().ok_or("This turn has no saved after state.")?;
        let metadata_args = |mode: &'static str| vec!["diff", mode, "-z", "--no-ext-diff", "--no-textconv", "--no-renames", before, after, "--"];
        let (names, names_cut) = super::run_git_command_capped(self.cmd(root)?, &metadata_args("--name-status"), super::DIFF_LIMIT)?;
        let (counts, counts_cut) = super::run_git_command_capped(self.cmd(root)?, &metadata_args("--numstat"), super::DIFF_LIMIT)?;
        let (mut diff, diff_cut) = super::run_git_command_capped(self.cmd(root)?, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "-U3", "--src-prefix=a/", "--dst-prefix=b/", before, after, "--"], super::DIFF_LIMIT)?;
        let mut truncated = names_cut || counts_cut || diff_cut;
        let files = super::review_files(&names, &counts, &mut truncated);
        if truncated {
            diff.push_str("\n…truncated");
        }
        Ok(super::GitReview {
            files,
            diff,
            truncated,
            base_commit: None,
            head_commit: None,
        })
    }

    fn recover_restore(&self, record: &mut Record) {
        let Some(next) = record.restore_to.clone() else {
            return;
        };
        let matches = |tree: &Option<String>| -> bool { tree.as_ref().and_then(|tree| self.tree(&record.root, tree).ok()).is_some_and(|entries| record.info.files.iter().all(|path| self.entry(&record.root, path, false).map(|entry| entry.map(|(e, _)| e)).ok().as_ref() == Some(&entries.get(path).cloned()))) };
        let target = if next == "undone" {
            &record.before
        } else {
            &record.after
        };
        let source = if next == "undone" {
            &record.after
        } else {
            &record.before
        };
        if ["ready", "undone"].contains(&next.as_str()) && matches(target) {
            record.info.state = next;
            record.last_restore = Some(restoration());
        } else if !matches(source) {
            record.info.state = "unavailable".into();
            record.info.reason = Some("Restore was interrupted and files match neither saved state. Inspect Changes before editing; the saved states are retained.".into());
            record.last_restore = Some(restoration());
        }
        record.restore_to = None;
        let _ = self.save(record);
    }

    fn prune(&mut self) -> Result<(), String> {
        let mut order: Vec<_> = self.records.values().filter(|r| !self.active.values().any(|id| id == &r.info.snapshot_id)).map(|r| (r.info.created_at, r.info.snapshot_id.clone())).collect();
        order.sort();
        let excess = self.records.len().saturating_sub(RECORD_LIMIT);
        let mut removed = false;
        for (index, (created, id)) in order.into_iter().enumerate() {
            if index >= excess && now().saturating_sub(created) <= RETENTION_SECONDS {
                continue;
            }
            self.remove(&id)?;
            removed = true;
        }
        if removed {
            let root = self.dir.clone().ok_or("Snapshot storage is unavailable.")?;
            self.git(&root, &["gc", "--prune=now", "--quiet"], &[])?;
        }
        Ok(())
    }

    fn remove(&mut self, id: &str) -> Result<(), String> {
        if let Some(record) = self.records.get(id) {
            // Storage commands run from storage even if the old workspace vanished.
            let root = self.dir.clone().ok_or("Snapshot storage is unavailable.")?;
            for prefix in [REF_PREFIX, LEGACY_REF_PREFIX] {
                for name in ["before", "after"] {
                    self.git(&root, &["update-ref", "-d", &format!("{prefix}/{id}/{name}")], &[])?;
                }
            }
            let _ = std::fs::remove_file(root.join("records").join(format!("{}.json", record.info.snapshot_id)));
        }
        self.records.remove(id);
        self.requests.retain(|_, value| value != id);
        Ok(())
    }

    pub fn forget(&mut self, grant: &str, session: &str) -> Result<(), String> {
        // Thread deletion requests cancellation but cannot assert the process
        // has stopped. Keep a content-free running marker until its terminal.
        let ids: Vec<_> = self.records.values().filter(|r| r.grant == grant && r.info.session_id == session).map(|r| r.info.snapshot_id.clone()).collect();
        for id in ids {
            let marker = self.active.get(session).filter(|active| *active == &id).and_then(|_| self.records.get(&id)).cloned();
            self.remove(&id)?;
            if let Some(mut marker) = marker {
                marker.before = None;
                marker.after = None;
                marker.restore_to = None;
                marker.client_key = None;
                marker.info.files.clear();
                marker.info.state = "unavailable".into();
                marker.info.reason = Some("This thread's saved file states were deleted.".into());
                self.records.insert(id, marker);
            }
        }
        let root = self.dir.clone().ok_or("Snapshot storage is unavailable.")?;
        self.git(&root, &["gc", "--prune=now", "--quiet"], &[])?;
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    id.len() == 37 && id.starts_with("snap-") && id[5..].bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_oid(id: &str) -> bool {
    id.len() == 40 && id.bytes().all(|b| b.is_ascii_hexdigit())
}
fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

fn same_file(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    if !after.is_file() || before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != after.dev() || before.ino() != after.ino() || before.mode() != after.mode() || before.ctime() != after.ctime() || before.ctime_nsec() != after.ctime_nsec() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn last_turn_review_is_immutable_after_undo_and_does_not_need_git_in_the_workspace() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"old\n");
        f.write("user.txt", b"user edit\n");
        f.write("deleted.txt", b"delete me\n");
        f.begin("s", "t");
        f.write("a.txt", b"new\n");
        f.write("created.txt", b"created\n");
        f.write("blob.bin", &[0, 1, 2]);
        std::fs::remove_file(f.root.join("deleted.txt")).unwrap();
        let info = f.end("s", "t");
        let review = f.store.review("grant", &f.root, "s", &info.snapshot_id).unwrap();
        assert!(review.diff.contains("-old\n+new"));
        assert!(review.diff.contains("+created"));
        assert!(!review.diff.contains("user edit"));
        assert!(review.files.iter().any(|file| file.path == "blob.bin" && file.preview_skipped.as_deref() == Some("binary")));
        assert!(review.files.iter().any(|file| file.path == "deleted.txt" && file.status == "D"));
        f.restore(&info, false);
        assert_eq!(f.store.review("grant", &f.root, "s", &info.snapshot_id).unwrap().diff, review.diff);
        f.write("a.txt", b"later edit\n");
        assert_eq!(f.store.review("grant", &f.root, "s", &info.snapshot_id).unwrap().diff, review.diff);
        assert_eq!(std::fs::read(f.root.join("a.txt")).unwrap(), b"later edit\n");
        assert!(!f.root.join(".git").exists());
        assert!(f.store.review("other-grant", &f.root, "s", &info.snapshot_id).is_err());
        assert!(f.store.review("grant", &f.root, "other-session", &info.snapshot_id).is_err());
        assert!(f.store.review("grant", &f.dir, "s", &info.snapshot_id).is_err());
        f.store.records.get_mut(&info.snapshot_id).unwrap().info.created_at = now().saturating_sub(RETENTION_SECONDS + 1);
        assert!(f.store.review("grant", &f.root, "s", &info.snapshot_id).unwrap_err().contains("expired"));
    }

    #[test]
    fn last_turn_review_caps_large_patches() {
        let mut f = Fixture::new(false);
        f.begin("s", "t");
        f.write("large.txt", &vec![b'x'; super::super::DIFF_LIMIT + 100_000]);
        let info = f.end("s", "t");
        let review = f.store.review("grant", &f.root, "s", &info.snapshot_id).unwrap();
        assert!(review.truncated);
        assert!(review.diff.len() <= super::super::DIFF_LIMIT + 16);
        assert_eq!(review.files[0].path, "large.txt");
    }
    struct Fixture {
        dir: PathBuf,
        root: PathBuf,
        store: Snapshots,
    }
    impl Fixture {
        fn new(repo: bool) -> Self {
            let dir = std::env::temp_dir().join(format!("muse-turn-snapshots-{}", uuid::Uuid::new_v4()));
            let root = dir.join("workspace");
            std::fs::create_dir_all(&root).unwrap();
            let root = root.canonicalize().unwrap();
            if repo {
                super::super::run_git(&root, &["init"]).unwrap();
            }
            let mut store = Snapshots::default();
            store.open(dir.join("snapshots")).unwrap();
            Self {
                dir,
                root,
                store,
            }
        }
        fn write(&self, path: &str, bytes: &[u8]) {
            let path = self.root.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
        fn begin(&mut self, session: &str, turn: &str) {
            self.store.prepare(turn, "grant", &self.root, session, Some(turn), None);
            self.store.event("turnStarted", &json!({ "sessionId": session, "turnId": turn }), Some(("grant", &self.root)));
        }
        fn end(&mut self, session: &str, turn: &str) -> TurnSnapshot {
            self.store.event("turnCompleted", &json!({ "sessionId": session, "turnId": turn }), Some(("grant", &self.root))).pop().unwrap()
        }
        fn restore(&mut self, info: &TurnSnapshot, reapply: bool) -> RestoreResult {
            self.store.restore("grant", &self.root, &info.session_id, &info.snapshot_id, reapply).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn undo_and_reapply_keep_user_edits_index_and_head() {
        let mut f = Fixture::new(true);
        f.write("edited.txt", b"HEAD\n");
        f.write("deleted.bin", &[0, 1, 2, 255]);
        f.write("untouched.txt", b"keep\n");
        super::super::run_git(&f.root, &["add", "."]).unwrap();
        super::super::run_git(&f.root, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]).unwrap();
        f.write("edited.txt", b"staged user edit\n");
        super::super::run_git(&f.root, &["add", "edited.txt"]).unwrap();
        f.write("edited.txt", b"unsaved user edit\n");
        let index = std::fs::read(f.root.join(".git/index")).unwrap();
        let head = super::super::run_git(&f.root, &["rev-parse", "HEAD"]).unwrap();
        f.begin("s1", "t1");
        f.write("edited.txt", b"agent version\n");
        f.write("new folder/café\tname.txt", b"created\n");
        std::fs::remove_file(f.root.join("deleted.bin")).unwrap();
        let info = f.end("s1", "t1");
        assert_eq!(info.state, "ready", "{:?}", info.reason);
        assert_eq!(info.files.len(), 3);
        assert!(f.restore(&info, false).conflicts.is_empty());
        assert_eq!(std::fs::read(f.root.join("edited.txt")).unwrap(), b"unsaved user edit\n");
        assert_eq!(std::fs::read(f.root.join("deleted.bin")).unwrap(), [0, 1, 2, 255]);
        assert!(!f.root.join("new folder/café\tname.txt").exists());
        assert_eq!(std::fs::read(f.root.join(".git/index")).unwrap(), index);
        assert_eq!(super::super::run_git(&f.root, &["rev-parse", "HEAD"]).unwrap(), head);
        assert!(f.restore(&info, true).conflicts.is_empty());
        assert_eq!(std::fs::read(f.root.join("edited.txt")).unwrap(), b"agent version\n");
        assert!(!f.root.join("deleted.bin").exists());
        assert_eq!(std::fs::read(f.root.join("new folder/café\tname.txt")).unwrap(), b"created\n");
    }

    #[test]
    fn conflicts_refuse_all_files_in_both_directions() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.write("b.txt", b"before\n");
        f.begin("s1", "t1");
        f.write("a.txt", b"after\n");
        f.write("b.txt", b"after\n");
        let info = f.end("s1", "t1");
        f.write("a.txt", b"later user edit\n");
        let result = f.restore(&info, false);
        assert_eq!(result.conflicts, ["a.txt"]);
        assert_eq!(std::fs::read(f.root.join("b.txt")).unwrap(), b"after\n");
        f.write("a.txt", b"after\n");
        f.restore(&info, false);
        f.write("b.txt", b"user edit after undo\n");
        assert_eq!(f.restore(&info, true).conflicts, ["b.txt"]);
        assert_eq!(std::fs::read(f.root.join("a.txt")).unwrap(), b"before\n");
    }

    #[test]
    fn non_git_snapshots_include_dotfiles_and_never_create_a_repository() {
        let mut f = Fixture::new(false);
        f.write(".config", b"user config\n");
        f.begin("s1", "t1");
        f.write(".config", b"agent config\n");
        f.write("bytes.bin", &[255, 0, 127]);
        let info = f.end("s1", "t1");
        assert_eq!(info.files, [".config", "bytes.bin"]);
        f.restore(&info, false);
        assert_eq!(std::fs::read(f.root.join(".config")).unwrap(), b"user config\n");
        assert!(!f.root.join(".git").exists());
        #[cfg(unix)]
        {
            // A literal backslash must never alias a different directory path.
            f.write("bad\\name.txt", b"literal filename\n");
            f.write("bad/name.txt", b"different file\n");
            f.begin("s1", "t2");
            assert_eq!(f.end("s1", "t2").state, "unavailable");
            assert_eq!(std::fs::read(f.root.join("bad/name.txt")).unwrap(), b"different file\n");
        }
    }

    #[test]
    fn capture_policy_keeps_previously_visible_files_when_ignore_rules_change() {
        let mut f = Fixture::new(true);
        f.write("user.txt", b"before\n");
        f.begin("s1", "t1");
        f.write(".gitignore", b"user.txt\n");
        f.write("user.txt", b"agent\n");
        let info = f.end("s1", "t1");
        assert_eq!(info.state, "ready");
        assert_eq!(info.files, [".gitignore", "user.txt"]);
        assert!(f.restore(&info, false).conflicts.is_empty());
        assert_eq!(std::fs::read(f.root.join("user.txt")).unwrap(), b"before\n");
        assert!(!f.root.join(".gitignore").exists());
        f.restore(&info, true);
        assert_eq!(std::fs::read(f.root.join("user.txt")).unwrap(), b"agent\n");
    }

    #[test]
    fn capture_policy_preserves_raw_bytes_with_line_ending_and_encoding_attributes() {
        let mut f = Fixture::new(true);
        f.write(".gitattributes", b"* text eol=lf ident\n*.dat working-tree-encoding=UTF-16\n");
        f.write("nested/a.txt", b"$Id: user$\r\nuser line\r\n");
        f.write("encoded.dat", b"\xff\xfeA\0\r\0\n\0");
        f.begin("s1", "t1");
        f.write("nested/a.txt", b"$Id: agent$\r\nagent line\r\n");
        f.write("encoded.dat", b"\xff\xfeB\0\r\0\n\0");
        let info = f.end("s1", "t1");
        assert_eq!(info.state, "ready");
        f.restore(&info, false);
        assert_eq!(std::fs::read(f.root.join("nested/a.txt")).unwrap(), b"$Id: user$\r\nuser line\r\n");
        assert_eq!(std::fs::read(f.root.join("encoded.dat")).unwrap(), b"\xff\xfeA\0\r\0\n\0");
        f.restore(&info, true);
        assert_eq!(std::fs::read(f.root.join("nested/a.txt")).unwrap(), b"$Id: agent$\r\nagent line\r\n");
        assert_eq!(std::fs::read(f.root.join("encoded.dat")).unwrap(), b"\xff\xfeB\0\r\0\n\0");
    }

    #[test]
    fn nested_grant_never_captures_or_restores_sibling_files() {
        let mut f = Fixture::new(true);
        f.write("sibling.txt", b"outside\n");
        f.write("nested/inside.txt", b"before\n");
        super::super::run_git(&f.root, &["add", "."]).unwrap();
        f.root = f.root.join("nested");
        f.begin("s1", "t1");
        f.write("inside.txt", b"after\n");
        let info = f.end("s1", "t1");
        assert_eq!(info.files, ["inside.txt"]);
        f.restore(&info, false);
        assert_eq!(std::fs::read(f.root.parent().unwrap().join("sibling.txt")).unwrap(), b"outside\n");
    }

    #[test]
    fn oversized_files_disable_undo_without_partial_snapshots() {
        let mut f = Fixture::new(false);
        f.write("huge.bin", &vec![1; FILE_BYTES as usize + 1]);
        f.begin("s1", "t1");
        f.write("small.txt", b"new\n");
        let info = f.end("s1", "t1");
        assert_eq!(info.state, "unavailable");
        assert!(info.reason.unwrap().contains("2 MiB"));
    }

    #[test]
    fn completion_before_ack_and_duplicate_submit_keep_the_original_baseline() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("s1", "t1");
        f.write("a.txt", b"after\n");
        let info = f.end("s1", "t1");
        f.store.response(&json!({"id":"t1","ok":true,"result":{"turnId":"t1"}}));
        f.store.prepare("retry", "grant", &f.root, "s1", Some("t1"), None);
        f.store.response(&json!({"id":"retry","ok":true,"result":{"turnId":"t1","deduped":true}}));
        assert_eq!(f.store.list("grant", &f.root, "s1").len(), 1);
        f.restore(&info, false);
        assert_eq!(std::fs::read(f.root.join("a.txt")).unwrap(), b"before\n");
    }

    #[test]
    fn queued_overlapping_and_disconnected_turns_never_get_unsafe_undo() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("s1", "t1");
        f.begin("s2", "t2");
        f.write("a.txt", b"mixed\n");
        assert_eq!(f.end("s1", "t1").state, "unavailable");
        assert_eq!(f.end("s2", "t2").state, "unavailable");
        f.begin("s1", "t3");
        f.store.prepare("queued", "grant", &f.root, "s1", Some("queued"), Some("queue"));
        f.store.response(&json!({"id":"queued","ok":true,"result":{"turnId":"q1","disposition":"queued"}}));
        f.write("a.txt", b"t3\n");
        // A queued submit can never run alongside its own session's turn, so
        // t3's baseline survives and its undo stays available.
        assert_eq!(f.end("s1", "t3").state, "ready");
        f.store.event("turnStarted", &json!({"sessionId":"s1","turnId":"q1"}), Some(("grant", &f.root)));
        assert_eq!(f.end("s1", "q1").state, "unavailable");
        f.begin("s1", "t4");
        let updates = f.store.event("bridgeExit", &json!({}), None);
        assert_eq!(updates[0].state, "unavailable");
    }

    #[test]
    fn a_queued_or_steering_send_keeps_the_running_turns_undo_baseline() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("s1", "t1");
        // The default busy disposition queues `sendTurn`; prepare() runs while
        // t1 is still active. It must not mark t1's record unavailable.
        f.store.prepare("queued", "grant", &f.root, "s1", Some("queued"), Some("queue"));
        f.store.response(&json!({"id":"queued","ok":true,"result":{"turnId":"q1","disposition":"queued"}}));
        // A `sendTurn` that steers into the running turn likewise adds no new
        // turn; its record is folded away instead of poisoning t1.
        f.store.prepare("steered", "grant", &f.root, "s1", Some("steered"), Some("steer"));
        f.store.response(&json!({"id":"steered","ok":true,"result":{"turnId":"t1","disposition":"steered"}}));
        f.write("a.txt", b"agent\n");
        let info = f.end("s1", "t1");
        assert_eq!(info.state, "ready", "{:?}", info.reason);
        assert_eq!(info.files, ["a.txt"]);
        f.restore(&info, false);
        assert_eq!(std::fs::read(f.root.join("a.txt")).unwrap(), b"before\n");
        f.restore(&info, true);
        // The queued and steered submits are themselves unavailable: one never
        // got a pre-submit baseline, the other is not a separate turn.
        let listed = f.store.list("grant", &f.root, "s1");
        assert!(listed.iter().any(|s| s.turn_id.as_deref() == Some("q1") && s.state == "unavailable"));
        assert!(listed.iter().filter(|s| s.turn_id.as_deref() == Some("t1")).all(|s| s.state != "capturing"));
        f.store.event("turnStarted", &json!({"sessionId":"s1","turnId":"q1"}), Some(("grant", &f.root)));
        f.write("a.txt", b"queued turn work\n");
        assert_eq!(f.end("s1", "q1").state, "unavailable");
        // A run in another session over the same root is still a real overlap.
        f.begin("s1", "t5");
        f.begin("s2", "t6");
        assert_eq!(f.end("s1", "t5").state, "unavailable");
        assert_eq!(f.end("s2", "t6").state, "unavailable");
    }

    #[test]
    fn saved_states_survive_relaunch_and_are_confined_to_owner() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("s1", "t1");
        f.write("a.txt", b"after\n");
        let info = f.end("s1", "t1");
        f.restore(&info, false);
        f.store = Snapshots::default();
        f.store.open(f.dir.join("snapshots")).unwrap();
        assert_eq!(f.store.list("grant", &f.root, "s1")[0].state, "undone");
        assert!(f.store.list("wrong", &f.root, "s1").is_empty());
        assert!(f.store.restore("wrong", &f.root, "s1", &info.snapshot_id, true).is_err());
        assert!(f.store.restore("grant", &f.root, "s2", &info.snapshot_id, true).is_err());
        assert!(f.store.restore("grant", &f.root, "s1", "../../etc/passwd", true).is_err());
        f.restore(&info, true);
        f.begin("s1", "t2");
        f.store = Snapshots::default();
        f.store.open(f.dir.join("snapshots")).unwrap();
        assert!(f.store.list("grant", &f.root, "s1").iter().any(|s| s.turn_id.as_deref() == Some("t2") && s.state == "unavailable"));
    }

    #[test]
    fn interrupted_restore_recovers_complete_states_and_refuses_mixed_files() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.write("b.txt", b"before\n");
        f.begin("s1", "t1");
        f.write("a.txt", b"after\n");
        f.write("b.txt", b"after\n");
        let info = f.end("s1", "t1");
        let mut record = f.store.records[&info.snapshot_id].clone();
        record.restore_to = Some("undone".into());
        f.store.save(&record).unwrap();
        // Intent persisted, but apply had not yet written anything.
        f.store = Snapshots::default();
        f.store.open(f.dir.join("snapshots")).unwrap();
        assert_eq!(f.store.list("grant", &f.root, "s1")[0].state, "ready");
        // Apply finished, but the final metadata write was interrupted.
        f.store.save(&record).unwrap();
        f.write("a.txt", b"before\n");
        f.write("b.txt", b"before\n");
        f.store = Snapshots::default();
        f.store.open(f.dir.join("snapshots")).unwrap();
        assert_eq!(f.store.list("grant", &f.root, "s1")[0].state, "undone");
        f.restore(&info, true);
        // An interrupted disk write leaves neither state; never guess or write.
        f.store.save(&record).unwrap();
        f.write("a.txt", b"before\n");
        f.store = Snapshots::default();
        f.store.open(f.dir.join("snapshots")).unwrap();
        assert_eq!(f.store.list("grant", &f.root, "s1")[0].state, "unavailable");
        assert_eq!(std::fs::read(f.root.join("b.txt")).unwrap(), b"after\n");
    }

    #[test]
    fn retention_and_thread_deletion_release_private_refs() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("s1", "t1");
        f.write("a.txt", b"after\n");
        let info = f.end("s1", "t1");
        let pinned = format!("refs/glitter/{}/before", info.snapshot_id);
        let legacy = format!("refs/muse/{}/before", info.snapshot_id);
        assert!(f.store.git(&f.root, &["show-ref", &pinned], &[]).is_ok());
        // A store moved over from Muse Code still holds refs under the old prefix.
        f.store.git(&f.root, &["update-ref", &legacy, &pinned], &[]).unwrap();
        f.store.forget("grant", "s1").unwrap();
        assert!(f.store.list("grant", &f.root, "s1").is_empty());
        assert!(f.store.git(&f.root, &["show-ref", &pinned], &[]).is_err());
        assert!(f.store.git(&f.root, &["show-ref", &legacy], &[]).is_err());
        f.begin("s1", "t2");
        f.write("a.txt", b"new turn\n");
        let expired = f.end("s1", "t2");
        f.store.records.get_mut(&expired.snapshot_id).unwrap().info.created_at = now() - RETENTION_SECONDS - 1;
        f.store.prune().unwrap();
        assert!(f.store.list("grant", &f.root, "s1").is_empty());
        assert!(f.store.git(&f.root, &["show-ref", &format!("refs/glitter/{}/after", expired.snapshot_id)], &[]).is_err());
    }

    #[test]
    fn deleted_runs_and_stopping_engines_block_restore_until_they_finish() {
        let mut f = Fixture::new(false);
        f.write("a.txt", b"before\n");
        f.begin("history", "t1");
        f.write("a.txt", b"after\n");
        let info = f.end("history", "t1");
        f.begin("s1", "t2");
        f.store.forget("grant", "s1").unwrap();
        assert!(f.store.restore("grant", &f.root, "history", &info.snapshot_id, false).is_err());
        f.end("s1", "t2");
        f.restore(&info, false);
        f.restore(&info, true);
        f.begin("s1", "t3");
        f.store.event("connectionError", &json!({}), None);
        assert!(f.store.restore("grant", &f.root, "history", &info.snapshot_id, false).is_err(), "a connection error precedes process exit");
        f.store.stop_request("stop");
        f.store.response(&json!({"id":"stop","ok":true,"result":{"stopped":true}}));
        f.restore(&info, false);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_replacement_and_mode_changes_are_checked() {
        use std::os::unix::{fs::symlink, fs::PermissionsExt};
        let mut f = Fixture::new(false);
        f.write("nested/a.txt", b"before\n");
        f.begin("s1", "t1");
        std::fs::set_permissions(f.root.join("nested/a.txt"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let info = f.end("s1", "t1");
        f.restore(&info, false);
        assert_eq!(std::fs::metadata(f.root.join("nested/a.txt")).unwrap().permissions().mode() & 0o111, 0);
        f.restore(&info, true);
        assert_ne!(std::fs::metadata(f.root.join("nested/a.txt")).unwrap().permissions().mode() & 0o111, 0);
        let outside = f.dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("a.txt"), b"outside\n").unwrap();
        std::fs::remove_dir_all(f.root.join("nested")).unwrap();
        symlink(&outside, f.root.join("nested")).unwrap();
        assert_eq!(f.restore(&info, false).conflicts, ["nested/a.txt"]);
        assert_eq!(std::fs::read(outside.join("a.txt")).unwrap(), b"outside\n");
    }
}
