use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "macos")]
mod app_icon;
mod catalog;
mod credentials;
mod dto;
mod exec;
mod export_markdown;
mod framing;
mod legacy;
mod mcp_consent;
mod process;
mod snapshots;
mod terminal;
mod worktrees;

static SECURITY_AUDIT: OnceLock<PathBuf> = OnceLock::new();
static APP_LOG_PATH: OnceLock<PathBuf> = OnceLock::new();
static LOG_WRITE: Mutex<()> = Mutex::new(());

/// A grant id is a capability handle, so logs carry only a prefix: a log reader
/// (crash reporter, `log show`, support bundle) must not harvest working ids.
fn grant_tag(grant_id: &str) -> &str {
    &grant_id[..grant_id.len().min(12)]
}

fn log_write_guard() -> std::sync::MutexGuard<'static, ()> {
    LOG_WRITE.lock().unwrap_or_else(|error| error.into_inner())
}

fn rotate_if_large(path: &Path, limit: u64) -> Result<(), String> {
    if path.metadata().map(|meta| meta.len() >= limit).unwrap_or(false) {
        let file_name = path.file_name().ok_or("Could not determine log file name")?;
        let stem = path.file_stem().unwrap_or(file_name);
        let mut previous_name = stem.to_os_string();
        previous_name.push(".previous.log");
        let previous = path.with_file_name(previous_name);
        let _ = std::fs::remove_file(&previous);
        std::fs::rename(path, previous).map_err(|err| format!("Could not rotate log: {err}"))?;
    }
    Ok(())
}

fn append_audit_line(path: &Path, line: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|err| format!("Could not create audit directory: {err}"))?;
    }
    // Control characters (tabs included) become spaces, as in append_log_line:
    // the audit log is TSV, and a renderer-chosen id must not forge columns.
    let safe = redact_log_detail(line)
        .replace(['\n', '\r', '\t'], " ")
        .chars()
        .map(|ch| {
            if ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>();
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_secs().to_string()).unwrap_or_else(|_| "0".into());
    let full_line = format!("{timestamp}\t{safe}\n");
    let _guard = log_write_guard();
    rotate_if_large(path, APP_LOG_LIMIT).map_err(|err| format!("Could not rotate audit log: {err}"))?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|err| format!("Could not open audit log: {err}"))?;
    file.write_all(full_line.as_bytes()).map_err(|err| format!("Could not write audit log: {err}"))
}

fn write_security_audit(line: &str) -> Result<(), String> {
    let path = SECURITY_AUDIT.get().ok_or("Security audit log is unavailable")?;
    append_audit_line(path, line)
}

struct Bridge {
    child: Child,
    stdin: ChildStdin,
}

struct AppState {
    bridge: Mutex<Option<Bridge>>,
    /// Native workspace grants: id -> canonical root. Minted ONLY by the
    /// native folder picker, or derived by `git_worktree_create` for a
    /// worktree of an already granted repository (or loaded from the keyring
    /// entry the renderer cannot write); the renderer can reference an id but
    /// never create or widen one.
    grants: Mutex<HashMap<String, PathBuf>>,
    /// Live session bindings: MSP/ACP session id -> grant id. Learned ONLY by
    /// snooping bridge responses for calls the native side authorized, so a
    /// renderer-nominated session id outside every grant stays unusable.
    sessions: Mutex<HashMap<String, String>>,
    /// Insertion/refresh order for `sessions`, so cap eviction drops the oldest
    /// bindings rather than a random `HashMap` bucket.
    session_order: Mutex<VecDeque<String>>,
    /// Live approval ownership: approval id -> (session id, grant id).
    /// Snooped from `approval` events; `decideApproval` must present the
    /// owning session, since the bridge itself ignores the session field.
    approvals: Mutex<HashMap<String, (String, String)>>,
    /// In-flight bridge calls awaiting a response, for grant attribution.
    pending: Mutex<HashMap<String, PendingCall>>,
    /// Turn files are captured natively before a submit enters the bridge.
    snapshots: Mutex<snapshots::Snapshots>,
    /// Interactive shells behind the terminal pane.
    terminals: Mutex<terminal::Terminals>,
    /// The posture of the last host start: with shell execution disabled, the terminal is off too.
    shell_disabled: std::sync::atomic::AtomicBool,
    dropped_paths: Mutex<HashSet<PathBuf>>,
    /// One-time install authorizations: folders the USER chose in a native
    /// picker. `skill_install` / `plugin_install` accept exactly these paths
    /// and consume them, so a compromised renderer can reference a pick but
    /// never nominate an arbitrary directory to install from.
    picked_installs: Mutex<HashSet<PathBuf>>,
    /// SHA-256 pins for every spawned executable (sidecar, muse, agent CLIs).
    exec_pins: exec::ExecPins,
    /// Cross-restart ACP identity pins (path + digest per agent).
    agent_pins: exec::AgentPins,
    /// Workspace trust and configuration-bound MCP startup permission.
    workspace_security: mcp_consent::WorkspaceSecurity,
}

impl AppState {
    fn new() -> Self {
        AppState {
            bridge: Mutex::new(None),
            grants: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            session_order: Mutex::new(VecDeque::new()),
            approvals: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            snapshots: Mutex::new(snapshots::Snapshots::default()),
            terminals: Mutex::new(terminal::Terminals::default()),
            shell_disabled: std::sync::atomic::AtomicBool::new(false),
            dropped_paths: Mutex::new(HashSet::new()),
            picked_installs: Mutex::new(HashSet::new()),
            exec_pins: exec::ExecPins::new(),
            agent_pins: exec::AgentPins::new(HashMap::new()),
            workspace_security: mcp_consent::WorkspaceSecurity::default(),
        }
    }
}

struct PendingCall {
    method: String,
    grant_id: Option<String>,
    sent_at: Instant,
}

const BRIDGE_METHODS: &[&str] = &[
    "ping",
    "detect",
    "status",
    "startHost",
    "stopHost",
    "listSessions",
    "listModels",
    "suggest",
    "startSession",
    "resumeSession",
    "forkSession",
    "compactSession",
    "closeSession",
    "readSession",
    "readChildSession",
    "pageHistory",
    "listSkills",
    "harnessMcp",
    "harnessMcpConfig",
    "harnessMcpAddServer",
    "harnessMcpRemoveServer",
    "testModel",
    "mcpServers",
    "userShell",
    "readOutput",
    "browserOpen",
    "browserControl",
    "browserClose",
    "setReasoningEffort",
    "subagentControl",
    "taskControl",
    "workflowControl",
    "goalControl",
    "sendTurn",
    "steerTurn",
    "unqueueTurn",
    "cancelTurn",
    "respondUserInput",
    "decideApproval",
    "setApprovalMode",
    "setModel",
    "setSessionOption",
    "usage",
    "startLogin",
    "cancelLogin",
    "renameSession",
    "checkCliUpdate",
    "updateCli",
];

const DIFF_LIMIT: usize = 1_500_000;
/// Bytes read from a workspace `AGENTS.md`; only an excerpt is ever shown.
const RULES_PREVIEW_LIMIT: u64 = 64 * 1024;
const APP_LOG_LIMIT: u64 = 2 * 1024 * 1024;
const MAX_PENDING_CALLS: usize = 512;
/// Session-to-grant bindings kept natively; older ones are re-learned on the next listing.
const MAX_SESSION_BINDINGS: usize = 4096;

/// Unguessable grant handle: `wg-` + a v4 UUID from the OS CSPRNG.
fn mint_grant_id() -> String {
    format!("wg-{}", uuid::Uuid::new_v4().simple())
}

fn valid_grant_id(id: &str) -> bool {
    id.len() == 35 && id.starts_with("wg-") && id[3..].chars().all(|ch| ch.is_ascii_hexdigit())
}

fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredGrants {
    #[serde(default)]
    grants: Vec<StoredGrant>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredGrant {
    id: String,
    path: String,
}

fn parse_grants(raw: &str) -> HashMap<String, PathBuf> {
    let Ok(stored) = serde_json::from_str::<StoredGrants>(raw) else {
        return HashMap::new();
    };
    stored
        .grants
        .into_iter()
        .filter(|grant| valid_grant_id(&grant.id))
        .filter_map(|grant| {
            let root = PathBuf::from(&grant.path);
            // Re-canonicalize on load: stale entries (deleted folders, broken
            // links) fail closed instead of authorizing a ghost path.
            root.canonicalize().ok().map(|canon| (grant.id, canon))
        })
        .collect()
}

fn render_grants(grants: &HashMap<String, PathBuf>) -> Result<String, String> {
    let stored = StoredGrants {
        grants: grants
            .iter()
            .map(|(id, root)| StoredGrant {
                id: id.clone(),
                path: root.to_string_lossy().into_owned(),
            })
            .collect(),
    };
    serde_json::to_string(&stored).map_err(|err| err.to_string())
}

fn load_grants() -> HashMap<String, PathBuf> {
    match credentials::grants_value() {
        Ok(Some(raw)) => parse_grants(&raw),
        Ok(None) => HashMap::new(),
        Err(err) => {
            native_log("warn", "grants.load_failed", &format!("workspace grants unavailable: {err}"));
            HashMap::new()
        }
    }
}

/// Returns the failure reason when the grant table could not reach the keyring;
/// callers surface it, because an unpersisted grant dies with the process.
fn persist_grants(grants: &HashMap<String, PathBuf>) -> Option<String> {
    // Unit tests build throwaway grant tables. Only the e2e fixture, which
    // reroutes the keyring account, may write one.
    #[cfg(test)]
    std::env::var_os("GLITTER_TEST_GRANTS_ACCOUNT")?;
    match render_grants(grants).and_then(|raw| credentials::grants_store(&raw)) {
        Ok(()) => None,
        Err(err) => {
            native_log("warn", "grants.persist_failed", &format!("could not persist workspace grants: {err}"));
            Some(err)
        }
    }
}

/// Resolve a grant id to its canonical root. Unknown or malformed ids fail
/// closed, as do roots that vanished since grant time.
fn grant_root(state: &AppState, grant_id: &str) -> Result<PathBuf, String> {
    if !valid_grant_id(grant_id) {
        return Err("Unknown workspace grant. Re-open the folder to restore access.".into());
    }
    let grants = state.grants.lock().map_err(|err| err.to_string())?;
    let root = grants.get(grant_id).cloned().ok_or_else(|| "Unknown workspace grant. Re-open the folder to restore access.".to_string())?;
    if !root.exists() {
        return Err("Workspace folder no longer exists. Re-open the folder to restore access.".into());
    }
    Ok(root)
}

/// Containment of `path` within one grant's root. Canonicalizes the candidate
/// so `..` segments and symlinks cannot escape the granted root.
fn path_within_grant(state: &AppState, grant_id: &str, path: &Path) -> Result<bool, String> {
    let root = grant_root(state, grant_id)?;
    let Ok(canon) = path.canonicalize() else {
        return Ok(false);
    };
    Ok(canon.starts_with(&root))
}

/// Session verbs take a renderer-nominated id; only bound ids may proceed.
fn require_session(state: &AppState, session_id: &str) -> Result<String, String> {
    if !valid_session_id(session_id) {
        return Err("That session reference is not valid.".into());
    }
    let sessions = state.sessions.lock().map_err(|err| err.to_string())?;
    sessions.get(session_id).cloned().ok_or_else(|| "That session is not connected to an open workspace. Reselect the workspace to reconnect.".to_string())
}

/// Record an in-flight call for response attribution. A renderer-chosen id
/// collision would misattribute the response (and its session bindings) to
/// the wrong grant, and an unbounded table would grow forever under a busy
/// renderer, so both are refused.
fn track_pending(state: &AppState, id: &str, method: &str, grant_id: Option<String>) -> Result<(), String> {
    let Ok(mut pending) = state.pending.lock() else {
        return Err("Bridge state is unavailable. Restart the app.".into());
    };
    if pending.len() >= MAX_PENDING_CALLS {
        pending.retain(|_, call| call.sent_at.elapsed() < Duration::from_secs(150));
        if pending.len() >= MAX_PENDING_CALLS {
            return Err("Too many bridge calls are waiting for responses. Try again in a moment.".into());
        }
    }
    if pending.contains_key(id) {
        return Err("Duplicate in-flight request id. Retry the call.".into());
    }
    pending.insert(
        id.to_string(),
        PendingCall {
            method: method.to_string(),
            grant_id,
            sent_at: Instant::now(),
        },
    );
    Ok(())
}

/// Drop a tracked call that never made it to the bridge, so a retry with the
/// same renderer id is not refused as a duplicate.
fn untrack_pending(state: &AppState, id: &str) {
    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(id);
    }
}

/// Attribute one bridge response line to its authorized call and bind any
/// sessions it carries. Best-effort by design: a malformed line must never
/// break the event relay, and a missing attribution binds nothing.
/// Lock order is grants -> sessions everywhere (see `remove_grant`), so the
/// liveness check and the insert below are atomic against revocation.
fn snoop_bridge_response(state: &AppState, value: &Value) {
    let (Some(id), Some(ok)) = (value.get("id").and_then(Value::as_str), value.get("ok").and_then(Value::as_bool)) else {
        return;
    };
    let call = state.pending.lock().ok().and_then(|mut pending| pending.remove(id));
    let Some(call) = call else {
        return;
    };
    let Some(grant_id) = call.grant_id else {
        return;
    };
    if !ok {
        return;
    }
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let Ok(grants) = state.grants.lock() else {
        return;
    };
    let Some(grant_root) = grants.get(&grant_id) else {
        return;
    };
    let mut session_ids = Vec::new();
    match call.method.as_str() {
        "startSession" | "resumeSession" | "forkSession" => {
            if let Some(session_id) = result.get("sessionId").and_then(Value::as_str) {
                session_ids.push(session_id.to_string());
            }
        }
        "listSessions" => {
            if let Some(rows) = result.get("sessions").and_then(Value::as_array) {
                for row in rows {
                    let Some(session_id) = row.get("sessionId").and_then(Value::as_str) else {
                        continue;
                    };
                    // A row that names its workspace must name THIS grant's
                    // workspace: a listing that reports a session living in a
                    // different folder never binds here, so it cannot be opened
                    // through this grant. Rows without a workspace stay bound —
                    // the listing was scoped by the injected root.
                    if let Some(root) = row.get("workspaceRoot").and_then(Value::as_str).filter(|root| !root.is_empty()) {
                        match PathBuf::from(root).canonicalize() {
                            Ok(canon) if canon.starts_with(grant_root) => {}
                            _ => continue,
                        }
                    }
                    session_ids.push(session_id.to_string());
                }
            }
        }
        _ => return,
    }
    if session_ids.is_empty() {
        return;
    }
    let resumed = result.get("opening").and_then(|opening| opening.get("result")).and_then(|result| result.get("session"));
    let resumed_running = resumed.filter(|session| session.get("status").and_then(Value::as_str) == Some("running")).and_then(|session| Some((session.get("sessionId")?.as_str()?.to_string(), session.get("activeTurnId")?.as_str()?.to_string())));
    let root = grant_root.clone();
    bind_sessions(state, session_ids, &grant_id);
    drop(grants);
    if let Some((session, turn)) = resumed_running {
        let _write = git_write_lock();
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.event("turnStarted", &json!({ "sessionId": session, "turnId": turn }), Some((&grant_id, &root)));
        }
    }
}

/// Bind authorized session ids to `grant_id`, evicting the oldest bindings in
/// FIFO order when `MAX_SESSION_BINDINGS` is exceeded.
fn bind_sessions(state: &AppState, session_ids: Vec<String>, grant_id: &str) {
    if let (Ok(mut sessions), Ok(mut order)) = (state.sessions.lock(), state.session_order.lock()) {
        for session_id in session_ids.into_iter().filter(|id| valid_session_id(id)) {
            if sessions.insert(session_id.clone(), grant_id.to_string()).is_some() {
                order.retain(|existing| existing != &session_id);
            }
            order.push_back(session_id);
        }
        while sessions.len() > MAX_SESSION_BINDINGS {
            let Some(oldest) = order.pop_front() else {
                break;
            };
            sessions.remove(&oldest);
        }
        if sessions.len() > MAX_SESSION_BINDINGS {
            let excess = sessions.len() - MAX_SESSION_BINDINGS;
            let stale: Vec<String> = sessions.keys().take(excess).cloned().collect();
            for id in stale {
                sessions.remove(&id);
            }
        }
    }
}

/// Track and prune approval ownership from bridge events. The bridge forwards
/// `decideApproval` by approval id alone, so native ownership is the only
/// thing stopping a cross-session (or post-revocation) decision.
fn snoop_bridge_event(state: &AppState, value: &Value) {
    let (Some(kind), Some(event)) = (value.get("type").and_then(Value::as_str), value.get("event").and_then(Value::as_str)) else {
        return;
    };
    if kind != "event" {
        return;
    }
    match event {
        "approval" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let (Some(approval_id), Some(session_id)) = (payload.get("approvalId").and_then(Value::as_str), payload.get("sessionId").and_then(Value::as_str)) else {
                return;
            };
            if !valid_session_id(session_id) {
                return;
            }
            let bound = state.sessions.lock().ok().and_then(|sessions| sessions.get(session_id).cloned());
            if let (Some(grant_id), Ok(mut approvals)) = (bound, state.approvals.lock()) {
                approvals.insert(approval_id.to_string(), (session_id.to_string(), grant_id));
            }
        }
        "approvalAudit" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            let approval_id = payload.get("approvalId").and_then(Value::as_str).unwrap_or("");
            let session_id = payload.get("sessionId").and_then(Value::as_str).unwrap_or("");
            let outcome = payload.get("outcome").and_then(Value::as_str).unwrap_or("decided");
            let choice_id = payload.get("choiceId").and_then(Value::as_str).unwrap_or("");
            if !approval_id.is_empty() {
                let _ = write_security_audit(&format!("approval\t{session_id}\t{approval_id}\t{outcome}\t{choice_id}"));
            }
        }
        "approvalResolved" | "approvalError" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            if let (Some(approval_id), Ok(mut approvals)) = (payload.get("approvalId").and_then(Value::as_str), state.approvals.lock()) {
                approvals.remove(approval_id);
            }
        }
        "turnCompleted" | "turnError" => {
            let payload = value.get("payload").cloned().unwrap_or(Value::Null);
            if let (Some(session_id), Ok(mut approvals)) = (payload.get("sessionId").and_then(Value::as_str), state.approvals.lock()) {
                approvals.retain(|_, (owner, _)| owner != session_id);
            }
        }
        "hostStopping" | "hostExit" | "bridgeExit" | "connectionError" => {
            // Bridge-side waiter maps do not survive a host death; neither do ours.
            if let Ok(mut approvals) = state.approvals.lock() {
                approvals.clear();
            }
        }
        _ => {}
    }
}

/// Drop every binding owned (directly or via its session) by a revoked grant.
/// Called after the grant leaves the map; the snoop path holds the grants
/// lock across its check+insert, so a response racing revocation either lands
/// first (and is dropped here) or sees the grant gone (and binds nothing).
fn drop_grant_bindings(state: &AppState, grant_id: &str) {
    let Ok(sessions) = state.sessions.lock() else {
        return;
    };
    let owned: Vec<String> = sessions.iter().filter(|(_, bound)| bound.as_str() == grant_id).map(|(id, _)| id.clone()).collect();
    drop(sessions);
    if owned.is_empty() {
        return;
    }
    if let Ok(mut sessions) = state.sessions.lock() {
        for id in &owned {
            sessions.remove(id);
        }
    }
    if let Ok(mut order) = state.session_order.lock() {
        order.retain(|id| !owned.contains(id));
    }
    if let Ok(mut approvals) = state.approvals.lock() {
        approvals.retain(|_, (owner, _)| !owned.contains(owner));
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitFile {
    pub path: String,
    /// Exact two-column porcelain XY status: `" M"` is unstaged, `"M "` staged.
    pub status: String,
    pub added: u32,
    pub removed: u32,
    /// Why a new file has no diff preview: binary, tooLarge, unavailable,
    /// unsupported, or limit. Absent when the preview was produced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_skipped: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    /// False when the granted folder is not inside a git working tree; the
    /// dock shows an initialize action instead of pretending git failed.
    pub repository: bool,
    pub branch: String,
    pub dirty: bool,
    pub files: Vec<GitFile>,
    pub diff: String,
    pub truncated: bool,
}

impl GitSnapshot {
    /// A granted folder outside any repository: an honest "no repo" answer,
    /// not a git error.
    fn plain() -> Self {
        GitSnapshot {
            repository: false,
            branch: String::new(),
            dirty: false,
            files: Vec::new(),
            diff: String::new(),
            truncated: false,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitReview {
    pub files: Vec<GitFile>,
    pub diff: String,
    pub truncated: bool,
    pub base_commit: Option<String>,
    pub head_commit: Option<String>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "camelCase")]
enum ReviewScope {
    All,
    LastTurn,
    Staged,
    Unstaged,
    Branch,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitReviewRequest {
    scope: ReviewScope,
    base: Option<String>,
    session_id: Option<String>,
    snapshot_id: Option<String>,
}

/// GUI-launched apps do not inherit the user's shell PATH, so Homebrew,
/// ~/.local/bin, nvm, and similar installs are invisible to a bare `which`.
fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.extend([
            home.join(".local/bin"),
            home.join(".muse/bin"),
            home.join(".volta/bin"),
            home.join(".asdf/shims"),
            home.join(".nodenv/shims"),
            home.join(".nvm/current/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".local/share/fnm/aliases/default/bin"),
        ]);
    }
    dirs.extend([PathBuf::from("/opt/homebrew/bin"), PathBuf::from("/opt/homebrew/opt/node/bin"), PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/local/opt/node/bin")]);
    dirs
}

fn augmented_path() -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = extra_bin_dirs().into_iter().filter(|path| path.is_dir()).collect();
    if let Some(current) = std::env::var_os("PATH") {
        for part in std::env::split_paths(&current) {
            if !part.as_os_str().is_empty() && !dirs.contains(&part) {
                dirs.push(part);
            }
        }
    }
    std::env::join_paths(&dirs).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env("PATH", augmented_path());
    cmd
}

/// Resolve the Muse CLI to a canonical pinned path. Custom paths validate the
/// canonical target (name, temp, regular executable file); an empty request
/// searches the augmented PATH. A custom path inside an open workspace is
/// refused: agent sessions write there, so a prompt-injected `./muse` must
/// never become the binary this app spawns with the keyring credential.
/// Every winner pins its SHA-256 digest, so a same-path replacement between
/// spawns fails closed.
fn resolve_muse_bin(state: &AppState, requested: &str) -> Result<PathBuf, String> {
    let custom = !requested.trim().is_empty();
    let found = if custom {
        PathBuf::from(requested)
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        which::which_in("muse", Some(augmented_path()), cwd).map_err(|_| "Muse CLI was not found. Install it or set its path in Settings.".to_string())?
    };
    let canonical = exec::validate_exec(&found.to_string_lossy(), &exec::muse_name_allowed, "The Muse CLI")?;
    if custom {
        if let Ok(grants) = state.grants.lock() {
            if grants.values().any(|root| canonical.starts_with(root)) {
                return Err("The Muse CLI cannot live inside an open workspace folder. Move it to a bin directory and set the path again.".into());
            }
        }
    }
    state.exec_pins.check(&canonical, "The Muse CLI")?;
    Ok(canonical)
}

/// Resolve the Muse binary natively and overwrite the renderer string with the
/// canonical pinned path. A custom path validates or fails the call; an absent
/// path resolves via the augmented PATH and injects when found, otherwise the
/// bridge reports "not found" itself as before.
fn inject_muse_bin(state: &AppState, params: &mut Value) -> Result<(), String> {
    let requested = params.get("museBin").and_then(Value::as_str).unwrap_or("").to_string();
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    if !requested.trim().is_empty() {
        let canonical = resolve_muse_bin(state, &requested)?;
        object.insert("museBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
        return Ok(());
    }
    match resolve_muse_bin(state, "") {
        Ok(canonical) => {
            object.insert("museBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
        }
        Err(_) => {
            object.remove("museBin");
        }
    }
    Ok(())
}

/// Resolve an ACP agent binary natively, verify its pinned identity, and
/// inject the canonical path for the bridge to spawn. The bridge never
/// resolves agent paths itself when this field is present, so a newly
/// shadowing PATH entry cannot redirect a spawn without confirmation.
fn inject_agent_bin(state: &AppState, params: &mut Value) -> Result<(), String> {
    let agent_id = params.get("agentId").and_then(Value::as_str).unwrap_or("").to_string();
    // Harness sessions are `h-` ids minted by the bridge; their session verbs
    // need the keys even when the renderer leaves `agentId` out.
    let harness_session = params.get("sessionId").and_then(Value::as_str).is_some_and(|id| id.starts_with("h-"));
    if agent_id == "harness" || (agent_id.is_empty() && harness_session) {
        return inject_provider_keys(params);
    }
    if agent_id.is_empty() || agent_id == "muse" {
        return Ok(());
    }
    if !credentials::acp_consent_value().unwrap_or(false) {
        return Err("Third-party agents run without an OS sandbox. Confirm that in Settings → Agents before using them.".into());
    }
    let spec = exec::agent_spec(&agent_id).ok_or_else(|| format!("Unknown agent: {agent_id}"))?;
    let canonical = exec::resolve_agent_bin(spec)?;
    state.exec_pins.check(&canonical, &format!("The {} CLI", spec.name))?;
    // Authorize the identity before any execution. The stored version is only
    // metadata, so ordinary requests never respawn an unchanged agent.
    let previous_version = state.agent_pins.get(&agent_id).and_then(|pin| pin.version);
    let outcome = state.agent_pins.check(&agent_id, &canonical, previous_version)?;
    if outcome.changed() {
        persist_agent_pins(state);
    }
    if outcome.changed() || state.agent_pins.get(&agent_id).and_then(|pin| pin.version).is_none() {
        let version = exec::probe_version_cached(&canonical);
        if state.agent_pins.refresh_version(&agent_id, &canonical, version)? {
            persist_agent_pins(state);
        }
    }
    if let exec::PinCheck::VendorUpdate { from, team } = &outcome {
        // Accepted without asking, so it is recorded where trust decisions go.
        let _ = write_security_audit(&format!("agent-update\t{agent_id}\t{team}\t{from}\t{}", canonical.to_string_lossy()));
        native_log("info", "agent.vendor_update", &format!("{agent_id} updated by its signer {team}"));
    }
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    object.insert("agentBin".into(), Value::String(canonical.to_string_lossy().into_owned()));
    Ok(())
}

/// The built-in harness runs in the bridge (a trusted native-side process) and
/// calls providers itself, so its requests carry the keychain's provider keys.
/// The renderer never sees them: it reads masks through `provider_keys_get`.
fn inject_provider_keys(params: &mut Value) -> Result<(), String> {
    let keys = credentials::provider_keys_value()?;
    let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
    object.insert("providerKeys".into(), serde_json::to_value(&keys).map_err(|err| err.to_string())?);
    Ok(())
}

fn load_agent_pins() -> HashMap<String, exec::AgentPin> {
    match credentials::agent_pins_value() {
        Ok(Some(raw)) => exec::parse_agent_pins(&raw),
        Ok(None) => HashMap::new(),
        Err(err) => {
            native_log("warn", "pins.load_failed", &format!("agent pins unavailable: {err}"));
            HashMap::new()
        }
    }
}

fn persist_agent_pins(state: &AppState) {
    let snapshot = state.agent_pins.snapshot();
    match serde_json::to_string(&snapshot) {
        Ok(raw) => {
            if let Err(err) = credentials::agent_pins_store(&raw) {
                native_log("warn", "pins.persist_failed", &format!("could not persist agent pins: {err}"));
            }
        }
        Err(err) => native_log("warn", "pins.persist_failed", &format!("could not persist agent pins: {err}")),
    }
}

/// Debug builds run the bridge from the working tree through the developer's
/// Node; release builds never touch an ambient runtime (SEC-02).
#[cfg(debug_assertions)]
fn node_bin() -> Result<PathBuf, String> {
    which::which("node")
        .or_else(|_| {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            which::which_in("node", Some(augmented_path()), cwd)
        })
        .map_err(|_| "Node.js 24 or newer is required to run the Glitter bridge in development. Install Node and restart the app.".to_string())
}

#[cfg(debug_assertions)]
fn bridge_script<R: Runtime>(_app: &AppHandle<R>) -> Result<PathBuf, String> {
    // Test seam (debug builds only): integration tests point the bridge at a
    // fixture script. Release builds resolve the digest-verified resource and
    // never consult this variable.
    if let Ok(custom) = std::env::var("GLITTER_BRIDGE_SCRIPT") {
        let path = PathBuf::from(&custom);
        if path.is_file() {
            return Ok(path);
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/glitter-bridge/dist/index.js");
    if dev.exists() {
        return Ok(dev);
    }
    Err("Bridge script missing: run `npm run build:bridge` first.".into())
}

/// Release resolves the packaged resource and verifies it against the digest
/// baked at compile time, so a swapped script fails before it ever runs.
#[cfg(not(debug_assertions))]
fn bridge_script<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let script = app.path().resolve("glitter-bridge/index.js", BaseDirectory::Resource).map_err(|err| err.to_string())?;
    verify_bridge_script(&script)?;
    Ok(script)
}

#[cfg_attr(debug_assertions, allow(dead_code))]
fn verify_bridge_script(script: &Path) -> Result<(), String> {
    const BAKED: &str = env!("BRIDGE_SCRIPT_SHA256");
    if BAKED == "none" {
        return Err("Bridge script digest missing from this build. Reinstall the app.".into());
    }
    let digest = exec::sha256_file(script).map_err(|_| "The Glitter bridge script is missing from the installation. Reinstall the app.".to_string())?;
    if digest != BAKED {
        return Err("The Glitter bridge script does not match this installation. Reinstall the app.".into());
    }
    Ok(())
}

/// Tauri strips the target triple from externalBin when installing a bundle.
/// The staging file has a target suffix; the runtime beside the app does not.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn sidecar_file_name() -> &'static str {
    "glitter-node"
}

/// Locate the bundled bridge runtime next to the app binary and validate it:
/// a real executable file (never a symlink planted beside the app), pinned by
/// digest for the process lifetime. Bundle signing/notarization is the outer
/// integrity layer; this check is the inner one.
#[cfg_attr(debug_assertions, allow(dead_code))]
fn sidecar_path(state: &AppState) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|err| format!("Could not locate the app binary: {err}"))?;
    let dir = exe.parent().ok_or("Could not locate the app binary directory")?;
    let candidate = dir.join(sidecar_file_name());
    let name = sidecar_file_name();
    let canonical = exec::validate_exec(&candidate.to_string_lossy(), &|file| file == name, "The Glitter bridge runtime").map_err(|_| format!("The Glitter bridge runtime is missing from the installation ({}). Reinstall the app.", sidecar_file_name()))?;
    state.exec_pins.check(&canonical, "The Glitter bridge runtime")?;
    Ok(canonical)
}

fn spawn_bridge_stdio<R: Runtime>(mut child: Child, app: &AppHandle<R>) -> Result<Bridge, String> {
    let stdout = child.stdout.take().ok_or("Bridge stdout missing")?;
    let stderr = child.stderr.take().ok_or("Bridge stderr missing")?;
    let stdin = child.stdin.take().ok_or("Bridge stdin missing")?;
    let handle = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            let line = framing::read_line(&mut reader, framing::MAX_FRAME_BYTES, false);
            match line {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(&line) {
                        snoop_bridge_response(&handle.state::<AppState>(), &value);
                        snoop_bridge_event(&handle.state::<AppState>(), &value);
                        observe_snapshots(&handle, &value);
                        let _ = handle.emit("bridge-line", value);
                    }
                }
                // EOF: the bridge process is gone; one final exit notice.
                Ok(None) => break,
                // One oversized frame must not kill the relay for a process
                // that is still running: skip the frame, keep reading.
                Err(err) if err.kind() == std::io::ErrorKind::InvalidData => {
                    if framing::drain_line(&mut reader).is_err() {
                        break;
                    }
                }
                // Interrupted reads are retried inside the framing reader; any
                // other error ends the relay.
                Err(_) => break,
            }
        }
        let exit = json!({ "type": "event", "event": "bridgeExit", "payload": {} });
        observe_snapshots(&handle, &exit);
        let _ = handle.emit("bridge-line", exit);
    });
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut private_key = false;
        while let Ok(Some(line)) = framing::read_line(&mut reader, framing::MAX_LOG_BYTES, true) {
            if let Some(safe) = redact_stderr_line(&line, &mut private_key) {
                native_log("warn", "bridge.stderr", &safe);
            }
        }
    });
    Ok(Bridge {
        child,
        stdin,
    })
}

/// Where the built-in harness keeps its threads: the app's own data folder,
/// private to the user. The bridge falls back to a home-folder path only when
/// it runs outside the app (tests, smoke scripts).
fn harness_env<R: Runtime>(app: &AppHandle<R>, cmd: &mut std::process::Command) {
    let Ok(base) = app.path().app_data_dir() else {
        return;
    };
    let dir = base.join("harness");
    if std::fs::create_dir_all(&dir).is_ok() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        cmd.env("GLITTER_HARNESS_DIR", dir);
    }
}

/// Chromium is an app-managed executable, not a renderer-selected program.
/// Prefer the full browser matching the pinned Playwright registry, then a
/// system channel, then the matching headless shell. The digest is pinned for
/// this bridge process and checked again by the bridge before a relaunch.
fn resolve_browser_bin(state: &AppState) -> Option<PathBuf> {
    // Playwright 1.64.1 (`node_modules/playwright-core/browsers.json`).
    const CHROMIUM_REVISION: &str = "1248";
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let full = if cfg!(target_arch = "aarch64") { "chrome-mac-arm64" } else { "chrome-mac-x64" };
        let shell = if cfg!(target_arch = "aarch64") { "chrome-headless-shell-mac-arm64" } else { "chrome-headless-shell-mac-x64" };
        if let Some(home) = dirs::home_dir() {
            let cache = home.join("Library/Caches/ms-playwright");
            candidates.push(cache.join(format!("chromium-{CHROMIUM_REVISION}")).join(full).join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
            candidates.push(cache.join(format!("chromium_headless_shell-{CHROMIUM_REVISION}")).join(shell).join("chrome-headless-shell"));
        }
        candidates.extend([
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ]);
    }
    #[cfg(target_os = "linux")]
    {
        let full = if cfg!(target_arch = "aarch64") { "chrome-linux-arm64/chrome" } else { "chrome-linux64/chrome" };
        let shell = if cfg!(target_arch = "aarch64") { "chrome-headless-shell-linux-arm64/chrome-headless-shell" } else { "chrome-headless-shell-linux64/chrome-headless-shell" };
        if let Some(home) = dirs::home_dir() {
            let cache = home.join(".cache/ms-playwright");
            candidates.push(cache.join(format!("chromium-{CHROMIUM_REVISION}")).join(full));
            candidates.push(cache.join(format!("chromium_headless_shell-{CHROMIUM_REVISION}")).join(shell));
        }
    }
    candidates.into_iter().find_map(|path| {
        if !path.is_file() {
            return None;
        }
        let canonical = exec::validate_exec(&path.to_string_lossy(), &|name| matches!(name, "Google Chrome for Testing" | "Google Chrome" | "Chromium" | "Microsoft Edge" | "chrome" | "chrome-headless-shell"), "Chromium").ok()?;
        state.exec_pins.check(&canonical, "Chromium").ok()?;
        Some(canonical)
    })
}

fn browser_env(state: &AppState, cmd: &mut std::process::Command) {
    // With no authorized executable the bridge must not search ambient channels.
    cmd.env("GLITTER_NATIVE_BROWSER_CHECK", "1");
    if let Some(path) = resolve_browser_bin(state) {
        cmd.env("GLITTER_BROWSER_BIN", &path);
        if let Ok(digest) = exec::sha256_file(&path) {
            cmd.env("GLITTER_BROWSER_SHA256", digest);
        }
    }
}

fn spawn_bridge<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<Bridge, String> {
    #[cfg(debug_assertions)]
    {
        let node = node_bin()?;
        let script = bridge_script(app)?;
        let mut cmd = command(node);
        cmd.arg(script);
        process::isolate_command(&mut cmd);
        cmd.env("PATH", augmented_path());
        harness_env(app, &mut cmd);
        browser_env(state, &mut cmd);
        let child = cmd.spawn().map_err(|err| format!("Failed to start Glitter bridge: {err}"))?;
        spawn_bridge_stdio(child, app)
    }
    #[cfg(not(debug_assertions))]
    {
        // Release: the bundled runtime + verified script only. No ambient
        // Node lookup anywhere on this path.
        let runtime = sidecar_path(state)?;
        let script = bridge_script(app)?;
        let mut cmd = command(runtime);
        cmd.arg(script);
        process::isolate_command(&mut cmd);
        cmd.env("PATH", augmented_path());
        harness_env(app, &mut cmd);
        browser_env(state, &mut cmd);
        let child = cmd.spawn().map_err(|err| format!("Failed to start Glitter bridge: {err}"))?;
        return spawn_bridge_stdio(child, app);
    }
}

fn ensure_bridge<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> Result<(), String> {
    let mut guard = state.bridge.lock().map_err(|err| err.to_string())?;
    let exited = if let Some(bridge) = guard.as_mut() {
        bridge.child.try_wait().map_err(|err| err.to_string())?.is_some()
    } else {
        false
    };
    if exited {
        *guard = None;
    }
    if guard.is_none() {
        *guard = Some(spawn_bridge(app, state)?);
    }
    Ok(())
}

/// Relay one renderer request to the bridge. The work runs on the blocking
/// pool: typed validation clones the params, the keyring and binary hashing
/// touch disk, and the stdin write blocks as soon as the pipe fills — none
/// of that may run on the main thread, which is the window's event loop.
#[tauri::command]
async fn bridge_request<R: Runtime>(app: AppHandle<R>, id: String, method: String, params: Value) -> Result<Value, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        bridge_request_impl(&state, &app, id, method, params)
    })
    .await
}

fn bridge_request_impl<R: Runtime>(state: &AppState, app: &AppHandle<R>, id: String, method: String, params: Value) -> Result<Value, String> {
    if !BRIDGE_METHODS.contains(&method.as_str()) {
        return Err(format!("Unsupported bridge method: {method}"));
    }
    // Typed boundary (SEC-01): reject malformed params before any grant check
    // or bridge spawn, and forward only the canonical shape from here on.
    dto::validate_request_id(&id)?;
    let mut params = dto::validate_params(&method, &params)?;
    // Executable identity (SEC-02): the native side resolves every binary and
    // overwrites renderer strings with canonical pinned paths before the
    // bridge spawns anything.
    if matches!(method.as_str(), "detect" | "status" | "startHost" | "startLogin" | "checkCliUpdate" | "updateCli") {
        inject_muse_bin(state, &mut params)?;
    }
    if matches!(
        method.as_str(),
        "startHost" | "stopHost" | "listSessions" | "listModels" | "suggest" | "startSession" | "resumeSession" | "forkSession" | "compactSession" | "readSession" | "readChildSession" | "pageHistory" | "listSkills" | "harnessMcp" | "harnessMcpConfig" | "harnessMcpAddServer" | "harnessMcpRemoveServer" | "testModel" | "mcpServers" | "readOutput" | "setReasoningEffort" | "subagentControl" | "taskControl" | "workflowControl" | "goalControl" | "sendTurn" | "steerTurn" | "unqueueTurn" | "cancelTurn" | "setModel" | "setSessionOption"
    ) {
        inject_agent_bin(state, &mut params)?;
    }
    if matches!(method.as_str(), "detect" | "status" | "startHost") {
        let key = credentials::credential_value()?.unwrap_or_default();
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("museApiKey".into(), Value::String(key));
    }
    if method == "detect" {
        // Detection learns which providers are set up, by id only.
        let configured: Vec<Value> = credentials::provider_keys_value().unwrap_or_default().into_keys().map(Value::String).collect();
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("harnessProviders".into(), Value::Array(configured));
    }
    // Trust boundary: session verbs carry renderer-nominated ids/paths, so the
    // native side resolves every grant itself and injects the canonical root.
    // A grant that cannot be resolved fails the call before the bridge spawns.
    let mut call_grant: Option<String> = None;
    if method == "startSession" {
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        let root = grant_root(state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
        call_grant = Some(grant_id);
    }
    // `listSessions` without a grant lists every workspace (metadata only,
    // like the CLI picker); the rows bind to no grant, so opening one still
    // requires a grant-scoped listing first.
    if method == "listSessions" {
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        if !grant_id.is_empty() {
            let root = grant_root(state, &grant_id)?;
            let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
            object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
            call_grant = Some(grant_id);
        }
    }
    if matches!(method.as_str(), "browserOpen" | "browserControl" | "browserClose") {
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        if grant_id.is_empty() {
            return Err("A workspace grant is required for browser control.".into());
        }
        let root = grant_root(state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
    }
    if method == "resumeSession" {
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let grant_id = require_session(state, session_id)?;
        // ACP resume takes a workspace root for its cwd: always substitute the
        // bound grant's root, so a nominated path can never widen the resume
        // and a missing one can never silently empty the cwd. (Muse resume
        // ignores the extra field.)
        let root = grant_root(state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
        call_grant = Some(grant_id);
    }
    if method == "suggest" {
        // Suggestions are grant-scoped like a session start: the renderer names
        // a grant, and only the canonical root is forwarded. Muse suggestions
        // also take the key from the keychain, never the renderer's mask.
        let agent = params.get("agentId").and_then(Value::as_str).unwrap_or("muse");
        let muse = agent.is_empty() || agent == "muse";
        if muse {
            inject_muse_bin(state, &mut params)?;
            let key = credentials::credential_value()?.unwrap_or_default();
            let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
            object.insert("museApiKey".into(), Value::String(key));
        }
        let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string();
        if grant_id.is_empty() {
            return Err("A workspace grant is required for suggestions.".into());
        }
        let root = grant_root(state, &grant_id)?;
        let object = params.as_object_mut().ok_or("Bridge parameters must be an object")?;
        object.insert("workspaceRoot".into(), Value::String(root.to_string_lossy().into_owned()));
    }
    if matches!(method.as_str(), "decideApproval" | "closeSession" | "setApprovalMode") {
        let harness_session = params.get("sessionId").and_then(Value::as_str).is_some_and(|id| id.starts_with("h-"));
        if harness_session {
            inject_provider_keys(&mut params)?;
        }
    }
    let native_mcp = (method == "startSession" && params.get("agentId").and_then(Value::as_str) == Some("harness"))
        || (matches!(method.as_str(), "resumeSession" | "sendTurn" | "harnessMcp" | "harnessMcpConfig")
            && params.get("sessionId").and_then(Value::as_str).is_some_and(|id| id.starts_with("h-")));
    if native_mcp {
        let grant_id = if method == "startSession" {
            params.get("grantId").and_then(Value::as_str).unwrap_or("").to_string()
        } else {
            require_session(state, params.get("sessionId").and_then(Value::as_str).unwrap_or(""))?
        };
        if !grant_id.is_empty() {
            // Supply absence of consent too: a changed or revoked approval must
            // not leave the previous authorization in the bridge's session map.
            mcp_consent::inject(state, &grant_id, &mut params)?;
        }
    }
    if method == "decideApproval" {
        // The bridge routes by approval id alone, so the native side must tie
        // the approval to the presented session: otherwise any bound session
        // could decide any other session's approval — including approvals from
        // workspaces whose grant was already revoked.
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let approval_id = params.get("approvalId").and_then(Value::as_str).unwrap_or("");
        let grant_id = require_session(state, session_id)?;
        let approvals = state.approvals.lock().map_err(|err| err.to_string())?;
        match approvals.get(approval_id) {
            Some((owner, grant)) if owner == session_id && grant == &grant_id => {}
            _ => return Err("That approval does not belong to this session.".into()),
        }
    }
    if matches!(
        method.as_str(),
        "forkSession" | "compactSession" | "closeSession" | "readSession" | "readChildSession" | "pageHistory" | "listSkills" | "harnessMcp" | "harnessMcpConfig" | "harnessMcpAddServer" | "harnessMcpRemoveServer" | "userShell" | "readOutput" | "setReasoningEffort" | "subagentControl" | "taskControl" | "workflowControl" | "goalControl" | "sendTurn" | "steerTurn" | "unqueueTurn" | "cancelTurn" | "respondUserInput" | "setApprovalMode" | "setModel" | "setSessionOption" | "renameSession"
    ) {
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        require_session(state, session_id)?;
    }
    if method == "listModels" {
        if let Some(session_id) = params.get("sessionId").and_then(Value::as_str).filter(|value| !value.is_empty()) {
            require_session(state, session_id)?;
        }
    }
    if method == "forkSession" {
        // The fork inherits its source's workspace: bind the new session id
        // to the source's grant when the response lands.
        let session_id = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        call_grant = Some(require_session(state, session_id)?);
    }
    let tracked = matches!(method.as_str(), "startSession" | "resumeSession" | "forkSession" | "listSessions");
    if tracked {
        track_pending(state, &id, &method, call_grant)?;
    }
    if method == "sendTurn" || method == "userShell" {
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let grant = require_session(state, session)?;
        let root = grant_root(state, &grant)?;
        let _write = git_write_lock();
        snapshot_owner(state, &grant, session)?;
        if let Ok(mut snapshots) = state.snapshots.lock() {
            // A failed capture never prevents the prompt from running; its
            // receipt explains why Undo is unavailable instead.
            let opened = app.path().app_data_dir().ok().map(|dir| snapshots.open(dir.join("turn-snapshots")));
            if matches!(opened, Some(Ok(()))) {
                if method == "sendTurn" {
                    // `ifBusy` lets a queued (or steering) submit keep the
                    // running turn's baseline: it cannot overlap its own
                    // session's turn, only a run in another session.
                    snapshots.prepare(&id, &grant, &root, session, params.get("clientTurnId").and_then(Value::as_str), params.get("agentId").and_then(Value::as_str).unwrap_or("muse"), params.get("ifBusy").and_then(Value::as_str));
                } else {
                    snapshots.shell_request(&id, session, &root);
                }
            }
        }
    }
    if method == "startHost" {
        // "Disable shell" is a promise about this app, not only about the agent.
        state.shell_disabled.store(params.get("disableShell").and_then(Value::as_bool).unwrap_or(false), std::sync::atomic::Ordering::Relaxed);
    }
    if method == "stopHost" {
        let _write = git_write_lock();
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.stop_request(&id, params.get("agentId").and_then(Value::as_str).unwrap_or("muse"));
        }
    }
    let sent = send_bridge_request(state, app, &id, &method, params);
    if sent.is_err() {
        if let Ok(mut snapshots) = state.snapshots.lock() {
            snapshots.failed_request(&id);
        }
    }
    // A call that never reached the bridge must not keep its id pinned as
    // in-flight: the renderer's retry with the same id has to work.
    if sent.is_err() && tracked {
        untrack_pending(state, &id);
    }
    sent
}

/// Write one validated request to the bridge's stdin. The write blocks while
/// the pipe is full, so it belongs on the blocking pool with the caller.
fn send_bridge_request<R: Runtime>(state: &AppState, app: &AppHandle<R>, id: &str, method: &str, params: Value) -> Result<Value, String> {
    ensure_bridge(app, state)?;
    let mut params = params;
    dto::strip_native_fields(method, &mut params);
    // A relative budget, not an epoch: the bridge measures it on its own
    // monotonic clock, so a wall-clock jump cannot expire a queued request.
    let payload = json!({ "id": id, "method": method, "params": params, "deadlineInMs": 120_000u64 }).to_string();
    if payload.len() > framing::MAX_FRAME_BYTES {
        return Err("Request exceeds the protocol byte limit. Reduce attachments and retry.".into());
    }
    {
        let mut guard = state.bridge.lock().map_err(|err| err.to_string())?;
        let bridge = guard.as_mut().ok_or("Bridge is not running")?;
        writeln!(bridge.stdin, "{payload}").map_err(|err| err.to_string())?;
        bridge.stdin.flush().map_err(|err| err.to_string())?;
    }
    Ok(json!({ "id": id }))
}

/// Snapshot lifecycle observes the trusted bridge before relaying terminals to
/// React. Queued/external starts are never given a late, invented baseline.
fn observe_snapshots<R: Runtime>(app: &AppHandle<R>, value: &Value) {
    let state = app.state::<AppState>();
    let event = value.get("event").and_then(Value::as_str).unwrap_or("");
    let payload = &value["payload"];
    // Streaming deltas and ordinary facts have no snapshot work. In
    // particular, do not put every token behind the native git write lock.
    if value.get("id").is_none() && !matches!(event, "turnStarted" | "turnCompleted" | "turnError" | "hostStopping" | "hostExit" | "bridgeExit" | "connectionError" | "agentExit") && !(event == "item" && (payload["item"]["kind"].as_str() == Some("userShell") || matches!(payload["item"]["status"].as_str(), Some("inProgress" | "running")))) {
        return;
    }
    let binding = payload.get("sessionId").and_then(Value::as_str).and_then(|session| require_session(&state, session).ok()).and_then(|grant| grant_root(&state, &grant).ok().map(|root| (grant, root)));
    let _write = git_write_lock();
    if let Ok(mut snapshots) = state.snapshots.lock() {
        snapshots.response(value);
        for info in snapshots.event(event, payload, binding.as_ref().map(|(grant, root)| (grant.as_str(), root.as_path()))) {
            let _ = app.emit("bridge-line", json!({ "type": "event", "event": "turnSnapshot", "payload": info }));
        }
    };
}

fn snapshot_owner(state: &AppState, grant: &str, session: &str) -> Result<PathBuf, String> {
    let root = grant_root(state, grant)?;
    if require_session(state, session)? != grant {
        return Err("That thread does not belong to this workspace.".into());
    }
    Ok(root)
}

#[tauri::command]
async fn turn_snapshots<R: Runtime>(app: AppHandle<R>, grant_id: String, session_id: String) -> Result<Vec<snapshots::TurnSnapshot>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let root = snapshot_owner(&state, &grant_id, &session_id)?;
        let _write = git_write_lock();
        let mut snapshots = state.snapshots.lock().map_err(|_| "Snapshot storage is unavailable.")?;
        snapshots.open(app.path().app_data_dir().map_err(|_| "Snapshot storage is unavailable.")?.join("turn-snapshots"))?;
        snapshot_owner(&state, &grant_id, &session_id)?;
        Ok(snapshots.list(&grant_id, &root, &session_id))
    })
    .await
}

#[tauri::command]
async fn turn_snapshot_restore<R: Runtime>(app: AppHandle<R>, grant_id: String, session_id: String, snapshot_id: String, reapply: bool) -> Result<snapshots::RestoreResult, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let root = snapshot_owner(&state, &grant_id, &session_id)?;
        let _write = git_write_lock();
        let mut snapshots = state.snapshots.lock().map_err(|_| "Snapshot storage is unavailable.")?;
        snapshots.open(app.path().app_data_dir().map_err(|_| "Snapshot storage is unavailable.")?.join("turn-snapshots"))?;
        // Resolve again after waiting behind another native mutation.
        snapshot_owner(&state, &grant_id, &session_id)?;
        snapshots.restore(&grant_id, &root, &session_id, &snapshot_id, reapply)
    })
    .await
}

#[tauri::command]
async fn turn_snapshots_forget<R: Runtime>(app: AppHandle<R>, grant_id: String, session_id: String) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        snapshot_owner(&state, &grant_id, &session_id)?;
        let _write = git_write_lock();
        let mut snapshots = state.snapshots.lock().map_err(|_| "Snapshot storage is unavailable.")?;
        snapshots.open(app.path().app_data_dir().map_err(|_| "Snapshot storage is unavailable.")?.join("turn-snapshots"))?;
        snapshot_owner(&state, &grant_id, &session_id)?;
        snapshots.forget(&grant_id, &session_id)
    })
    .await
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_with(cwd, &[], args)
}

/// Read-only `git`. `--no-optional-locks` stops a background refresh from
/// taking `index.lock` for git's opportunistic stat update, which would make
/// the agent's own `git add` / `git commit` in the same repository fail with
/// "Unable to create index.lock" for as long as the refresh runs.
fn run_git_read(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_output(read_git_command(cwd), args)
}

/// Remove ambient `GIT_*` overrides (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`)
/// so a parent shell environment can never redirect a grant-scoped git command
/// into another repository.
pub(crate) fn strip_ambient_git_env(cmd: &mut Command) {
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            cmd.env_remove(key);
        }
    }
}

fn read_git_command(cwd: &Path) -> Command {
    let mut cmd = command("git");
    strip_ambient_git_env(&mut cmd);
    cmd.args(["--no-optional-locks", "-c", "core.fsmonitor=false"]).current_dir(cwd);
    cmd
}

fn run_git_with(cwd: &Path, global: &[&str], args: &[&str]) -> Result<String, String> {
    let mut cmd = command("git");
    strip_ambient_git_env(&mut cmd);
    cmd.args(global).current_dir(cwd);
    run_git_output(cmd, args)
}

fn run_git_output(mut cmd: Command, args: &[&str]) -> Result<String, String> {
    let output = cmd.args(args).output().map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// Read-only `git` whose stdout is bounded: past `limit` bytes the process is
/// killed instead of buffering an arbitrarily large diff (a vendored bundle or
/// lockfile rewrite is easily tens of megabytes) only to throw most of it away.
/// Returns the text and whether it was cut.
fn run_git_capped(cwd: &Path, args: &[&str], limit: usize) -> Result<(String, bool), String> {
    run_git_command_capped(read_git_command(cwd), args, limit)
}

/// The private snapshot repository supplies its own isolated Git environment.
/// Both review sources share the same bounded stdout reader.
fn run_git_command_capped(mut cmd: Command, args: &[&str], limit: usize) -> Result<(String, bool), String> {
    use std::io::Read;
    use std::process::Stdio;
    let mut child = cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|err| format!("git failed: {err}"))?;
    // Stderr is drained on its own thread so a chatty git can never fill the
    // pipe and stall while we are still reading stdout.
    let stderr = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            text
        })
    });
    let mut bytes = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        stdout.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|err| format!("git failed: {err}"))?;
    }
    let cut = bytes.len() > limit;
    if cut {
        // Enough has been read; a killed writer is the expected end of a big diff.
        let _ = child.kill();
    }
    let status = child.wait().map_err(|err| format!("git failed: {err}"))?;
    let stderr = stderr.and_then(|handle| handle.join().ok()).unwrap_or_default();
    if !cut && !status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), stderr.trim()));
    }
    bytes.truncate(limit);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    let text_cut = cap_text(&mut text, limit);
    Ok((text, cut || text_cut))
}

/// Serializes the git commands that write (stage, commit, discard) so two quick
/// clicks cannot race for `index.lock`. Reads run without optional locks and
/// never wait on this.
static GIT_WRITE_LOCK: Mutex<()> = Mutex::new(());

fn git_write_lock() -> std::sync::MutexGuard<'static, ()> {
    // The guarded value is `()`, so a poisoned lock holds no broken state.
    GIT_WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `git` with piped stdin (for `git apply`); the patch always comes from a
/// fresh `git diff` the native side ran itself, never from the renderer.
fn run_git_stdin(cwd: &Path, args: &[&str], input: &str) -> Result<String, String> {
    run_git_stdin_bytes(cwd, args, input.as_bytes())
}

/// As `run_git_stdin`, for input that is not guaranteed to be UTF-8.
/// Stdin is written concurrently with output draining so a large patch
/// (up to 20 MB in `git_worktree_handoff`) cannot deadlock if `git` writes
/// warnings or errors exceeding the OS pipe buffer before EOF.
fn run_git_stdin_bytes(cwd: &Path, args: &[&str], input: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let mut cmd = command("git");
    strip_ambient_git_env(&mut cmd);
    let mut child = cmd.args(args).current_dir(cwd).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|err| format!("git failed: {err}"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| "git failed: stdin unavailable".to_string())?;
    let (output, written) = std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(input));
        let output = child.wait_with_output();
        (output, writer.join())
    });
    let output = output.map_err(|err| format!("git failed: {err}"))?;
    if !output.status.success() {
        return Err(format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr).trim()));
    }
    written.map_err(|_| "git failed: stdin writer panicked".to_string())?.map_err(|err| format!("git failed: {err}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn parse_numstat_z(raw: &str) -> std::collections::HashMap<String, (u32, u32)> {
    let mut counts = std::collections::HashMap::<String, (u32, u32)>::new();
    let parts: Vec<&str> = raw.split('\0').filter(|part| !part.is_empty()).collect();
    let mut index = 0;
    while index < parts.len() {
        let line = parts[index];
        let mut tabs = line.splitn(3, '\t');
        let added = tabs.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        let removed = tabs.next().and_then(|value| value.parse().ok()).unwrap_or(0);
        let mut path = tabs.next().unwrap_or("").to_string();
        if path.is_empty() && index + 2 < parts.len() {
            path = parts[index + 2].to_string();
            index += 2;
        }
        if let Some((_, next)) = path.split_once(" => ") {
            path = next.to_string();
        }
        counts.insert(path.trim_matches('"').to_string(), (added, removed));
        index += 1;
    }
    counts
}

/// `git status --porcelain -z` entries as (path, status). Renames and copies are
/// followed by an extra NUL-separated entry holding the original path, which is skipped.
/// The status keeps both XY columns exactly: `" M"` is unstaged, `"M "` is
/// staged — collapsing them told the UI that unstaged edits were staged.
fn parse_porcelain_z(raw: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let mut entries = raw.split('\0');
    while let Some(line) = entries.next() {
        if line.len() < 4 {
            continue;
        }
        let status = line[..2].to_string();
        let path = line[3..].to_string();
        if status.contains('R') || status.contains('C') {
            entries.next();
        }
        files.push((path, status));
    }
    files
}

#[tauri::command]
async fn git_snapshot(state: State<'_, AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || git_snapshot_for(&cwd)).await
}

#[tauri::command]
async fn git_review<R: Runtime>(app: AppHandle<R>, grant_id: String, request: GitReviewRequest) -> Result<GitReview, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        if request.scope != ReviewScope::LastTurn {
            let root = grant_root(&state, &grant_id)?;
            let review = git_review_for(&root, &request)?;
            if grant_root(&state, &grant_id)? != root {
                return Err("Workspace access changed while loading the review.".into());
            }
            return Ok(review);
        }
        if request.base.is_some() {
            return Err("Last turn review does not take a base revision.".into());
        }
        let session = request.session_id.as_deref().ok_or("Choose a thread to review its last turn.")?;
        let id = request.snapshot_id.as_deref().ok_or("This turn has no saved file state.")?;
        let root = snapshot_owner(&state, &grant_id, session)?;
        let _write = git_write_lock();
        let mut snapshots = state.snapshots.lock().map_err(|_| "Snapshot storage is unavailable.")?;
        snapshots.open(app.path().app_data_dir().map_err(|_| "Snapshot storage is unavailable.")?.join("turn-snapshots"))?;
        snapshot_owner(&state, &grant_id, session)?;
        let review = snapshots.review(&grant_id, &root, session, id)?;
        snapshot_owner(&state, &grant_id, session)?;
        Ok(review)
    })
    .await
}

/// Name/status and numstat use --no-renames, so each entry has one cwd-relative
/// path. A rename across the grant boundary becomes only its authorized side.
fn review_files(names: &str, numstat: &str, truncated: &mut bool) -> Vec<GitFile> {
    let counts = parse_numstat_z(numstat);
    let binary: HashSet<_> = numstat
        .split('\0')
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let (added, removed, path) = (parts.next()?, parts.next()?, parts.next()?);
            (added == "-" || removed == "-").then_some(path)
        })
        .collect();
    let complete = names.rfind('\0').map(|at| &names[..=at]).unwrap_or("");
    let mut entries = complete.split('\0');
    let mut files = Vec::new();
    while let (Some(status), Some(path)) = (entries.next(), entries.next()) {
        if status.is_empty() || path.is_empty() {
            continue;
        }
        if files.len() >= 2000 {
            *truncated = true;
            break;
        }
        let (added, removed) = counts.get(path).copied().unwrap_or((0, 0));
        files.push(GitFile {
            path: path.to_string(),
            status: status.to_string(),
            added,
            removed,
            preview_skipped: binary.contains(path).then(|| "binary".into()),
        });
    }
    files
}

fn git_review_for(cwd: &Path, request: &GitReviewRequest) -> Result<GitReview, String> {
    if request.session_id.is_some() || request.snapshot_id.is_some() {
        return Err("This review scope does not take a thread or snapshot reference.".into());
    }
    if request.scope != ReviewScope::Branch && request.base.is_some() {
        return Err("Only Branch review takes a base revision.".into());
    }
    if request.scope == ReviewScope::All {
        let snapshot = git_snapshot_for(cwd)?;
        return Ok(GitReview {
            files: snapshot.files,
            diff: snapshot.diff,
            truncated: snapshot.truncated,
            base_commit: None,
            head_commit: None,
        });
    }
    if run_git_read(cwd, &["rev-parse", "--is-inside-work-tree"])?.trim() != "true" {
        return Err("This scope needs a Git working tree.".into());
    }
    let mut revisions = Vec::new();
    let mut base_commit = None;
    let mut head_commit = None;
    match request.scope {
        ReviewScope::Staged => revisions.push("--cached".to_string()),
        ReviewScope::Unstaged => {}
        ReviewScope::Branch => {
            let base = request.base.as_deref().unwrap_or("").trim();
            if base.is_empty() || base.len() > 256 || base.starts_with('-') || base.contains(['\0', '\r', '\n']) {
                return Err("Choose a valid base branch or commit (at most 256 characters).".into());
            }
            // Resolve once, then compare fixed commits: a moving ref cannot
            // make the metadata and patch refer to different branch states.
            let base_ref = format!("{base}^{{commit}}");
            let base_oid = run_git_read(cwd, &["rev-parse", "--verify", "--end-of-options", &base_ref]).map_err(|_| "The base branch or commit was not found. Check its name and compare again.")?.trim().to_string();
            let head = run_git_read(cwd, &["rev-parse", "--verify", "HEAD^{commit}"]).map_err(|_| "Branch review needs a committed HEAD.")?.trim().to_string();
            let common = run_git_read(cwd, &["merge-base", &base_oid, &head]).map_err(|_| "The base and HEAD have no common ancestor.")?.trim().to_string();
            revisions.extend([common.clone(), head.clone()]);
            base_commit = Some(common);
            head_commit = Some(head);
        }
        _ => return Err("This scope requires a saved turn snapshot.".into()),
    }
    let read_args = |mode: &'static str| {
        let mut args = vec!["diff", mode, "-z", "--relative", "--no-renames", "--no-ext-diff", "--no-textconv"];
        args.extend(revisions.iter().map(String::as_str));
        args.extend(["--", "."]);
        args
    };
    let (names, names_cut) = run_git_capped(cwd, &read_args("--name-status"), DIFF_LIMIT)?;
    let (numstat, counts_cut) = run_git_capped(cwd, &read_args("--numstat"), DIFF_LIMIT)?;
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--submodule=short", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--relative"];
    args.extend(revisions.iter().map(String::as_str));
    args.extend(["--", "."]);
    let (mut diff, diff_cut) = run_git_capped(cwd, &args, DIFF_LIMIT)?;
    let mut truncated = names_cut || counts_cut || diff_cut;
    let mut files = review_files(&names, &numstat, &mut truncated);
    if request.scope == ReviewScope::Unstaged {
        let (new_paths, new_cut) = run_git_capped(cwd, &["ls-files", "--others", "--exclude-standard", "-z", "--", "."], DIFF_LIMIT)?;
        truncated |= new_cut;
        let complete = new_paths.rfind('\0').map(|at| &new_paths[..=at]).unwrap_or("");
        for path in complete.split('\0').filter(|path| !path.is_empty()) {
            if files.len() >= 2000 {
                truncated = true;
                break;
            }
            files.push(GitFile {
                path: path.into(),
                status: "??".into(),
                added: 0,
                removed: 0,
                preview_skipped: None,
            });
        }
        append_untracked_previews(cwd, &mut files, &mut diff, &mut truncated);
    }
    if truncated {
        diff.push_str("\n…truncated");
    }
    Ok(GitReview {
        files,
        diff,
        truncated,
        base_commit,
        head_commit,
    })
}

/// Cut `text` to at most `limit` bytes on a character boundary (a plain
/// `String::truncate` panics when the cut lands inside a multi-byte character,
/// which a large diff of non-ASCII source will do). True when it was cut.
fn cap_text(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut cut = limit;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    true
}

/// Per-new-file preview cap: enough for a real source file, bounded so a
/// generated artifact cannot crowd out the rest of the diff.
const UNTRACKED_PREVIEW_BYTES: usize = 256 * 1024;
/// At most this many new files get an inline preview per snapshot.
const UNTRACKED_PREVIEW_COUNT: usize = 200;

/// `prefix`-relative path for a diff header, quoted the way `core.quotePath`
/// does it: bare while every byte is printable ASCII, otherwise wrapped in
/// double quotes with C escapes (`\t`, `\"`, `\\`) and octal for the rest.
fn diff_path(prefix: &str, path: &str) -> String {
    let bytes = path.as_bytes();
    if !bytes.iter().any(|byte| *byte < 0x20 || *byte == b'"' || *byte == b'\\' || *byte >= 0x80) {
        return format!("{prefix}{path}");
    }
    let mut escaped = String::with_capacity(path.len() + 8);
    for byte in bytes {
        let text = match *byte {
            0x07 => "\\a".to_string(),
            0x08 => "\\b".to_string(),
            b'\t' => "\\t".to_string(),
            b'\n' => "\\n".to_string(),
            0x0b => "\\v".to_string(),
            0x0c => "\\f".to_string(),
            b'\r' => "\\r".to_string(),
            b'"' => "\\\"".to_string(),
            b'\\' => "\\\\".to_string(),
            byte if !(0x20..0x80).contains(&byte) => format!("\\{byte:03o}"),
            byte => (byte as char).to_string(),
        };
        escaped.push_str(&text);
    }
    format!("\"{prefix}{escaped}\"")
}

/// What one `??` entry contributes to the snapshot diff.
enum UntrackedPreview {
    /// A synthetic `new file` patch plus the number of lines added.
    Patch {
        text: String,
        added: u32,
    },
    /// The honest reason there is no preview, for the dock to report.
    Skipped(&'static str),
}

/// Preview one untracked file. The read stays inside the granted cwd (lexical
/// `..`/absolute rejection, then canonical containment so a symlink inside the
/// folder cannot redirect the read outside it), is bounded at
/// `UNTRACKED_PREVIEW_BYTES + 1`, and only produces a patch for UTF-8 text
/// without NULs. `budget` is the room left under `DIFF_LIMIT`.
fn untracked_preview(canonical_cwd: &Path, relative: &str, budget: usize) -> UntrackedPreview {
    use std::io::Read;
    let candidate = Path::new(relative);
    if relative.is_empty() || relative.len() > 4096 || candidate.is_absolute() || candidate.components().any(|part| !matches!(part, std::path::Component::Normal(_))) {
        return UntrackedPreview::Skipped("unsupported");
    }
    let joined = canonical_cwd.join(candidate);
    let Ok(meta) = joined.symlink_metadata() else {
        return UntrackedPreview::Skipped("unavailable");
    };
    if !meta.is_file() {
        return UntrackedPreview::Skipped("unsupported");
    }
    // Refuse oversized reads from the stat up front; `take` still caps the
    // read itself in case the file keeps growing underneath us.
    if meta.len() > UNTRACKED_PREVIEW_BYTES as u64 {
        return UntrackedPreview::Skipped("tooLarge");
    }
    let Ok(canonical) = joined.canonicalize() else {
        return UntrackedPreview::Skipped("unavailable");
    };
    if !canonical.starts_with(canonical_cwd) {
        return UntrackedPreview::Skipped("unsupported");
    }
    let Ok(file) = std::fs::File::open(&canonical) else {
        return UntrackedPreview::Skipped("unavailable");
    };
    let mut bytes = Vec::new();
    if file.take(UNTRACKED_PREVIEW_BYTES as u64 + 1).read_to_end(&mut bytes).is_err() {
        return UntrackedPreview::Skipped("unavailable");
    }
    if bytes.len() > UNTRACKED_PREVIEW_BYTES {
        return UntrackedPreview::Skipped("tooLarge");
    }
    if bytes.contains(&0) {
        return UntrackedPreview::Skipped("binary");
    }
    let Ok(text) = String::from_utf8(bytes) else {
        return UntrackedPreview::Skipped("binary");
    };
    // Executable new files keep their real mode in the synthetic patch header.
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if meta.permissions().mode() & 0o111 != 0 {
            "100755"
        } else {
            "100644"
        }
    };
    let quoted = diff_path("b/", relative);
    let mut patch = format!("diff --git {} {}\nnew file mode {mode}\n--- /dev/null\n+++ {quoted}\n", diff_path("a/", relative), quoted);
    if !text.is_empty() {
        let body: Vec<&str> = text.split('\n').collect();
        // A trailing newline ends the last line instead of starting an empty one.
        let (lines, terminated) = if text.ends_with('\n') {
            (&body[..body.len() - 1], true)
        } else {
            (&body[..], false)
        };
        patch.push_str(&format!("@@ -0,0 +1,{} @@\n", lines.len()));
        for line in lines {
            patch.push('+');
            patch.push_str(line);
            patch.push('\n');
        }
        if !terminated {
            patch.push_str("\\ No newline at end of file\n");
        }
        if patch.len() > budget {
            return UntrackedPreview::Skipped("limit");
        }
        return UntrackedPreview::Patch {
            text: patch,
            added: lines.len() as u32,
        };
    }
    if patch.len() > budget {
        return UntrackedPreview::Skipped("limit");
    }
    UntrackedPreview::Patch {
        text: patch,
        added: 0,
    }
}

fn git_snapshot_for(cwd: &Path) -> Result<GitSnapshot, String> {
    if !cwd.exists() {
        return Err("Workspace folder no longer exists".into());
    }
    // Work-tree status first: a granted folder outside any repository gets an
    // honest empty snapshot. Real failures — git missing, permissions, a
    // corrupt repo — stay errors; only the "not a git repository" failure and
    // a bare/inside-work-tree=false answer mean non-repo.
    match run_git_read(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        Ok(inside) if inside.trim() == "true" => {}
        Ok(_) => return Ok(GitSnapshot::plain()),
        Err(err) if err.contains("not a git repository") => return Ok(GitSnapshot::plain()),
        Err(err) => return Err(err),
    }
    // The grant may sit inside a larger repository. `status -- .` scopes the
    // work to the granted subtree, and stripping the cwd prefix keeps every
    // reported path cwd-relative so siblings of the grant are never revealed.
    let prefix = run_git_read(cwd, &["rev-parse", "--show-prefix"])?.trim_end().to_string();
    // These five reads are independent, so they run side by side: the snapshot
    // costs as much as the slowest one instead of the sum of all of them. The
    // `HEAD` forms are speculative; an unborn branch discards them below.
    // `--relative` keeps diff paths cwd-relative, matching the status scoping.
    let (porcelain, branch, has_head, numstat, diff) = std::thread::scope(|scope| {
        let status = scope.spawn(|| run_git_read(cwd, &["status", "--porcelain", "-z", "--untracked-files=all", "--", "."]));
        let branch = scope.spawn(|| run_git_read(cwd, &["symbolic-ref", "--short", "HEAD"]).or_else(|_| run_git_read(cwd, &["rev-parse", "--short", "HEAD"])));
        let head = scope.spawn(|| run_git_read(cwd, &["rev-parse", "--verify", "HEAD"]).is_ok());
        let numstat = scope.spawn(|| run_git_read(cwd, &["diff", "--numstat", "-z", "--relative", "HEAD", "--", "."]));
        // Static decoration/context flags: the dock's hunk indices and colors
        // must not move when the user's gitconfig changes.
        let diff = scope.spawn(|| run_git_capped(cwd, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--relative", "HEAD", "--", "."], DIFF_LIMIT));
        (status.join(), branch.join(), head.join(), numstat.join(), diff.join())
    });
    let panicked = || "git failed: a background read did not finish".to_string();
    let porcelain = porcelain.map_err(|_| panicked())??;
    let branch = branch.map_err(|_| panicked())??.trim().to_string();
    let has_head = has_head.map_err(|_| panicked())?;
    let numstat = numstat.map_err(|_| panicked())?;
    let diff = diff.map_err(|_| panicked())?;
    let (numstat, mut diff, mut truncated) = if has_head {
        let (diff, cut) = diff?;
        (numstat?, diff, cut)
    } else {
        let (staged, staged_cut) = run_git_capped(cwd, &["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--relative", "--", "."], DIFF_LIMIT)?;
        let (worktree, worktree_cut) = run_git_capped(cwd, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--relative", "--", "."], DIFF_LIMIT)?;
        (run_git_read(cwd, &["diff", "--numstat", "-z", "--cached", "--relative", "--", "."])?, format!("{staged}{worktree}"), staged_cut || worktree_cut)
    };
    truncated |= cap_text(&mut diff, DIFF_LIMIT);
    let counts = parse_numstat_z(&numstat);
    let mut files = Vec::new();
    for (file_path, status) in parse_porcelain_z(&porcelain) {
        // Porcelain paths are repo-root-relative; the granted cwd may be a
        // subdirectory, so keep only entries under it and re-root them.
        let Some(relative) = file_path.strip_prefix(prefix.as_str()).filter(|path| !path.is_empty()) else {
            continue;
        };
        let (added, removed) = counts.get(relative).copied().unwrap_or((0, 0));
        files.push(GitFile {
            path: relative.to_string(),
            status,
            added,
            removed,
            preview_skipped: None,
        });
    }
    // New files get a synthetic `new file` patch appended to the tracked diff,
    // each bounded and honestly flagged when a preview is not safe to show.
    // The cap counts ATTEMPTS, not successes — thousands of binary files must
    // not turn into unbounded stat/open work either.
    append_untracked_previews(cwd, &mut files, &mut diff, &mut truncated);
    if truncated {
        diff.push_str("\n…truncated");
    }
    Ok(GitSnapshot {
        repository: true,
        dirty: !files.is_empty(),
        files,
        diff,
        truncated,
        branch: if branch.is_empty() {
            "HEAD".into()
        } else {
            branch
        },
    })
}

fn append_untracked_previews(cwd: &Path, files: &mut [GitFile], diff: &mut String, truncated: &mut bool) {
    let canonical_cwd = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
    let mut attempts = 0usize;
    for file in files.iter_mut().filter(|file| file.status == "??") {
        if attempts >= UNTRACKED_PREVIEW_COUNT {
            file.preview_skipped = Some("limit".into());
            *truncated = true;
            continue;
        }
        attempts += 1;
        match untracked_preview(&canonical_cwd, &file.path, DIFF_LIMIT.saturating_sub(diff.len())) {
            UntrackedPreview::Patch {
                text,
                added,
            } => {
                file.added = added;
                diff.push_str(&text);
            }
            UntrackedPreview::Skipped(reason) => {
                file.preview_skipped = Some(reason.into());
                if reason == "limit" {
                    *truncated = true;
                }
            }
        }
    }
}

/// Initialize git inside a granted folder. Runs only `git init` — existing
/// files are left exactly as they are and nothing is committed — then returns
/// a fresh snapshot so the dock switches straight to review.
#[tauri::command]
async fn git_init(state: State<'_, AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _write = git_write_lock();
        git_init_at(&cwd, &grant_id)
    })
    .await
}

#[cfg(test)]
fn git_init_inner(state: &AppState, grant_id: &str) -> Result<GitSnapshot, String> {
    let cwd = grant_root(state, grant_id)?;
    git_init_at(&cwd, grant_id)
}

fn git_init_at(cwd: &Path, grant_id: &str) -> Result<GitSnapshot, String> {
    run_git(cwd, &["init", "-q"])?;
    native_log("info", "git.init", &format!("git init in grant {}", grant_tag(grant_id)));
    git_snapshot_for(cwd)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeGrant {
    grant_id: String,
    path: String,
    branch: String,
    base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeRemoval {
    branch: Option<String>,
    branch_kept: bool,
}

/// Where app-made worktrees live. Created on demand and canonicalized, so the
/// containment checks below compare like with like.
fn worktree_store<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|_| "Worktree storage is unavailable.")?.join("worktrees");
    std::fs::create_dir_all(&dir).map_err(|err| format!("Worktree storage is unavailable: {err}"))?;
    dir.canonicalize().map_err(|err| format!("Worktree storage is unavailable: {err}"))
}

/// Worktrees made by builds named Muse Code stay in that app's data folder
/// (see `legacy.rs`). This is their store while any remain.
fn legacy_worktree_store<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let data = app.path().app_data_dir().ok()?;
    legacy::sibling(&data).join("worktrees").canonicalize().ok()
}

/// The store a grant's worktree belongs to: the legacy one when its root lies
/// there, otherwise the current store.
fn worktree_store_for<R: Runtime>(app: &AppHandle<R>, state: &AppState, grant_id: &str) -> Result<PathBuf, String> {
    let store = worktree_store(app)?;
    let Some(legacy) = legacy_worktree_store(app) else {
        return Ok(store);
    };
    let root = state.grants.lock().map_err(|err| err.to_string())?.get(grant_id).cloned();
    Ok(if root.is_some_and(|root| root.starts_with(&legacy)) { legacy } else { store })
}

/// Create a worktree of a granted repository and mint a grant for its root.
/// This is the one place a grant is derived instead of picked: the new root is
/// a directory this command just created inside the app's own store, for a
/// repository the caller already holds, so it widens nothing.
#[tauri::command]
async fn git_worktree_create(app: AppHandle, grant_id: String, base: Option<String>) -> Result<WorktreeGrant, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        // A legacy worktree is refused like any other: the inner check sees its store.
        let store = worktree_store_for(&app, &state, &grant_id)?;
        git_worktree_create_inner(&state, &store, &grant_id, base.as_deref())
    })
    .await
}

fn git_worktree_create_inner(state: &AppState, store: &Path, grant_id: &str, base: Option<&str>) -> Result<WorktreeGrant, String> {
    let root = grant_root(state, grant_id)?;
    if root.starts_with(store) {
        return Err("Start a worktree thread from the workspace, not from another worktree.".into());
    }
    let _write = git_write_lock();
    let created = worktrees::create(&root, store, base)?;
    // The grant may have been revoked while git ran. Its worktrees go with it.
    if grant_root(state, grant_id).ok().as_ref() != Some(&root) || !created.path.starts_with(store) {
        let _ = worktrees::remove(Some(&root), &created.path, true);
        return Err("Workspace access changed while creating the worktree.".into());
    }
    let grant = match mint_grant(state, created.path.clone()) {
        Ok(grant) => grant,
        Err(err) => {
            let _ = worktrees::remove(Some(&root), &created.path, true);
            return Err(err);
        }
    };
    native_log("info", "worktree.create", &format!("git worktree created for grant {} as {}", grant_tag(grant_id), grant_tag(&grant.grant_id)));
    Ok(WorktreeGrant {
        grant_id: grant.grant_id,
        path: grant.path,
        branch: created.branch,
        base: created.base,
        warning: grant.warning,
    })
}

/// Grants whose roots are worktrees of the repository at `root`.
fn derived_grants(grants: &HashMap<String, PathBuf>, store: &Path, root: &Path) -> Vec<(String, PathBuf)> {
    let home = worktrees::repo_store(store, root);
    grants.iter().filter(|(_, dir)| dir.parent() == Some(home.as_path())).map(|(id, dir)| (id.clone(), dir.clone())).collect()
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorktreeHandoff {
    /// Files the applied patch touched. Zero means there was nothing to apply.
    files: usize,
    snapshot: GitSnapshot,
}

/// Apply a worktree's changes to the workspace folder it came from, as
/// uncommitted edits. All or nothing: if any part does not apply to what is in
/// the workspace now, nothing there changes. The worktree is left as it is.
#[tauri::command]
async fn git_worktree_handoff(app: AppHandle, grant_id: String) -> Result<WorktreeHandoff, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let store = worktree_store_for(&app, &state, &grant_id)?;
        git_worktree_handoff_inner(&state, &store, &grant_id)
    })
    .await
}

fn git_worktree_handoff_inner(state: &AppState, store: &Path, grant_id: &str) -> Result<WorktreeHandoff, String> {
    let dir = grant_root(state, grant_id)?;
    let home = dir.parent().filter(|home| home.parent() == Some(store)).ok_or("That folder is not a worktree made by Glitter.")?;
    // The destination is the granted workspace this worktree was made from; a
    // revoked workspace cannot be written to through its worktree.
    let repo = {
        let grants = state.grants.lock().map_err(|err| err.to_string())?;
        grants.values().find(|root| !root.starts_with(store) && worktrees::repo_store(store, root) == home).cloned()
    }
    .filter(|repo| repo.exists())
    .ok_or("The workspace this worktree came from is not open. Re-open it, then try again.")?;
    let _write = git_write_lock();
    let Some(patch) = worktrees::changes(&repo, &dir)? else {
        return Ok(WorktreeHandoff {
            files: 0,
            snapshot: git_snapshot_for(&repo)?,
        });
    };
    // The patch stays bytes end to end: a file in another encoding must arrive unchanged.
    let files = patch.split(|byte| *byte == b'\n').filter(|line| line.starts_with(b"diff --git ")).count();
    // `--check` first, so a patch that cannot land leaves no partial edits behind.
    run_git_stdin_bytes(&repo, &["apply", "--check", "--whitespace=nowarn", "-"], &patch).map_err(|_| "These changes do not apply cleanly to the workspace folder as it is now. Nothing was changed. Commit or set aside the conflicting edits there, or merge the worktree's branch with git.".to_string())?;
    run_git_stdin_bytes(&repo, &["apply", "--whitespace=nowarn", "-"], &patch)?;
    native_log("info", "worktree.handoff", &format!("git worktree handoff: {files} file(s) from grant {}", grant_tag(grant_id)));
    Ok(WorktreeHandoff {
        files,
        snapshot: git_snapshot_for(&repo)?,
    })
}

/// Remove a worktree this app created, with its uncommitted files, and revoke
/// its grant. Only grants rooted in the worktree store qualify, so this can
/// never delete a folder the user opened. The branch survives when it holds
/// commits no other ref has.
#[tauri::command]
async fn git_worktree_remove(app: AppHandle, grant_id: String) -> Result<WorktreeRemoval, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let store = worktree_store_for(&app, &state, &grant_id)?;
        let removed = git_worktree_remove_inner(&state, &store, &grant_id)?;
        if legacy_worktree_store(&app).as_ref() == Some(&store) {
            legacy::prune_worktree_store(&store);
        }
        Ok(removed)
    })
    .await
}

fn git_worktree_remove_inner(state: &AppState, store: &Path, grant_id: &str) -> Result<WorktreeRemoval, String> {
    if !valid_grant_id(grant_id) {
        return Err("Unknown workspace grant.".into());
    }
    let _write = git_write_lock();
    // The directory may already be gone, so this reads the table directly
    // rather than through `grant_root`.
    let (dir, repo) = {
        let grants = state.grants.lock().map_err(|err| err.to_string())?;
        let dir = grants.get(grant_id).cloned().ok_or("Unknown workspace grant.")?;
        let home = dir.parent().filter(|home| home.parent() == Some(store)).ok_or("That folder is not a worktree made by Glitter.")?;
        let repo = grants.values().find(|root| !root.starts_with(store) && worktrees::repo_store(store, root) == home).cloned();
        (dir, repo)
    };
    let removed = worktrees::remove(repo.as_deref().filter(|repo| repo.exists()), &dir, true)?;
    native_log("info", "worktree.remove", &format!("git worktree removed: grant {}", grant_tag(grant_id)));
    if let Ok(mut terminals) = state.terminals.lock() {
        terminals.close_grants(&[grant_id.to_string()]);
    }
    {
        let mut grants = state.grants.lock().map_err(|err| err.to_string())?;
        grants.remove(grant_id);
        let _ = persist_grants(&grants);
    }
    drop_grant_bindings(state, grant_id);
    Ok(WorktreeRemoval {
        branch: removed.branch,
        branch_kept: removed.branch_kept,
    })
}

const FILE_INDEX_LIMIT: usize = 20_000;
/// Dirs the fallback walk never descends into: VCS metadata, dependency and
/// build outputs, tooling caches, and every dot-directory.
const FILE_INDEX_SKIP: &[&str] = &[".git", "node_modules", "target", "dist", ".tooling"];

/// Repo-relative forward-slash paths for @-mentions: `git ls-files` (tracked +
/// untracked-but-not-ignored) when the grant is a repo, else a bounded walk.
#[tauri::command]
async fn list_workspace_files(state: State<'_, AppState>, grant_id: String) -> Result<Vec<String>, String> {
    let root = grant_root(&state, &grant_id)?;
    // `git ls-files` (or a directory walk) over a large repository is the
    // slowest thing the shell does on a timer; it must not hold the UI thread.
    blocking(move || workspace_files_for(&root)).await
}

fn workspace_files_for(root: &Path) -> Result<Vec<String>, String> {
    if !root.exists() {
        return Err("Workspace folder no longer exists".into());
    }
    if let Ok(listed) = run_git(root, &["ls-files", "--cached", "--others", "--exclude-standard", "-z"]) {
        let mut files: Vec<String> = listed.split('\0').filter(|entry| !entry.is_empty()).take(FILE_INDEX_LIMIT).map(str::to_string).collect();
        files.sort();
        return Ok(files);
    }
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if name.starts_with('.') || FILE_INDEX_SKIP.contains(&name) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                stack.push(entry.path());
                continue;
            }
            if !kind.is_file() {
                continue;
            }
            if let Ok(relative) = entry.path().strip_prefix(root) {
                files.push(relative.to_string_lossy().replace('\\', "/"));
                if files.len() >= FILE_INDEX_LIMIT {
                    files.sort();
                    return Ok(files);
                }
            }
        }
    }
    files.sort();
    Ok(files)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    current: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    upstream: Option<String>,
}

const BRANCH_LIST_LIMIT: usize = 100;

/// Local branches, most recently committed first.
#[tauri::command]
async fn git_branches(state: State<'_, AppState>, grant_id: String) -> Result<Vec<GitBranch>, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || git_branches_at(&cwd)).await
}

fn git_branches_at(cwd: &Path) -> Result<Vec<GitBranch>, String> {
    let listed = run_git_read(cwd, &["for-each-ref", "--sort=-committerdate", &format!("--count={BRANCH_LIST_LIMIT}"), "--format=%(HEAD)%09%(refname:short)%09%(upstream:short)", "refs/heads"])?;
    Ok(listed
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let (head, name, upstream) = (parts.next()?, parts.next()?, parts.next().unwrap_or(""));
            (!name.is_empty()).then(|| GitBranch {
                name: name.to_string(),
                current: head == "*",
                upstream: (!upstream.is_empty()).then(|| upstream.to_string()),
            })
        })
        .collect())
}

/// A branch name the renderer nominated, checked by git's own rules before it
/// reaches a command line. `--branch` also refuses a leading dash.
fn valid_branch_name(cwd: &Path, name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 200 || name.chars().any(|ch| ch.is_control() || ch.is_whitespace()) || run_git_read(cwd, &["check-ref-format", "--branch", name]).is_err() {
        return Err("That is not a valid branch name.".into());
    }
    Ok(())
}

/// Switch to a local branch, or create one from the current commit. Uncommitted
/// changes come along; git refuses the switch when they would be overwritten.
#[tauri::command]
async fn git_switch(state: State<'_, AppState>, grant_id: String, branch: String, create: bool) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _guard = git_write_lock();
        git_switch_at(&cwd, &branch, create)?;
        native_log(
            "info",
            "git.switch",
            &format!("git switch{} in grant {}", if create { " -c" } else { "" }, grant_tag(&grant_id)),
        );
        git_snapshot_for(&cwd)
    })
    .await
}

fn git_switch_at(cwd: &Path, branch: &str, create: bool) -> Result<(), String> {
    valid_branch_name(cwd, branch)?;
    let exists = run_git_read(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_ok();
    if create && exists {
        return Err(format!("A branch named {branch} already exists."));
    }
    if !create && !exists {
        return Err(format!("There is no local branch named {branch}."));
    }
    let args: &[&str] = if create {
        &["switch", "-c", branch]
    } else {
        &["switch", branch]
    };
    run_git(cwd, args).map(|_| ()).map_err(|err| {
        if err.contains("would be overwritten") {
            "Your uncommitted changes would be overwritten on that branch. Commit or discard them first.".into()
        } else if err.contains("already checked out") || err.contains("is already used by worktree") {
            format!("{branch} is checked out in another worktree.")
        } else {
            err
        }
    })
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GitPush {
    branch: String,
    remote: String,
}

/// A network git or `gh` command. It runs with the user's own environment so
/// their credential helper, SSH agent and `gh` login apply; this app never
/// handles a git credential. Nothing can prompt: there is no terminal, so a
/// missing credential fails at once instead of hanging.
fn network_command(program: &str, cwd: &Path) -> Command {
    let mut cmd = command(program);
    cmd.current_dir(cwd).env("GIT_TERMINAL_PROMPT", "0").env("GH_PROMPT_DISABLED", "1").env("GH_NO_UPDATE_NOTIFIER", "1");
    if std::env::var_os("GIT_SSH_COMMAND").is_none() {
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
    }
    cmd
}

const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);

fn tool_failure(what: &str, output: &std::process::Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.lines().map(str::trim).rfind(|line| !line.is_empty()).unwrap_or("no details").to_string();
    format!("{what}: {}", redact_log_detail(&detail))
}

/// Push the current branch. A branch with an upstream pushes there; a new one
/// is published to `origin` (or the only remote) and tracks it.
#[tauri::command]
async fn git_push(state: State<'_, AppState>, grant_id: String) -> Result<GitPush, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let pushed = git_push_at(&cwd)?;
        native_log("info", "git.push", &format!("git push in grant {}", grant_tag(&grant_id)));
        Ok(pushed)
    })
    .await
}

fn git_push_at(cwd: &Path) -> Result<GitPush, String> {
    let branch = run_git_read(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).map(|out| out.trim().to_string()).unwrap_or_default();
    if branch.is_empty() {
        return Err("Check out a branch before pushing. HEAD is detached.".into());
    }
    let tracked = run_git_read(cwd, &["config", "--get", &format!("branch.{branch}.remote")]).map(|out| out.trim().to_string()).unwrap_or_default();
    let mut cmd = network_command("git", cwd);
    let remote = if !tracked.is_empty() && tracked != "." {
        cmd.arg("push");
        tracked
    } else {
        let remotes: Vec<String> = run_git_read(cwd, &["remote"])?.lines().map(str::to_string).filter(|name| !name.is_empty()).collect();
        let remote = if remotes.iter().any(|name| name == "origin") {
            "origin".to_string()
        } else if remotes.len() == 1 {
            remotes[0].clone()
        } else if remotes.is_empty() {
            return Err("This repository has no remote to push to. Add one with git first.".into());
        } else {
            return Err("This branch has no upstream and the repository has several remotes. Set the upstream with git first.".into());
        };
        cmd.args(["push", "-u", "--", &remote, &branch]);
        remote
    };
    let output = run_bounded(cmd, "git push", NETWORK_TIMEOUT)?;
    if !output.status.success() {
        return Err(tool_failure("Push failed", &output));
    }
    Ok(GitPush {
        branch,
        remote,
    })
}

/// Bring the current branch up to its upstream, fast-forward only. Nothing is
/// merged or rebased here: if the branch has diverged, or local changes are in
/// the way, git refuses and the working tree is left as it was.
#[tauri::command]
async fn git_pull(state: State<'_, AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _guard = git_write_lock();
        git_pull_at(&cwd)?;
        native_log("info", "git.pull", &format!("git pull in grant {}", grant_tag(&grant_id)));
        git_snapshot_for(&cwd)
    })
    .await
}

fn git_pull_at(cwd: &Path) -> Result<(), String> {
    let branch = run_git_read(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).map(|out| out.trim().to_string()).unwrap_or_default();
    if branch.is_empty() {
        return Err("Check out a branch before pulling. HEAD is detached.".into());
    }
    if run_git_read(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_err() {
        return Err(format!("{branch} has no upstream to pull from. Push it first, or set the upstream with git."));
    }
    let mut cmd = network_command("git", cwd);
    cmd.args(["pull", "--ff-only", "--no-rebase"]);
    let output = run_bounded(cmd, "git pull", NETWORK_TIMEOUT)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        if detail.contains("not possible to fast-forward") || detail.contains("diverging branches") || detail.contains("divergent branches") {
            return Err(format!("{branch} and its upstream have diverged. Merge or rebase with git, then try again."));
        }
        if detail.contains("would be overwritten") {
            return Err("Your uncommitted changes would be overwritten by the pull. Commit or discard them first.".into());
        }
        return Err(tool_failure("Pull failed", &output));
    }
    Ok(())
}

#[derive(Debug, Serialize, Clone, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    /// Why pull requests are unavailable here (no `gh`, not signed in). Absent when they work.
    #[serde(skip_serializing_if = "Option::is_none")]
    unavailable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    number: Option<u64>,
    /// `OPEN`, `MERGED` or `CLOSED`, as GitHub reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<String>,
    /// `passing`, `failing`, `pending`, or `none` when the PR has no checks.
    #[serde(skip_serializing_if = "Option::is_none")]
    checks: Option<String>,
}

/// Fold GitHub's per-check rollup into one word. Anything failed wins, then anything unfinished.
fn checks_summary(rollup: &Value) -> &'static str {
    let Some(checks) = rollup.as_array().filter(|checks| !checks.is_empty()) else {
        return "none";
    };
    let word = |check: &Value, key: &str| check.get(key).and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    let mut pending = false;
    for check in checks {
        let (status, conclusion, state) = (word(check, "status"), word(check, "conclusion"), word(check, "state"));
        if matches!(conclusion.as_str(), "FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE") || matches!(state.as_str(), "FAILURE" | "ERROR") {
            return "failing";
        }
        if (!status.is_empty() && status != "COMPLETED") || matches!(state.as_str(), "PENDING" | "EXPECTED") {
            pending = true;
        }
    }
    if pending {
        "pending"
    } else {
        "passing"
    }
}

fn parse_pull_request(json: &str) -> Result<PullRequest, String> {
    let value: Value = serde_json::from_str(json).map_err(|_| "GitHub CLI returned something unreadable.".to_string())?;
    Ok(PullRequest {
        unavailable: None,
        url: value.get("url").and_then(Value::as_str).filter(|url| url_open_allowed(url)).map(str::to_string),
        number: value.get("number").and_then(Value::as_u64),
        state: value.get("state").and_then(Value::as_str).map(str::to_string),
        checks: Some(checks_summary(value.get("statusCheckRollup").unwrap_or(&Value::Null)).to_string()),
    })
}

/// The current branch's pull request, read (or first created) with the user's
/// own `gh`. Creating one uses the branch's commits for the title and body.
#[tauri::command]
async fn git_pull_request(state: State<'_, AppState>, grant_id: String, create: bool) -> Result<PullRequest, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || git_pull_request_at(&cwd, create)).await
}

fn git_pull_request_at(cwd: &Path, create: bool) -> Result<PullRequest, String> {
    let unavailable = |reason: &str| {
        Ok(PullRequest {
            unavailable: Some(reason.to_string()),
            ..PullRequest::default()
        })
    };
    let mut auth = network_command("gh", cwd);
    auth.args(["auth", "status"]);
    match run_bounded(auth, "GitHub CLI", Duration::from_secs(30)) {
        Err(err) if err.starts_with("Could not start") => return unavailable("Install the GitHub CLI (gh) to create pull requests here."),
        Err(err) => return Err(err),
        Ok(output) if !output.status.success() => return unavailable("Sign in to the GitHub CLI with `gh auth login` to create pull requests here."),
        Ok(_) => {}
    }
    if create {
        let mut cmd = network_command("gh", cwd);
        cmd.args(["pr", "create", "--fill"]);
        let output = run_bounded(cmd, "GitHub CLI", NETWORK_TIMEOUT)?;
        if !output.status.success() {
            return Err(tool_failure("Could not create the pull request", &output));
        }
    }
    let mut view = network_command("gh", cwd);
    view.args(["pr", "view", "--json", "url,number,state,statusCheckRollup"]);
    let output = run_bounded(view, "GitHub CLI", NETWORK_TIMEOUT)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).to_ascii_lowercase();
        // No pull request for this branch yet is an answer, not a failure.
        if detail.contains("no pull requests found") || detail.contains("no open pull requests") {
            return Ok(PullRequest::default());
        }
        return Err(tool_failure("Could not read the pull request", &output));
    }
    parse_pull_request(&String::from_utf8_lossy(&output.stdout))
}

/// Bytes of one file the viewer shows. Larger files come back cut, and say so.
const FILE_VIEW_LIMIT: u64 = 256 * 1024;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    path: String,
    /// Absent when the file is not shown; `skipped` then says why.
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    size: u64,
    truncated: bool,
    /// `binary` when the bytes are not text.
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped: Option<String>,
}

/// Read one file for the read-only viewer. The renderer names a path relative
/// to its grant; the read is confined to the grant's root, to regular files,
/// and to a byte ceiling.
#[tauri::command]
async fn read_workspace_file(state: State<'_, AppState>, grant_id: String, path: String) -> Result<WorkspaceFile, String> {
    let root = grant_root(&state, &grant_id)?;
    blocking(move || read_workspace_file_at(&root, &path)).await
}

fn read_workspace_file_at(root: &Path, raw: &str) -> Result<WorkspaceFile, String> {
    use std::path::Component;
    let invalid = || "That file path is not valid.".to_string();
    if raw.is_empty() || raw.len() > DISCARD_PATH_LEN || raw.contains('\0') {
        return Err(invalid());
    }
    let candidate = Path::new(raw);
    // Relative, no `..`, and never git's own metadata: `.git/config` can hold
    // credentials, and nothing a user browses for lives there.
    if candidate.is_absolute() || !candidate.components().all(|part| matches!(part, Component::Normal(name) if !name.to_string_lossy().eq_ignore_ascii_case(".git"))) {
        return Err(invalid());
    }
    // Canonical containment: a symlink inside the workspace cannot point the
    // read at a file outside it.
    let canon = root.join(candidate).canonicalize().map_err(|_| "That file is no longer available.".to_string())?;
    if !canon.starts_with(root) || canon.strip_prefix(root).map(|rest| rest.components().any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))).unwrap_or(true) {
        return Err("Viewing files is limited to the current workspace.".into());
    }
    let meta = std::fs::metadata(&canon).map_err(|_| "That file is no longer available.".to_string())?;
    if !meta.is_file() {
        return Err("Only regular files can be viewed.".into());
    }
    let file = std::fs::File::open(&canon).map_err(|err| format!("Could not open the file: {err}"))?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(file, FILE_VIEW_LIMIT), &mut bytes).map_err(|err| format!("Could not read the file: {err}"))?;
    let size = meta.len();
    let path = raw.replace('\\', "/");
    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Ok(WorkspaceFile {
            path,
            content: None,
            size,
            truncated: false,
            skipped: Some("binary".into()),
        });
    }
    let truncated = size > bytes.len() as u64;
    // A cut can land inside a multi-byte character; drop the broken tail rather than show a replacement mark.
    let text = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) if truncated && err.utf8_error().error_len().is_none() => {
            let valid = err.utf8_error().valid_up_to();
            String::from_utf8_lossy(&err.into_bytes()[..valid]).into_owned()
        }
        Err(err) => String::from_utf8_lossy(err.as_bytes()).into_owned(),
    };
    Ok(WorkspaceFile {
        path,
        content: Some(text),
        size,
        truncated,
        skipped: None,
    })
}

const DISCARD_PATH_LIMIT: usize = 200;
const DISCARD_PATH_LEN: usize = 1024;

/// Confine a renderer-supplied discard path to the granted repo: it must be a
/// short repo-relative path with no `..` escape. Existing files additionally
/// resolve canonically so a symlink inside the repo cannot redirect the
/// discard outside it; deleted files (which cannot canonicalize) rely on the
/// lexical check plus git's own pathspec confinement to the repo.
fn discard_path(cwd: &Path, raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > DISCARD_PATH_LEN || raw.contains('\0') {
        return Err("That file path is not valid for discard.".into());
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() || candidate.components().any(|part| matches!(part, std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_))) {
        return Err("That file path is not valid for discard.".into());
    }
    let joined = cwd.join(candidate);
    if joined.symlink_metadata().is_ok() {
        let canon = joined.canonicalize().map_err(|_| "That file is no longer available.".to_string())?;
        if !canon.starts_with(cwd) {
            return Err("Discarding files is limited to the current workspace.".into());
        }
    }
    Ok(raw.to_string())
}

/// Discard working-tree changes for listed repo-relative paths: tracked files
/// restore from HEAD (unstaging first), untracked files are removed, ignored
/// files are never touched. Unchanged paths are a silent no-op. Returns a
/// fresh snapshot so the dock re-renders from truth.
#[tauri::command]
async fn git_discard_files(state: State<'_, AppState>, grant_id: String, paths: Vec<String>) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _write = git_write_lock();
        git_discard_files_at(&cwd, &grant_id, paths)
    })
    .await
}

#[cfg(test)]
fn git_discard_files_inner(state: &AppState, grant_id: &str, paths: Vec<String>) -> Result<GitSnapshot, String> {
    let cwd = grant_root(state, grant_id)?;
    git_discard_files_at(&cwd, grant_id, paths)
}

fn git_discard_files_at(cwd: &Path, grant_id: &str, paths: Vec<String>) -> Result<GitSnapshot, String> {
    let cwd = cwd.to_path_buf();
    if paths.is_empty() || paths.len() > DISCARD_PATH_LIMIT {
        return Err("Choose between 1 and 200 files to discard.".into());
    }
    let mut confined = Vec::with_capacity(paths.len());
    for raw in &paths {
        confined.push(discard_path(&cwd, raw)?);
    }
    // Literal pathspecs: a file literally named `*.txt` must not glob-match
    // its siblings. (Leading `-` names are already stopped by `--`.)
    let literal = |path: &str| format!(":(literal){path}");
    let scoped: Vec<String> = confined.iter().map(|path| literal(path)).collect();
    let mut status_args = vec!["status", "--porcelain", "-z", "--"];
    status_args.extend(scoped.iter().map(String::as_str));
    let porcelain = run_git(&cwd, &status_args)?;
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    let mut added_no_head = Vec::new();
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    // Porcelain reports repo-root-relative paths even when scoped by literal
    // pathspecs; re-root them like the snapshot does so a nested grant's files
    // still match the cwd-relative paths the renderer asked for.
    let prefix = run_git(&cwd, &["rev-parse", "--show-prefix"]).unwrap_or_default().trim_end().to_string();
    for (file_path, status) in parse_porcelain_z(&porcelain) {
        let Some(relative) = file_path.strip_prefix(prefix.as_str()).filter(|path| !path.is_empty()).map(str::to_string) else {
            continue;
        };
        if !confined.contains(&relative) {
            continue;
        }
        if status == "??" {
            untracked.push(relative);
        } else if !has_head && status.starts_with('A') {
            // Unborn HEAD: staged-new files have no HEAD version to restore.
            added_no_head.push(relative);
        } else {
            tracked.push(relative);
        }
    }
    if !tracked.is_empty() {
        let mut restore_args = if has_head {
            vec!["restore", "--staged", "--worktree", "--"]
        } else {
            vec!["restore", "--worktree", "--"]
        };
        let scoped: Vec<String> = tracked.iter().map(|path| literal(path)).collect();
        restore_args.extend(scoped.iter().map(String::as_str));
        run_git(&cwd, &restore_args)?;
    }
    for file_path in &added_no_head {
        let scoped = literal(file_path);
        run_git(&cwd, &["rm", "--cached", "-q", "--", scoped.as_str()])?;
        let target = cwd.join(file_path);
        if target.symlink_metadata().is_ok_and(|meta| meta.is_file()) {
            std::fs::remove_file(&target).map_err(|err| format!("Could not discard {file_path}: {err}"))?;
        }
    }
    if !untracked.is_empty() {
        let mut clean_args = vec!["clean", "-fd", "--"];
        let scoped: Vec<String> = untracked.iter().map(|path| literal(path)).collect();
        clean_args.extend(scoped.iter().map(String::as_str));
        run_git(&cwd, &clean_args)?;
    }
    native_log("info", "git.discard", &format!("git discard: {} file(s) in grant {}", tracked.len() + untracked.len() + added_no_head.len(), grant_tag(grant_id)));
    git_snapshot_for(&cwd)
}

/// Discard every uncommitted change in the granted repo (tracked restores,
/// untracked removals, ignored files preserved). The UI confirms before
/// invoking; this command performs no further prompting.
#[tauri::command]
async fn git_discard_all(state: State<'_, AppState>, grant_id: String) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _write = git_write_lock();
        git_discard_all_at(&cwd, &grant_id)
    })
    .await
}

#[cfg(test)]
fn git_discard_all_inner(state: &AppState, grant_id: &str) -> Result<GitSnapshot, String> {
    let cwd = grant_root(state, grant_id)?;
    git_discard_all_at(&cwd, grant_id)
}

fn git_discard_all_at(cwd: &Path, grant_id: &str) -> Result<GitSnapshot, String> {
    let cwd = cwd.to_path_buf();
    let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
    if has_head {
        run_git(&cwd, &["restore", "--staged", "--worktree", "--", "."])?;
    } else {
        // Unborn HEAD: empty the index so staged-new files become untracked,
        // then clean removes them with the rest. Ignored files survive.
        run_git(&cwd, &["read-tree", "--empty"])?;
    }
    run_git(&cwd, &["clean", "-fd", "--", "."])?;
    native_log("info", "git.discard_all", &format!("git discard-all in grant {}", grant_tag(grant_id)));
    git_snapshot_for(&cwd)
}

/// Extract the `hunk`-th `@@` block (0-based, matching the renderer's
/// grouping) plus the file header as a standalone reverse-appliable patch.
/// `\ No newline` trailers stay with their hunk; a missing hunk fails with
/// a refresh hint instead of touching the tree.
fn single_hunk_patch(diff: &str, hunk: u32) -> Result<String, String> {
    let mut header: Vec<&str> = Vec::new();
    let mut hunks: Vec<Vec<&str>> = Vec::new();
    for line in diff.lines() {
        if line.starts_with("@@") {
            hunks.push(vec![line]);
        } else if let Some(last) = hunks.last_mut() {
            last.push(line);
        } else {
            header.push(line);
        }
    }
    let picked = hunks.get(hunk as usize).ok_or_else(|| "That hunk is no longer available. Refresh the diff and retry.".to_string())?;
    let mut patch = header.join("\n");
    patch.push('\n');
    patch.push_str(&picked.join("\n"));
    patch.push('\n');
    Ok(patch)
}

/// Discard one hunk of a tracked file, as that hunk appears in the dock's
/// `diff HEAD` view. Staging of the same file is preserved where git allows
/// it: the hunk is removed from the worktree and — when the index can take
/// the patch — from the index too. Partial staging the index patch cannot
/// represent falls back to a full reset, never leaving a discarded hunk
/// staged. Returns a fresh snapshot.
#[tauri::command]
async fn git_discard_hunk(state: State<'_, AppState>, grant_id: String, path: String, hunk: u32) -> Result<GitSnapshot, String> {
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _write = git_write_lock();
        let rel = discard_path(&cwd, &path)?;
        let scoped = format!(":(literal){rel}");
        let has_head = run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok();
        let staged = if has_head {
            run_git(&cwd, &["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--", scoped.as_str()])?
        } else {
            String::new()
        };
        if staged.trim().is_empty() {
            // Nothing staged: the index equals HEAD, so the reset is a no-op
            // and the plain worktree diff matches the dock's view.
            if has_head {
                run_git(&cwd, &["reset", "-q", "HEAD", "--", scoped.as_str()])?;
            }
            let diff = run_git(&cwd, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--", scoped.as_str()])?;
            let patch = single_hunk_patch(&diff, hunk)?;
            run_git_stdin(&cwd, &["apply", "-R", "--unidiff-zero", "--"], &patch)?;
        } else {
            // Staged content exists: derive the hunk from the combined
            // `diff HEAD` view without resetting the file, so other staged
            // hunks of the same file keep their staging.
            let diff = run_git(&cwd, &["diff", "HEAD", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--", scoped.as_str()])?;
            let patch = single_hunk_patch(&diff, hunk)?;
            run_git_stdin(&cwd, &["apply", "-R", "--unidiff-zero", "--"], &patch)?;
            if run_git_stdin(&cwd, &["apply", "-R", "--unidiff-zero", "--cached", "--"], &patch).is_err() {
                // Partial staging left the index between HEAD and the
                // worktree: reset the file rather than risk committing the
                // hunk the user just discarded.
                run_git(&cwd, &["reset", "-q", "HEAD", "--", scoped.as_str()])?;
            }
        }
        native_log("info", "git.discard_hunk", &format!("git discard-hunk {rel}#{hunk} in grant {}", grant_tag(&grant_id)));
        git_snapshot_for(&cwd)
    })
    .await
}

/// Stage or unstage paths. Unstaging on an unborn HEAD removes the paths
/// from the empty-tree index instead of resetting to a missing commit.
#[tauri::command]
async fn git_stage(state: State<'_, AppState>, grant_id: String, paths: Vec<String>, stage: bool) -> Result<GitSnapshot, String> {
    if paths.is_empty() {
        return Err("Pick at least one file.".into());
    }
    if paths.len() > DISCARD_PATH_LIMIT {
        return Err(format!("Pick at most {DISCARD_PATH_LIMIT} files at a time."));
    }
    let cwd = grant_root(&state, &grant_id)?;
    blocking(move || {
        let _write = git_write_lock();
        git_stage_at(&cwd, &grant_id, paths, stage)
    })
    .await
}

fn git_stage_at(cwd: &Path, grant_id: &str, paths: Vec<String>, stage: bool) -> Result<GitSnapshot, String> {
    let cwd = cwd.to_path_buf();
    let scoped: Vec<String> = paths.iter().map(|path| discard_path(&cwd, path).map(|rel| format!(":(literal){rel}"))).collect::<Result<_, _>>()?;
    let refs: Vec<&str> = scoped.iter().map(String::as_str).collect();
    if stage {
        let mut args = vec!["add", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    } else if run_git(&cwd, &["rev-parse", "--verify", "HEAD"]).is_ok() {
        let mut args = vec!["reset", "-q", "HEAD", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    } else {
        let mut args = vec!["rm", "--cached", "-q", "--"];
        args.extend(refs);
        run_git(&cwd, &args)?;
    }
    native_log(
        "info",
        if stage { "git.stage" } else { "git.unstage" },
        &format!("git {} in grant {}", if stage { "stage" } else { "unstage" }, grant_tag(grant_id)),
    );
    git_snapshot_for(&cwd)
}

/// Commit staged changes with a message. Identity/hook failures surface
/// verbatim so the user can fix git config or hooks and retry.
#[tauri::command]
async fn git_commit(state: State<'_, AppState>, grant_id: String, message: String) -> Result<GitSnapshot, String> {
    let trimmed = message.trim().to_string();
    if trimmed.is_empty() {
        return Err("Write a commit message first.".into());
    }
    if trimmed.len() > 2000 {
        return Err("Commit messages are limited to 2000 characters.".into());
    }
    let cwd = grant_root(&state, &grant_id)?;
    // Commit hooks can run for a long time; they must not run on the UI thread.
    blocking(move || {
        let _write = git_write_lock();
        run_git(&cwd, &["commit", "-m", trimmed.as_str()])?;
        native_log("info", "git.commit", &format!("git commit in grant {}", grant_tag(&grant_id)));
        git_snapshot_for(&cwd)
    })
    .await
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustSkill {
    name: String,
    description: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustRules {
    path: String,
    excerpt: String,
    truncated: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrustPreview {
    skills: Vec<TrustSkill>,
    rules: Option<TrustRules>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnterpriseSource {
    plane: String,
    source_class: String,
    state: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EnterpriseStatus {
    generation: Option<String>,
    sources: Vec<EnterpriseSource>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillDetail {
    id: String,
    name: String,
    description: String,
    scope: String,
    activation: String,
    path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillEntry {
    id: String,
    name: String,
    description: String,
    scope: String,
    activation: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginEntry {
    id: String,
    version: Option<String>,
    description: String,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginCapability {
    id: String,
    kind: Option<String>,
    description: String,
    enabled: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PluginDetail {
    id: String,
    version: Option<String>,
    description: String,
    capabilities: Vec<PluginCapability>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FolderGrant {
    path: String,
    grant_id: String,
    /// None when the grant reached the keyring. Some(reason) when it only
    /// exists in memory, so the renderer can say the access dies on restart
    /// instead of the folder silently going ungranted at next launch.
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

/// Grant-minting core shared by the picker and tests: dedupe by canonical
/// root, mint an id, and persist — a keyring failure becomes a warning, never
/// a failed grant.
fn mint_grant(state: &AppState, canon: PathBuf) -> Result<FolderGrant, String> {
    // One guard across the lookup and the insert. Two concurrent pickers for
    // the same folder used to each see "not present" and mint a distinct id,
    // and the second keyring write dropped the first, leaving an id that
    // silently dies at the next launch.
    let (id, failed) = {
        let mut grants = state.grants.lock().map_err(|err| err.to_string())?;
        if let Some(id) = grants.iter().find(|(_, root)| *root == &canon).map(|(id, _)| id.clone()) {
            return Ok(FolderGrant {
                path: canon.to_string_lossy().into_owned(),
                grant_id: id,
                warning: None,
            });
        }
        let id = mint_grant_id();
        let failed = {
            grants.insert(id.clone(), canon.clone());
            persist_grants(&grants)
        };
        (id, failed)
    };
    let warning = failed.map(|err| format!("{err} This folder works until you quit, then it has to be opened again."));
    Ok(FolderGrant {
        path: canon.to_string_lossy().into_owned(),
        grant_id: id,
        warning,
    })
}

/// The ONLY way to grant a folder the user names: a successful native folder
/// selection. (`git_worktree_create` derives grants for worktrees it creates.) Re-picking a granted root returns its existing id.
#[tauri::command]
async fn pick_folder(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<FolderGrant>, String> {
    // The dialog waits on the user and minting a grant writes the keyring —
    // keep both off the shared async workers.
    blocking(move || {
        let folder = app.dialog().file().set_parent(&window).set_title("Open a workspace").blocking_pick_folder();
        let Some(path) = folder.and_then(|path| path.into_path().ok()) else {
            return Ok(None);
        };
        let canon = path.canonicalize().map_err(|err| format!("That folder cannot be opened: {err}"))?;
        let state = app.state::<AppState>();
        Ok(Some(mint_grant(&state, canon)?))
    })
    .await
}

#[derive(Debug, Deserialize)]
struct GrantCheck {
    id: String,
    path: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GrantVerdict {
    id: String,
    ok: bool,
    /// Canonical root, returned only for ids the caller already holds — lets
    /// the renderer heal a stale non-canonical path without a grant listing.
    path: Option<String>,
}

/// Verify-only reconciliation: the renderer submits the (id, path) pairs it
/// holds and learns which are live. There is deliberately no grant listing —
/// enumerating every id+path would hand any renderer script all capabilities.
#[tauri::command]
async fn verify_grants(app: AppHandle, entries: Vec<GrantCheck>) -> Result<Vec<GrantVerdict>, String> {
    // Canonicalizing up to 256 roots is disk I/O; it must not sit on the
    // main thread (the window's event loop).
    blocking(move || {
        let state = app.state::<AppState>();
        // Snapshot under the lock, then canonicalize outside it: holding it
        // across up to 256 syscalls contends with grant minting and CLI
        // resolution, so a loop of verifications stalled both.
        let grants = state.grants.lock().map_err(|err| err.to_string())?.clone();
        Ok(entries
            .into_iter()
            .take(256)
            .map(|entry| {
                // Compare canonically: a stale-but-same-directory path still verifies,
                // and the returned canonical root lets the renderer heal its string.
                let canon = PathBuf::from(&entry.path).canonicalize().ok();
                let root = grants.get(&entry.id);
                let ok = match (root, canon) {
                    (Some(root), Some(canon)) => &canon == root,
                    _ => false,
                };
                GrantVerdict {
                    id: entry.id,
                    ok,
                    path: if ok {
                        root.map(|root| root.to_string_lossy().into_owned())
                    } else {
                        None
                    },
                }
            })
            .collect())
    })
    .await
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentIdentity {
    agent_id: String,
    name: String,
    /// Canonical binary on disk, if installed.
    path: Option<String>,
    version: Option<String>,
    /// Whether an identity pin exists for this agent.
    pinned: bool,
    /// Pinned, but the binary on disk drifted (path or bytes changed).
    changed: bool,
}

fn agent_identity(state: &AppState, spec: &exec::AgentSpec) -> AgentIdentity {
    let resolved = exec::resolve_agent_bin(spec).ok();
    let digest = resolved.as_deref().and_then(|path| exec::digest_of(path).ok());
    let pinned = state.agent_pins.get(spec.id);
    let unchanged = match (&pinned, &resolved, &digest) {
        (Some(pin), Some(path), Some(digest)) => pin.path == path.to_string_lossy() && pin.sha256 == *digest,
        _ => false,
    };
    AgentIdentity {
        agent_id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: resolved.map(|path| path.to_string_lossy().into_owned()),
        version: if unchanged { pinned.as_ref().and_then(|pin| pin.version.clone()) } else { None },
        pinned: pinned.is_some(),
        changed: pinned.is_some() && !unchanged,
    }
}

/// Display-only agent identities for Settings: canonical path, version, and
/// pin/drift state. Resolves without recording — first sighting pins when the
/// agent is actually used. Hashing can take real time on a cold disk, so this
/// runs on the blocking pool rather than the UI thread.
#[tauri::command]
async fn agent_identities(app: AppHandle) -> Result<Vec<AgentIdentity>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        Ok(exec::AGENTS.iter().filter(|spec| spec.id != "muse").map(|spec| agent_identity(&state, spec)).collect())
    })
    .await
}

/// Confirm a drifted (or new) agent binary after the user reviewed its path.
/// The binary is resolved fresh from disk — the renderer confirms, never
/// nominates — then pinned and returned for display.
#[tauri::command]
async fn confirm_agent_bin(app: AppHandle, agent_id: String) -> Result<AgentIdentity, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        if !credentials::acp_consent_value().unwrap_or(false) {
            return Err("Third-party agents run without an OS sandbox. Confirm that in Settings → Agents before using them.".into());
        }
        let spec = exec::agent_spec(&agent_id).filter(|spec| spec.id != "muse").ok_or("Unknown agent.")?;
        let canonical = exec::resolve_agent_bin(spec)?;
        state.exec_pins.check(&canonical, &format!("The {} CLI", spec.name))?;
        state.agent_pins.confirm(&agent_id, &canonical, None)?;
        persist_agent_pins(&state);
        let version = exec::probe_version_cached(&canonical);
        if state.agent_pins.refresh_version(&agent_id, &canonical, version)? {
            persist_agent_pins(&state);
        }
        Ok(agent_identity(&state, spec))
    })
    .await
}

/// Run blocking native work (subprocesses, hashing, big file reads, keyring
/// I/O) on the blocking pool. A plain `#[tauri::command] fn` executes on the
/// main thread, which is also the window's event loop: anything slow in there
/// freezes dragging, resizing, menus and event delivery for its duration.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|err| format!("A background task failed: {err}"))?
}

/// Take a grant out of the table together with the worktree grants derived
/// from it, and return every revoked id. A worktree with nothing uncommitted is
/// removed from disk; one that still holds changes is left in place for the
/// user to recover with git, since nothing here asked to discard them.
fn revoke_grant(state: &AppState, stores: &[PathBuf], grant_id: &str) -> Result<Vec<String>, String> {
    let mut grants = state.grants.lock().map_err(|err| err.to_string())?;
    let mut revoked = vec![grant_id.to_string()];
    if let Some(root) = grants.get(grant_id).cloned() {
        if !stores.iter().any(|store| root.starts_with(store)) {
            for store in stores {
                for (id, dir) in derived_grants(&grants, store, &root) {
                    let _ = worktrees::remove(Some(&root).filter(|root| root.exists()).map(PathBuf::as_path), &dir, false);
                    grants.remove(&id);
                    revoked.push(id);
                }
            }
        }
    }
    grants.remove(grant_id);
    let _ = persist_grants(&grants);
    Ok(revoked)
}

/// Revoke a grant and drop every session and approval bound to it.
#[tauri::command]
async fn remove_grant(app: AppHandle, grant_id: String) -> Result<(), String> {
    // The keyring rewrite is I/O; keep it off the main thread.
    blocking(move || {
        let state = app.state::<AppState>();
        if !valid_grant_id(&grant_id) {
            return Err("Unknown workspace grant.".into());
        }
        // A revocation waits for native writes already authorized by this
        // grant; queued restores must resolve their owner again afterwards.
        let _write = git_write_lock();
        native_log("info", "grant.revoked", &format!("workspace grant revoked: {}", grant_tag(&grant_id)));
        let legacy = legacy_worktree_store(&app);
        let stores: Vec<PathBuf> = worktree_store(&app).ok().into_iter().chain(legacy.clone()).collect();
        let browser_roots: Vec<(String, PathBuf)> = state.grants.lock().map_err(|err| err.to_string())?.iter().map(|(id, root)| (id.clone(), root.clone())).collect();
        let revoked = revoke_grant(&state, &stores, &grant_id)?;
        if let Some(legacy) = &legacy {
            legacy::prune_worktree_store(legacy);
        }
        for id in &revoked {
            drop_grant_bindings(&state, id);
        }
        // A shell left running in a folder the app no longer has access to would outlive the grant.
        if let Ok(mut terminals) = state.terminals.lock() {
            terminals.close_grants(&revoked);
        }
        // Native-originated close needs no revoked grant. Do not spawn a new
        // bridge just for cleanup, and never leave that workspace's page alive.
        let bridge_alive = state.bridge.lock().ok().is_some_and(|bridge| bridge.is_some());
        if bridge_alive {
            for (_, root) in browser_roots.into_iter().filter(|(id, _)| revoked.contains(id)) {
                let _ = send_bridge_request(&state, &app, &format!("browser-revoke-{}", uuid::Uuid::new_v4().simple()), "browserClose", json!({ "workspaceRoot": root }));
            }
        }
        Ok(())
    })
    .await
}

/// Deletes a temporary export when the conversion finishes or fails.
struct ExportTemp(PathBuf);

impl Drop for ExportTemp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn export_file_name(title: &str, extension: &str) -> String {
    let stem: String = title
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    format!(
        "{}.{}",
        if stem.is_empty() {
            "muse-session"
        } else {
            &stem
        },
        extension
    )
}

/// Export uses Muse's canonical offline exporter. The destination comes from a
/// native save dialog inside this command, so the renderer never receives a
/// generic write-to-path primitive.
#[tauri::command]
async fn export_session(app: AppHandle, window: tauri::WebviewWindow, session_id: String, title: String, muse_bin: String, redacted: bool, markdown: bool) -> Result<Option<String>, String> {
    // The save dialog waits on the user and `muse export` is a bounded
    // subprocess, so the whole call runs on the blocking pool.
    blocking(move || {
        let state = app.state::<AppState>();
        if !valid_session_id(&session_id) {
            return Err("The session identifier is not valid for export.".into());
        }
        // Only sessions bound to a live grant may be exported: the id alone must
        // not reach into workspaces the user never opened (or already removed).
        require_session(&state, &session_id)?;
        let (dialog_title, extension, filter_name, filters): (&str, &str, &str, &[&str]) = if markdown {
            (
                if redacted {
                    "Export share-safe Markdown"
                } else {
                    "Export raw Markdown"
                },
                "md",
                "Markdown",
                &["md"],
            )
        } else {
            (
                if redacted {
                    "Export share-safe Muse session"
                } else {
                    "Export raw Muse session"
                },
                "json",
                "Muse session export",
                &["json"],
            )
        };
        let selected = app.dialog().file().set_parent(&window).set_title(dialog_title).set_file_name(export_file_name(&title, extension)).add_filter(filter_name, filters).blocking_save_file();
        let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
            return Ok(None);
        };
        export_to_path(&state, &session_id, &path.to_string_lossy(), &muse_bin, &title, redacted, markdown).map(Some)
    })
    .await
}

/// The post-dialog half of `export_session`: session-binding gate, canonical
/// pinned binary, then `muse export`. Markdown is rendered from that document
/// and the JSON is removed. Separated so tests exercise it without a save dialog.
fn export_to_path(state: &AppState, session_id: &str, out: &str, muse_bin: &str, title: &str, redacted: bool, markdown: bool) -> Result<String, String> {
    if !valid_session_id(session_id) {
        return Err("The session identifier is not valid for export.".into());
    }
    // Only sessions bound to a live grant may be exported: the id alone must
    // not reach into workspaces the user never opened (or already removed).
    require_session(state, session_id)?;
    let bin = resolve_muse_bin(state, muse_bin)?;
    let temp = markdown.then(|| {
        let path = std::env::temp_dir().join(format!("muse-export-{}.json", uuid::Uuid::new_v4()));
        ExportTemp(path)
    });
    let export_out = temp.as_ref().map(|item| item.0.to_string_lossy().into_owned()).unwrap_or_else(|| out.to_string());
    let mut args = vec!["export", "--session", session_id, "--out", export_out.as_str()];
    if redacted {
        args.push("--redacted");
    }
    // Bounded like every other CLI call: a wedged export must not pin a
    // worker thread forever. Exports of very large sessions still fit.
    let output = run_cli(&bin, &args, None, Duration::from_secs(300))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        let detail = detail.lines().next().unwrap_or("Muse export failed").trim();
        return Err(format!("Muse could not export this session: {detail}"));
    }
    if markdown {
        let path = temp.as_ref().map(|item| item.0.as_path()).ok_or("The Markdown export lost its temporary file.")?;
        let len = std::fs::metadata(path).map_err(|err| format!("Muse export did not produce a file: {err}"))?.len();
        if len > export_markdown::EXPORT_JSON_CAP {
            return Err("This session export is too large to turn into Markdown (over 64 MiB). Export JSON instead.".into());
        }
        let bytes = std::fs::read(path).map_err(|err| format!("Muse export could not be read: {err}"))?;
        // The parser's own error can quote the document, so the user sees a fixed line.
        let doc: Value = serde_json::from_slice(&bytes).map_err(|_| "Muse export was not valid JSON, so it could not be turned into Markdown.".to_string())?;
        let transcript = export_markdown::render_session_markdown(&doc, title)?;
        // Direct write: the bytes are already complete, so there is nothing to stage.
        std::fs::write(out, transcript.as_bytes()).map_err(|err| format!("Could not write the transcript: {err}"))?;
    }
    Ok(out.to_string())
}

/// Full tool output the viewer offers to save: large enough for several
/// `item/readOutput` pages, small enough to keep one dialog write sane.
const OUTPUT_SAVE_LIMIT: usize = 32 * 1024 * 1024;

fn read_rules_preview(root: &Path) -> Option<TrustRules> {
    let root = root.canonicalize().ok()?;
    let path = root.join("AGENTS.md").canonicalize().ok()?;
    if !path.starts_with(&root) || !path.is_file() {
        return None;
    }
    // Only the first 64 KiB is ever shown, so never read past it: an AGENTS.md
    // that is simply enormous would otherwise allocate without bound.
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    let mut reader = std::io::Read::take(file, RULES_PREVIEW_LIMIT);
    let read = std::io::Read::read_to_end(&mut reader, &mut bytes).ok()?;
    if read == 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes);
    let excerpt: String = text.chars().take(2000).collect();
    let truncated = text.len() > excerpt.len() || read == RULES_PREVIEW_LIMIT as usize;
    Some(TrustRules {
        path: "AGENTS.md".into(),
        excerpt,
        truncated,
    })
}

/// Trusted-content preview for the workspace trust decision: the workspace
/// skills the host would load plus the workspace rules file. Grant-gated
/// and read-only; both halves are best-effort (an unreadable side yields
/// an empty list, never a half-invented one).
#[tauri::command]
async fn trust_preview(app: AppHandle, grant_id: String, muse_bin: String) -> Result<TrustPreview, String> {
    // `skills list` is a bounded subprocess and the rules file is disk I/O;
    // keep both off the async workers.
    blocking(move || {
        let state = app.state::<AppState>();
        let root = grant_root(&state, &grant_id)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let root_dir = root.to_string_lossy().into_owned();
        let listed = run_cli(&bin, &["skills", "list", "--source", "project", "--workspace", root_dir.as_str(), "--trust-workspace", "--json"], None, std::time::Duration::from_secs(60))?;
        if !listed.status.success() {
            let detail = String::from_utf8_lossy(&listed.stderr);
            let detail = detail.lines().next().unwrap_or("skill listing failed").trim();
            return Err(format!("Muse could not list project skills: {detail}"));
        }
        let stdout = String::from_utf8_lossy(&listed.stdout);
        let skills = parse_skill_list(&stdout);
        let rules = read_rules_preview(&root);
        Ok(TrustPreview {
            skills,
            rules,
        })
    })
    .await
}

/// Validate a CLI-side identifier the renderer nominates (MCP server name,
/// skill id, plugin id): plain keys, never flags or paths.
fn check_cli_name(field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 200 || value.starts_with('-') || value.contains(|ch: char| ch.is_whitespace() || ch == '/' || ch == '\\') {
        return Err(format!("That {field} is not valid."));
    }
    Ok(())
}

/// Run a Muse CLI command to completion, bounding its wait. OAuth logins
/// wait on the user's browser, so callers pick the ceiling. A command that
/// outlives its ceiling is killed (whole tree) instead of leaking a live
/// pinned `muse` with held pipes.
fn run_cli(bin: &Path, args: &[&str], cwd: Option<&Path>, timeout: std::time::Duration) -> Result<std::process::Output, String> {
    let mut cmd = command(bin);
    process::apply_minimal_env(&mut cmd);
    cmd.env("PATH", augmented_path());
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    run_bounded(cmd, "Muse", timeout)
}

/// Spawn a prepared command, wait at most `timeout`, and kill its whole tree
/// if it overruns. `what` names the program in the error.
fn run_bounded(mut cmd: Command, what: &str, timeout: std::time::Duration) -> Result<std::process::Output, String> {
    #[cfg(unix)]
    {
        // Own a process group so a timeout can end the whole tree, not just
        // the launcher the program spawned.
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|err| format!("Could not start {what}: {err}"))?;
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(timeout) {
        Ok(output) => output.map_err(|err| format!("{what} failed: {err}")),
        Err(_) => {
            process::kill_tree_with_grace(pid, Duration::from_millis(800));
            let _ = rx.recv_timeout(Duration::from_secs(2));
            Err(format!("{what} took too long. Try again."))
        }
    }
}

fn cli_failure(what: &str, output: &std::process::Output) -> String {
    let detail = String::from_utf8_lossy(&output.stderr);
    let detail = detail.lines().next().unwrap_or(what).trim();
    format!("{what}: {}", redact_log_detail(detail))
}

/// Authorize an MCP server with OAuth: the CLI opens the browser and serves
/// the loopback callback itself; the desktop waits for it to finish.
#[tauri::command]
async fn mcp_login(app: AppHandle, server: String, muse_bin: String) -> Result<(), String> {
    // OAuth can wait on the user's browser for minutes; run the subprocess
    // wait on the blocking pool, not a shared async worker.
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("server name", &server)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["mcp", "login", server.as_str()], None, std::time::Duration::from_secs(900))?;
        if !output.status.success() {
            return Err(cli_failure("MCP sign-in failed", &output));
        }
        Ok(())
    })
    .await
}

/// Drop an MCP server's OAuth credential.
#[tauri::command]
async fn mcp_logout(app: AppHandle, server: String, muse_bin: String) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("server name", &server)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["mcp", "logout", server.as_str()], None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("MCP sign-out failed", &output));
        }
        Ok(())
    })
    .await
}

/// Remove the saved Meta credential (API key or account login).
#[tauri::command]
async fn cli_logout(app: AppHandle, muse_bin: String) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["logout"], None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Sign-out failed", &output));
        }
        Ok(())
    })
    .await
}

/// Scaffold agent config (`AGENTS.md`) in a granted workspace. Dry runs
/// return the would-be file text for preview instead of writing.
#[tauri::command]
async fn project_init(app: AppHandle, grant_id: String, muse_bin: String, dry_run: bool, force: bool) -> Result<String, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let root = grant_root(&state, &grant_id)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let mut args = vec!["init"];
        if dry_run {
            args.push("--dry-run");
        }
        if force {
            args.push("--force");
        }
        let output = run_cli(&bin, &args, Some(root.as_path()), std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Project setup failed", &output));
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        Ok(stdout.chars().take(8000).collect())
    })
    .await
}

/// Read enterprise configuration status: the policy generation plus each
/// plane's source and state, so managed locks are visible, not silent.
#[tauri::command]
async fn enterprise_status(app: AppHandle, muse_bin: String) -> Result<EnterpriseStatus, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["config", "status"], None, std::time::Duration::from_secs(30))?;
        if !output.status.success() {
            return Err(cli_failure("Could not read enterprise configuration", &output));
        }
        Ok(parse_enterprise_status(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
}

/// List CLI skills for lifecycle management: the global inventory plus the
/// open workspace's project skills when a grant is given. Listing never
/// loads skill bodies, so no trust flag is needed.
#[tauri::command]
async fn skill_list(app: AppHandle, muse_bin: String, grant_id: String) -> Result<Vec<SkillEntry>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["skills", "list", "--json"], None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Could not list skills", &output));
        }
        let mut entries = parse_skill_inventory(&String::from_utf8_lossy(&output.stdout));
        if !grant_id.is_empty() {
            let root = grant_root(&state, &grant_id)?;
            let scoped = run_cli(&bin, &["skills", "list", "--source", "project", "--workspace", root.to_string_lossy().as_ref(), "--json"], None, std::time::Duration::from_secs(60))?;
            if !scoped.status.success() {
                return Err(cli_failure("Could not list project skills", &scoped));
            }
            for entry in parse_skill_inventory(&String::from_utf8_lossy(&scoped.stdout)) {
                if !entries.iter().any(|known| known.id == entry.id) {
                    entries.push(entry);
                }
            }
        }
        Ok(entries)
    })
    .await
}

/// Install a skill bundle from a folder (`skills install --scope user`).
/// Naming and force-overwrite stay CLI-side; CLI errors surface verbatim.
#[tauri::command]
async fn skill_install(app: AppHandle, muse_bin: String, path: String) -> Result<String, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        if !PathBuf::from(&path).is_dir() {
            return Err("Pick the skill's folder to install it.".into());
        }
        let picked = take_picked_install(&state, &path)?;
        // `--` keeps a folder whose name starts with `-` from being read as a flag;
        // options precede `--` so standard CLI parsers still recognize them.
        let output = run_cli(&bin, &["skills", "install", "--scope", "user", "--json", "--", picked.as_str()], None, std::time::Duration::from_secs(120))?;
        if !output.status.success() {
            return Err(cli_failure("Could not install the skill", &output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).chars().take(2000).collect())
    })
    .await
}

/// Import skills from another agent (`skills import --from claude|codex`).
/// Dry runs return the would-be result for preview instead of importing.
#[tauri::command]
async fn skill_import(app: AppHandle, muse_bin: String, from: String, dry_run: bool) -> Result<String, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        if !["claude", "codex"].contains(&from.as_str()) {
            return Err("Import source must be claude or codex.".into());
        }
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let mut args = vec!["skills", "import", "--from", from.as_str(), "--scope", "user"];
        if dry_run {
            args.push("--dry-run");
        }
        args.push("--json");
        let output = run_cli(&bin, &args, None, std::time::Duration::from_secs(120))?;
        if !output.status.success() {
            return Err(cli_failure("Could not import skills", &output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).chars().take(8000).collect())
    })
    .await
}

/// Ask the native folder picker for a skill bundle directory. The choice is
/// recorded natively as a one-time install authorization, so `skill_install`
/// accepts only exactly this folder (see `take_picked_install`).
#[tauri::command]
async fn pick_skill_source(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    // The native folder dialog waits on the user; it must not pin an async
    // worker for the duration.
    blocking(move || {
        let state = app.state::<AppState>();
        let selected = app.dialog().file().set_parent(&window).set_title("Pick a skill folder").blocking_pick_folder();
        let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
            return Ok(None);
        };
        if let Ok(canonical) = path.canonicalize() {
            if let Ok(mut picked) = state.picked_installs.lock() {
                picked.insert(canonical);
            }
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

/// Inspect one skill (`skills inspect`): identity, scope, activation, and
/// the on-disk path, so enable/disable decisions have provenance.
#[tauri::command]
async fn skill_inspect(app: AppHandle, muse_bin: String, skill: String) -> Result<SkillDetail, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("skill", &skill)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["skills", "inspect", skill.as_str(), "--json"], None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Could not inspect the skill", &output));
        }
        Ok(parse_skill_detail(&skill, &String::from_utf8_lossy(&output.stdout)))
    })
    .await
}

/// Uninstall a skill by id (`skills uninstall`). Bundled skills are not
/// offered in the UI; the CLI validates the rest.
#[tauri::command]
async fn skill_uninstall(app: AppHandle, muse_bin: String, skill: String) -> Result<String, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("skill", &skill)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["skills", "uninstall", skill.as_str(), "--json"], None, std::time::Duration::from_secs(120))?;
        if !output.status.success() {
            return Err(cli_failure("Could not uninstall the skill", &output));
        }
        Ok(String::from_utf8_lossy(&output.stdout).chars().take(2000).collect())
    })
    .await
}

/// Enable or disable a skill in one scope. Project scope resolves its root
/// from the grant, like every other workspace operation.
#[tauri::command]
async fn skill_set(app: AppHandle, skill: String, scope: String, enabled: bool, grant_id: String, muse_bin: String) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("skill", &skill)?;
        if !["user", "project", "built-in", "plugin"].contains(&scope.as_str()) {
            return Err("That skill scope is not valid.".into());
        }
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let root = if scope == "project" {
            Some(grant_root(&state, &grant_id)?)
        } else {
            None
        };
        let mut args = vec![
            "skills",
            if enabled {
                "enable"
            } else {
                "disable"
            },
            skill.as_str(),
            "--scope",
            scope.as_str(),
        ];
        let root_dir = root.as_ref().map(|dir| dir.to_string_lossy().into_owned());
        if let Some(dir) = &root_dir {
            args.push("--workspace");
            args.push(dir.as_str());
            args.push("--trust-workspace");
        }
        args.push("--json");
        let output = run_cli(&bin, &args, None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure(
                if enabled {
                    "Could not enable the skill"
                } else {
                    "Could not disable the skill"
                },
                &output,
            ));
        }
        Ok(())
    })
    .await
}

/// List installed plugins (or marketplace-available ones) for management.
#[tauri::command]
async fn plugin_list(app: AppHandle, muse_bin: String, available: bool) -> Result<Vec<PluginEntry>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let mut args = vec!["plugins", "list"];
        if available {
            args.push("--available");
        }
        args.push("--json");
        let output = run_cli(&bin, &args, None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Could not list plugins", &output));
        }
        Ok(parse_plugin_list(&String::from_utf8_lossy(&output.stdout)))
    })
    .await
}

/// Inspect one installed plugin: metadata plus its runtime capabilities.
#[tauri::command]
async fn plugin_inspect(app: AppHandle, muse_bin: String, id: String) -> Result<PluginDetail, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("plugin id", &id)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(&bin, &["plugins", "inspect", id.as_str(), "--json"], None, std::time::Duration::from_secs(60))?;
        if !output.status.success() {
            return Err(cli_failure("Could not inspect the plugin", &output));
        }
        Ok(parse_plugin_detail(&id, &String::from_utf8_lossy(&output.stdout)))
    })
    .await
}

/// Trust review: approve (enable) or reject (disable) a plugin's current
/// runtime capability definitions.
#[tauri::command]
async fn plugin_review(app: AppHandle, muse_bin: String, id: String, approve: bool) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        check_cli_name("plugin id", &id)?;
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let output = run_cli(
            &bin,
            &[
                "plugins",
                if approve {
                    "approve"
                } else {
                    "reject"
                },
                id.as_str(),
                "--json",
            ],
            None,
            std::time::Duration::from_secs(60),
        )?;
        if !output.status.success() {
            return Err(cli_failure(
                if approve {
                    "Could not approve the plugin"
                } else {
                    "Could not reject the plugin"
                },
                &output,
            ));
        }
        Ok(())
    })
    .await
}

/// Install a local plugin bundle from a user-picked directory.
#[tauri::command]
async fn plugin_install(app: AppHandle, muse_bin: String, path: String) -> Result<(), String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let bin = resolve_muse_bin(&state, &muse_bin)?;
        let candidate = PathBuf::from(&path);
        if !candidate.is_dir() {
            return Err("Pick the plugin bundle's folder to install it.".into());
        }
        let picked = take_picked_install(&state, &path)?;
        let output = run_cli(&bin, &["plugins", "install", "--json", "--", picked.as_str()], None, std::time::Duration::from_secs(300))?;
        if !output.status.success() {
            return Err(cli_failure("Could not install the plugin", &output));
        }
        Ok(())
    })
    .await
}

/// The bundled store: popular skills, plugins and MCP servers that install with
/// no network. Skills go under `~/.agents/skills`; servers merge into the
/// workspace's or the home folder's `.glitter/mcp.json`.
#[tauri::command]
async fn catalog_list(state: State<'_, AppState>, grant_id: String) -> Result<catalog::CatalogList, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder.")?;
    let workspace = if grant_id.is_empty() { None } else { Some(grant_root(&state, &grant_id)?) };
    blocking(move || Ok(catalog::list(&home, workspace.as_deref()))).await
}

/// Install one catalog entry. Content comes from the app bundle, never from the
/// renderer; a workspace is required only for workspace-scoped servers.
#[tauri::command]
async fn catalog_install(state: State<'_, AppState>, entry_id: String, grant_id: String) -> Result<catalog::InstallResult, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder.")?;
    let workspace = if grant_id.is_empty() { None } else { Some(grant_root(&state, &grant_id)?) };
    blocking(move || catalog::install(&home, workspace.as_deref(), &entry_id)).await
}

/// Remove the parts of a catalog entry that the store installed. Folders and
/// server entries the user made or changed are reported, never deleted.
#[tauri::command]
async fn catalog_remove(state: State<'_, AppState>, entry_id: String, grant_id: String) -> Result<catalog::RemoveResult, String> {
    let home = dirs::home_dir().ok_or("Could not find your home folder.")?;
    let workspace = if grant_id.is_empty() { None } else { Some(grant_root(&state, &grant_id)?) };
    blocking(move || catalog::remove(&home, workspace.as_deref(), &entry_id)).await
}

/// Ask the native folder picker for a plugin bundle directory. The choice is
/// recorded natively as a one-time install authorization (see
/// `take_picked_install`), so `plugin_install` accepts only this folder.
#[tauri::command]
async fn pick_plugin_bundle(app: AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        let selected = app.dialog().file().set_parent(&window).set_title("Pick a plugin bundle folder").blocking_pick_folder();
        let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
            return Ok(None);
        };
        if let Ok(canonical) = path.canonicalize() {
            if let Ok(mut picked) = state.picked_installs.lock() {
                picked.insert(canonical);
            }
        }
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

/// Parse `muse skills list --json` leniently: the envelope may be
/// `{ skills: [...] }` or a bare array, and entries name themselves with
/// any of several keys. Unknown shapes yield no skills rather than guesses.
fn parse_skill_list(stdout: &str) -> Vec<TrustSkill> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("skills").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let name = ["selector", "displayName", "name", "id"].iter().filter_map(|key| object.get(*key)?.as_str()).next()?.to_string();
            if name.is_empty() {
                return None;
            }
            let description = object.get("description").and_then(Value::as_str).unwrap_or("").chars().take(280).collect();
            Some(TrustSkill {
                name,
                description,
            })
        })
        .take(100)
        .collect()
}

/// Save fetched full output through a native save dialog. The renderer
/// supplies the bytes and a suggested file name; the destination always
/// comes from the dialog, so this is not a write-to-path primitive.
/// `base64` selects binary payloads (non-text media); otherwise `content`
/// is written as UTF-8 text.
#[tauri::command]
async fn save_output_text(app: AppHandle, window: tauri::WebviewWindow, file_name: String, content: String, base64: bool) -> Result<Option<String>, String> {
    // The save dialog waits on the user and the write can be tens of MiB, so
    // the whole call belongs on the blocking pool.
    blocking(move || {
        let bytes = if base64 {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(content.as_bytes()).map_err(|_| "That output is not valid base64.".to_string())?
        } else {
            content.into_bytes()
        };
        if bytes.len() > OUTPUT_SAVE_LIMIT {
            return Err("That output is too large to save (over 32 MiB).".into());
        }
        let stem: String = file_name
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                    ch
                } else {
                    '-'
                }
            })
            .collect::<String>()
            .trim_matches('-')
            .chars()
            .take(80)
            .collect();
        let selected = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Save tool output")
            .set_file_name(if stem.is_empty() {
                "tool-output.txt".to_string()
            } else {
                stem
            })
            .blocking_save_file();
        let Some(path) = selected.and_then(|value| value.into_path().ok()) else {
            return Ok(None);
        };
        std::fs::write(&path, bytes).map_err(|err| format!("Could not save the output: {err}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
}

const DROP_IMAGE_LIMIT: u64 = 10 * 1024 * 1024;
const DROP_FILE_LIMIT: usize = 20;

fn drop_media_type(path: &Path) -> Option<&'static str> {
    match path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.to_ascii_lowercase()).as_deref() {
        Some("png") => Some("image/png"),
        Some("jpg" | "jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("avif") => Some("image/avif"),
        Some("bmp") => Some("image/bmp"),
        Some("ico") => Some("image/x-icon"),
        Some("svg") => Some("image/svg+xml"),
        Some("tif" | "tiff") => Some("image/tiff"),
        Some("heic") => Some("image/heic"),
        Some("heif") => Some("image/heif"),
        _ => None,
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DroppedFile {
    path: String,
    name: String,
    is_dir: bool,
    size: u64,
    media_type: Option<String>,
    base64_data: Option<String>,
    error: Option<String>,
}

/// Inspect files from a native OS drop. Images at or under the client image
/// limit come back with base64 bytes; everything else is metadata only and the
/// UI attaches it as a file reference. Image failures keep their media type so
/// the UI still references them; only missing files (error, no media type,
/// not a dir) are skipped. Drops are user-initiated, so paths may live
/// outside the open workspaces.
#[tauri::command]
fn inspect_dropped_files(paths: Vec<String>) -> Result<Vec<DroppedFile>, String> {
    use base64::Engine;
    let engine = base64::engine::general_purpose::STANDARD;
    let mut out = Vec::new();
    for raw in paths.into_iter().take(DROP_FILE_LIMIT) {
        let path = PathBuf::from(&raw);
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or(&raw).to_string();
        let meta = std::fs::metadata(&path);
        let Ok(meta) = meta else {
            out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size: 0,
                media_type: None,
                base64_data: None,
                error: Some("File no longer exists.".into()),
            });
            continue;
        };
        if meta.is_dir() {
            out.push(DroppedFile {
                path: raw,
                name,
                is_dir: true,
                size: 0,
                media_type: None,
                base64_data: None,
                error: None,
            });
            continue;
        }
        let size = meta.len();
        let media_type = drop_media_type(&path).map(str::to_string);
        if media_type.is_none() {
            out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size,
                media_type: None,
                base64_data: None,
                error: None,
            });
            continue;
        }
        if size == 0 {
            out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size,
                media_type,
                base64_data: None,
                error: Some("Image is empty; attached as a file reference instead.".into()),
            });
            continue;
        }
        if size > DROP_IMAGE_LIMIT {
            out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size,
                media_type,
                base64_data: None,
                error: Some("Image is larger than 10 MB; attached as a file reference instead.".into()),
            });
            continue;
        }
        match std::fs::read(&path) {
            Ok(bytes) => out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size,
                media_type,
                base64_data: Some(engine.encode(bytes)),
                error: None,
            }),
            Err(err) => out.push(DroppedFile {
                path: raw,
                name,
                is_dir: false,
                size,
                media_type,
                base64_data: None,
                error: Some(format!("Could not read file: {err}")),
            }),
        }
    }
    Ok(out)
}

/// Consume a one-time picker authorization for an install path. Mirrors
/// `read_dropped_files`: the path must have been minted by a native picker in
/// this process and is single-use, so a renderer cannot replay or invent one.
fn take_picked_install(state: &State<'_, AppState>, path: &str) -> Result<String, String> {
    let mut picked = state.picked_installs.lock().map_err(|err| err.to_string())?;
    take_picked_install_in(&mut picked, path)
}

fn take_picked_install_in(picked: &mut HashSet<PathBuf>, path: &str) -> Result<String, String> {
    let canonical = PathBuf::from(path).canonicalize().map_err(|_| "That folder is no longer available. Pick it again.".to_string())?;
    if !picked.remove(&canonical) {
        return Err("Installing needs a folder chosen with this app's picker. Pick it again.".into());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

#[tauri::command]
async fn read_dropped_files(state: State<'_, AppState>, paths: Vec<String>) -> Result<Vec<DroppedFile>, String> {
    // The guard lives in its own block: it must be gone before the await below.
    let authorized = {
        let mut grants = state.dropped_paths.lock().map_err(|err| err.to_string())?;
        let mut authorized = Vec::new();
        for raw in paths.into_iter().take(DROP_FILE_LIMIT) {
            let canonical = PathBuf::from(&raw).canonicalize().map_err(|_| "A dropped file is no longer available")?;
            if !grants.remove(&canonical) {
                return Err("File inspection requires a fresh operating-system drop event.".into());
            }
            authorized.push(canonical.to_string_lossy().into_owned());
        }
        authorized
    };
    // Up to twenty images of ten megabytes each are read and base64-encoded here.
    blocking(move || inspect_dropped_files(authorized)).await
}

/// The program for an editor id from Settings. The renderer picks an id from
/// this closed list and never names a program or a path to one. `Ok(None)` is
/// the system's default app.
fn editor_program(editor: Option<&str>) -> Result<Option<&'static str>, String> {
    Ok(match editor.unwrap_or("default") {
        "" | "default" => None,
        "vscode" => Some("Visual Studio Code"),
        "cursor" => Some("Cursor"),
        "zed" => Some("Zed"),
        "idea" => Some("IntelliJ IDEA"),
        _ => return Err("That editor is not one this app can open.".into()),
    })
}

/// Extensions the OS default handler EXECUTES rather than opens as text:
/// macOS bundles, `.command` scripts and Automator/AppleScript files. Only a
/// system-default open is refused: a chosen editor reads the same file as a
/// document, which is safe.
const EXECUTABLE_EXTENSIONS: &[&str] = &["app", "command", "scpt", "workflow", "action"];

fn default_open_would_execute(path: &Path) -> bool {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| EXECUTABLE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
    {
        return true;
    }
    // The extension list misses executable files with no extension: `open`
    // runs a `+x` script or binary by type sniffing. Directories
    // keep their search bits legitimately and only reveal in a file manager,
    // so the bit alone is not enough — the check is files only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if std::fs::metadata(path)
            .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        {
            return true;
        }
    }
    false
}

#[tauri::command]
fn open_path(app: AppHandle, state: State<AppState>, path: String, grant_id: String, editor: Option<String>) -> Result<(), String> {
    let program = editor_program(editor.as_deref())?;
    grant_root(&state, &grant_id)?;
    let Ok(canon) = PathBuf::from(&path).canonicalize() else {
        return Err("That file is no longer available.".into());
    };
    if !path_within_grant(&state, &grant_id, &canon)? {
        return Err("Opening files is limited to the current workspace.".into());
    }
    // With no editor chosen the file goes to LaunchServices, which would run
    // these types — one click on workspace content
    // must not execute it. The canonical name is what the OS handler sees.
    if program.is_none() && default_open_would_execute(&canon) {
        return Err("This file type opens in an executable handler — use a text editor or open it from Finder.".into());
    }
    // Open exactly what was authorized, closing any swap window on the original string.
    app.opener().open_path(canon.to_string_lossy(), program).map_err(|err| match program {
        Some(name) => format!("Could not open the file in {name}. Check that it is installed, or choose another editor in Settings. ({err})"),
        None => err.to_string(),
    })
}

/// Only remote http(s) links may leave the app: no `file:`, custom-scheme,
/// or protocol-relative targets. Matching is case-sensitive on purpose —
/// `HTTP://` is rejected rather than normalized into an allowed URL.
fn url_open_allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

/// Keep PEM body lines out of OS logs as well as the labelled header.
fn redact_stderr_line(line: &str, private_key: &mut bool) -> Option<String> {
    let upper = line.to_ascii_uppercase();
    let begins = upper.contains("-----BEGIN") && upper.contains("PRIVATE KEY-----");
    let ends = upper.contains("-----END") && upper.contains("PRIVATE KEY-----");
    if begins {
        *private_key = true;
    }
    if *private_key {
        if ends {
            *private_key = false;
        }
        return begins.then(|| "[redacted sensitive fields]".into());
    }
    if line.ends_with(" [truncated]") {
        return Some("[diagnostic omitted: size limit]".into());
    }
    Some(redact_log_detail(line))
}

/// Serialized-size bound for an IPC body before any DTO runs. Tauri parses the
/// webview's postMessage body ahead of the invoke handler, so this is the
/// earliest point native code can refuse a bloated request: it bounds the
/// retained tree ahead of `validate_params`, canonical re-serialization, and
/// the bridge write. Raw bodies arrive unparsed, so their bytes cap directly.
/// The largest legitimate payload is `sendTurn` (32 MiB images + 1 MiB text +
/// JSON overhead); 48 MiB leaves headroom under the 64 MiB frame budget.
const IPC_BODY_LIMIT: usize = 48 * 1024 * 1024;
/// Bounds walk work and structural abuse (millions of tiny nodes).
const IPC_NODE_LIMIT: usize = 1_000_000;

fn ipc_body_oversized(body: &tauri::ipc::InvokeBody) -> bool {
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.len() > IPC_BODY_LIMIT,
        tauri::ipc::InvokeBody::Json(value) => json_size_exceeded(value),
    }
}

enum Pending<'a> {
    Values(std::slice::Iter<'a, Value>),
    Entries(serde_json::map::Iter<'a>),
}

/// Depth-bounded walk: the stack holds one iterator per level, so a wide
/// payload cannot turn the walk itself into a second large allocation.
fn json_size_exceeded(root: &Value) -> bool {
    let mut bytes = 0usize;
    let mut nodes = 0usize;
    let mut stack = vec![Pending::Values(std::slice::from_ref(root).iter())];
    while let Some(top) = stack.last_mut() {
        let next = match top {
            Pending::Values(iter) => iter.next(),
            Pending::Entries(iter) => iter.next().map(|(key, value)| {
                bytes += key.len();
                value
            }),
        };
        let Some(value) = next else {
            stack.pop();
            continue;
        };
        nodes += 1;
        bytes += match value {
            Value::String(text) => text.len(),
            Value::Number(number) => number.to_string().len(),
            Value::Array(items) => {
                stack.push(Pending::Values(items.iter()));
                items.len()
            }
            Value::Object(map) => {
                stack.push(Pending::Entries(map.iter()));
                map.len()
            }
            _ => 1,
        };
        if bytes > IPC_BODY_LIMIT || nodes > IPC_NODE_LIMIT {
            return true;
        }
    }
    false
}

fn redact_log_detail(detail: &str) -> String {
    let lowered = detail.to_ascii_lowercase();
    if ["meta_api_key", "api_key", "apikey", "authorization", "password", "token", "bearer ", "basic ", "private key", "private_key", "privatekey", "secret", "cookie", "passwd", "sk-", "ghp_", "github_pat_", "?code=", "&code=", "?sig=", "&sig=", "signature="].iter().any(|marker| lowered.contains(marker))
        || lowered.split_once("://").map(|(_, rest)| rest.split('/').next().unwrap_or("").contains('@')).unwrap_or(false)
        || unlabelled_secret(detail)
    {
        "[redacted sensitive fields]".into()
    } else {
        detail.chars().take(8_000).collect()
    }
}

/// Token characters for unlabelled credential scans (`-`/`_` are valid inside
/// JWT, Slack, GitLab and age formats; `.` joins dotted compounds).
fn credential_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.'
}

/// `body` chars followed by a non-credential boundary: mirrors the trailing
/// `\b` in the JS-side formats so a longer run is not clipped into a match.
fn counted_token(run: &str, prefix: &str, body: &dyn Fn(u8) -> bool, min: usize, max: usize) -> bool {
    let Some(rest) = run.strip_prefix(prefix) else {
        return false;
    };
    let count = rest.bytes().take_while(|b| body(*b)).count();
    if count < min || count > max {
        return false;
    }
    match rest.as_bytes().get(count) {
        None => true,
        Some(&b) => !credential_char(b),
    }
}

/// Dotted compounds tried at every `.` boundary in a run — a leading `\b`
/// lets `SG.`/`eyJ` match mid-run the same way the JS-side patterns do.
fn dotted_secret(parts: &[&str]) -> bool {
    let is_part = |part: &str, min: usize| part.len() >= min && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let exact = |part: &str, n: usize| part.len() == n && is_part(part, n);
    for i in 0..parts.len() {
        // JWT: `eyJ` opens base64 `{"`; three parts, no fixed tail lengths.
        if parts[i].starts_with("eyJ") && is_part(parts[i], 11) && parts.get(i + 1).is_some_and(|p| is_part(p, 8)) && parts.get(i + 2).is_some_and(|p| is_part(p, 8)) {
            return true;
        }
        // SendGrid: `SG.` + 22 + `.` + 43.
        if parts[i] == "SG" && parts.get(i + 1).is_some_and(|p| exact(p, 22)) && parts.get(i + 2).is_some_and(|p| exact(p, 43)) {
            return true;
        }
        // Doppler: `dp.pt.` + 20.
        if parts[i] == "dp" && parts.get(i + 1) == Some(&"pt") && parts.get(i + 2).is_some_and(|p| is_part(p, 20)) {
            return true;
        }
    }
    false
}

/// Credential formats that need no label: fixed prefixes or shapes make a bare
/// occurrence safe to suppress. Pure-hex hashes, UUIDs and fingerprints fall
/// through on purpose — common diagnostic content, not credentials.
fn unlabelled_secret(detail: &str) -> bool {
    let bytes = detail.as_bytes();
    let base64url = |b: u8| b.is_ascii_alphanumeric() || b == b'_' || b == b'-';
    let alnum = |b: u8| b.is_ascii_alphanumeric();
    let upper = |b: u8| b.is_ascii_uppercase() || b.is_ascii_digit();
    let hexd = |b: u8| b.is_ascii_hexdigit();
    let slack = |b: u8| b.is_ascii_alphanumeric() || b == b'-';

    let mut start = 0;
    while start < bytes.len() {
        while start < bytes.len() && !credential_char(bytes[start]) {
            start += 1;
        }
        let mut end = start;
        while end < bytes.len() && credential_char(bytes[end]) {
            end += 1;
        }
        if end > start {
            let run = &detail[start..end];
            let parts: Vec<&str> = run.split('.').collect();
            // Dotted compounds first: a JWT's `eyJ` segment would otherwise be
            // examined alone once the run splits on `.`.
            if parts.len() > 1 && dotted_secret(&parts) {
                return true;
            }
            for &piece in &parts {
                if counted_token(piece, "AKIA", &upper, 16, 16)
                    || counted_token(piece, "ASIA", &upper, 16, 16)
                    || counted_token(piece, "ABIA", &upper, 16, 16)
                    || counted_token(piece, "ACCA", &upper, 16, 16)
                    || counted_token(piece, "npm_", &alnum, 36, 36)
                    || counted_token(piece, "AIza", &base64url, 35, 35)
                    || counted_token(piece, "sk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "rk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "pk_live_", &alnum, 16, usize::MAX)
                    || counted_token(piece, "shpat_", &hexd, 32, 32)
                    || counted_token(piece, "shpca_", &hexd, 32, 32)
                    || counted_token(piece, "shppa_", &hexd, 32, 32)
                    || counted_token(piece, "lin_api_", &alnum, 20, usize::MAX)
                    || counted_token(piece, "glpat-", &base64url, 20, usize::MAX)
                    || counted_token(piece, "pypi-", &base64url, 16, usize::MAX)
                    || counted_token(piece, "AGE-SECRET-KEY-1", &alnum, 20, usize::MAX)
                {
                    return true;
                }
                // Slack: `xox` + one of b/a/p/r/s + `-` + 10+.
                if piece.starts_with("xox") && piece.len() > 14 && matches!(piece.as_bytes().get(3), Some(b'b' | b'a' | b'p' | b'r' | b's')) && piece.as_bytes().get(4) == Some(&b'-') && counted_token(piece, &piece[..5], &slack, 10, usize::MAX) {
                    return true;
                }
                // High-entropy runs the formats above miss: 45+ token chars
                // mixing upper, lower and digit classes. Single-case hex and
                // short ids stay visible.
                if piece.len() >= 45 {
                    let (mut lo, mut up, mut di) = (false, false, false);
                    for &b in piece.as_bytes() {
                        if b.is_ascii_lowercase() {
                            lo = true;
                        } else if b.is_ascii_uppercase() {
                            up = true;
                        } else if b.is_ascii_digit() {
                            di = true;
                        }
                    }
                    if lo && up && di && piece.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
                        return true;
                    }
                }
            }
        }
        start = end.max(start + 1);
    }
    false
}

/// Cap on the persisted settings document. It reuses the IPC body budget so
/// the two guards can never disagree: `ipc_body_oversized` refuses an
/// oversized `persist_store_atomic` body before this command runs, so this
/// check is the backstop that keeps the writer's contract honest — and the
/// one place the cap is stated if the IPC budget ever moves.
const STORE_DOCUMENT_LIMIT: usize = IPC_BODY_LIMIT;

/// The store document path, resolved exactly as `tauri-plugin-store` resolves it
/// (its `store.rs` uses `BaseDirectory::AppData`), so the atomic writer below
/// and the plugin's reader always agree on one file.
fn store_document_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().resolve("glitter.json", BaseDirectory::AppData).map_err(|err| format!("Could not resolve the settings path: {err}"))
}

fn write_fsync(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = std::fs::File::create(path).map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    file.write_all(bytes).map_err(|err| format!("Could not write {}: {err}", path.display()))?;
    file.sync_all().map_err(|err| format!("Could not flush {}: {err}", path.display()))?;
    Ok(())
}

fn store_document_is_valid(path: &Path) -> bool {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()).map(|value| value.is_object()).unwrap_or(false)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreRepair {
    /// `ok` | `restored` | `quarantined` | `empty`.
    status: String,
    restored_from: Option<String>,
    quarantined_to: Option<String>,
}

/// Make the store document safe to read before hydration. A file that will not
/// parse is preserved as `glitter.json.corrupt` rather than overwritten —
/// the next save must never silently replace a damaged file with defaults —
/// and the newest complete fallback is restored in its place.
fn repair_store_files(target: &Path) -> Result<StoreRepair, String> {
    let dir = target.parent().ok_or_else(|| "Invalid settings path.".to_string())?;
    let mut repaired = StoreRepair {
        status: "ok".into(),
        restored_from: None,
        quarantined_to: None,
    };
    if store_document_is_valid(target) {
        return Ok(repaired);
    }
    if target.exists() {
        let quarantine = dir.join("glitter.json.corrupt");
        let _ = std::fs::remove_file(&quarantine);
        if std::fs::rename(target, &quarantine).is_ok() {
            repaired.quarantined_to = Some("glitter.json.corrupt".to_string());
        }
    }
    // A `.tmp` is newer than `.bak` (it is the write that was interrupted), so
    // it wins when both are complete. `write_store_document` gives every call
    // its own temp name, so several interrupted writes can be left behind;
    // try the most recently written complete one first. The plain `.tmp` name
    // is still matched for files written before the suffix existed.
    let mut temps: Vec<(PathBuf, String)> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| {
                    let name = entry.file_name().to_str()?.to_string();
                    (name == "glitter.json.tmp" || name.starts_with("glitter.json.tmp.")).then(|| (entry.path(), name))
                })
                .collect()
        })
        .unwrap_or_default();
    temps.sort_by_key(|(path, _)| std::fs::metadata(path).and_then(|meta| meta.modified()).ok());
    let mut fallbacks: Vec<(PathBuf, String)> = temps.into_iter().rev().collect();
    fallbacks.push((dir.join("glitter.json.bak"), "glitter.json.bak".to_string()));
    for (candidate, label) in fallbacks {
        if !store_document_is_valid(&candidate) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&candidate) else {
            continue;
        };
        if write_fsync(target, &bytes).is_ok() {
            repaired.status = "restored".into();
            repaired.restored_from = Some(label);
            return Ok(repaired);
        }
    }
    repaired.status = if repaired.quarantined_to.is_some() {
        "quarantined".into()
    } else {
        "empty".into()
    };
    Ok(repaired)
}

/// One write-rotate-rename is a critical section: session-memory saves are not
/// queued behind each other, so two `persist_store_atomic` calls can run at the
/// same time. Sharing one temp path let a later call truncate the earlier
/// writer's file mid-write, and interleaved rotations could rename an older
/// document over a newer one.
static STORE_WRITE_LOCK: Mutex<()> = Mutex::new(());
static STORE_TEMP_SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// Does the temp name belong to an interrupted atomic store write? The plain
/// `.tmp` covers files written before the per-call suffix existed.
fn is_store_temp_name(name: &str) -> bool {
    name == "glitter.json.tmp" || name.starts_with("glitter.json.tmp.")
}

fn write_store_document(dir: &Path, json: &str) -> Result<(), String> {
    // The guarded value is `()`, so a poisoned lock holds no broken state.
    let _write = STORE_WRITE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    std::fs::create_dir_all(dir).map_err(|err| format!("Could not create the settings directory: {err}"))?;
    let target = dir.join("glitter.json");
    let backup = dir.join("glitter.json.bak");
    // Unique per call even under the lock: a leftover temp from a killed write
    // can never be mistaken for this one, and repair can tell them apart.
    let tmp = dir.join(format!("glitter.json.tmp.{}.{}", std::process::id(), STORE_TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    write_fsync(&tmp, json.as_bytes())?;
    // Rotate the previous copy aside before replacing, so a crash between the
    // two renames still leaves one complete document for `repair_store_files`.
    if target.exists() {
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::rename(&target, &backup);
    }
    std::fs::rename(&tmp, &target).map_err(|err| format!("Could not save settings: {err}"))?;
    // Leftover temps come only from writes killed mid-flight; sweep them so a
    // crash per save cannot pile up files beside the live document. Only temps
    // old enough that no live writer could still own them go, though — the
    // write lock is process-local, and a second instance's fresh temp is not
    // this one's to delete.
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if !entry.file_name().to_str().is_some_and(is_store_temp_name) {
                continue;
            }
            let stale = entry
                .metadata()
                .ok()
                .and_then(|meta| meta.modified().ok())
                .and_then(|stamp| stamp.elapsed().ok())
                .is_some_and(|age| age > std::time::Duration::from_secs(60));
            if stale {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

/// Persist the settings document atomically: temp file, fsync, rename, keeping
/// the previous good copy as `glitter.json.bak`. `tauri-plugin-store`'s own
/// `save()` is a bare `fs::write`, which a crash can leave truncated.
#[tauri::command]
async fn persist_store_atomic(app: AppHandle, json: String) -> Result<(), String> {
    if json.len() > STORE_DOCUMENT_LIMIT {
        return Err("Settings are too large to save.".into());
    }
    // Parse plus an fsync'd write is disk work; keep it off the main thread.
    blocking(move || {
        let parsed: Value = serde_json::from_str(&json).map_err(|_| "Refusing to save an unparseable settings document.".to_string())?;
        if !parsed.is_object() {
            return Err("Settings document must be a JSON object.".into());
        }
        let target = store_document_path(&app)?;
        let dir = target.parent().ok_or_else(|| "Invalid settings path.".to_string())?;
        write_store_document(dir, &json)
    })
    .await
}

#[tauri::command]
async fn repair_store_document(app: AppHandle) -> Result<StoreRepair, String> {
    blocking(move || repair_store_files(&store_document_path(&app)?)).await
}

fn app_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|err| err.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|err| format!("Could not create log directory: {err}"))?;
    Ok(dir.join("glitter.log"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsSnapshot {
    os: &'static str,
    arch: &'static str,
    log_tail: Vec<String>,
}

fn log_tail(path: &Path, max_lines: usize, window: u64) -> Result<Vec<String>, String> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Could not open app log: {error}")),
    };
    let offset = file.metadata().map_err(|error| format!("Could not read app log metadata: {error}"))?.len().saturating_sub(window);
    file.seek(SeekFrom::Start(offset)).map_err(|error| format!("Could not seek in app log: {error}"))?;
    let mut bytes = Vec::new();
    file.take(window).read_to_end(&mut bytes).map_err(|error| format!("Could not read app log: {error}"))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.split('\n').collect::<Vec<_>>();
    if offset > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    if lines.last().is_some_and(|line| line.is_empty()) {
        let _ = lines.pop();
    }
    let first = lines.len().saturating_sub(max_lines);
    Ok(lines[first..].iter().map(|line| redact_log_detail(line)).collect())
}

fn append_log_line(path: &Path, level: &str, event: &str, detail: &str) -> Result<(), String> {
    let level = match level {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info",
    };
    let event: String = redact_log_detail(event).chars().filter(|ch| !ch.is_control()).take(160).collect();
    // Control characters become spaces so a renderer-supplied detail cannot
    // forge extra TSV columns in the log (8 KiB cap).
    let detail: String = redact_log_detail(detail)
        .chars()
        .map(|ch| {
            if ch.is_control() {
                ' '
            } else {
                ch
            }
        })
        .take(8192)
        .collect();
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|value| value.as_millis()).unwrap_or_default();
    let full_line = format!("{timestamp}\t{level}\t{event}\t{detail}\n");
    // No logging or app callbacks run under this lock; filesystem operations
    // return errors, so the panic hook cannot re-enter it during a write.
    let _guard = log_write_guard();
    rotate_if_large(path, APP_LOG_LIMIT)?;
    let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(|err| format!("Could not open app log: {err}"))?;
    file.write_all(full_line.as_bytes()).map_err(|err| format!("Could not write app log: {err}"))
}

fn native_log(level: &str, event: &str, detail: &str) {
    let level = match level {
        "debug" | "info" | "warn" | "error" => level,
        _ => "info",
    };
    let event: String = redact_log_detail(event).chars().filter(|ch| !ch.is_control()).take(160).collect();
    let detail: String = redact_log_detail(detail)
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(8192)
        .collect();
    eprintln!("[glitter] {level} {event}: {detail}");
    if let Some(path) = APP_LOG_PATH.get() {
        let _ = append_log_line(path, level, &event, &detail);
    }
}

#[tauri::command]
fn append_app_log(app: AppHandle, level: String, event: String, detail: String) -> Result<(), String> {
    let path = app_log_path(&app)?;
    append_log_line(&path, &level, &event, &detail)
}

#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<String, String> {
    let path = app_log_path(&app)?;
    if !path.exists() {
        std::fs::write(&path, "").map_err(|err| format!("Could not create app log: {err}"))?;
    }
    let folder = path.parent().ok_or("Log directory is unavailable")?;
    app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(|err| err.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn harness_session_log_file(base: &Path, session_id: &str) -> Result<PathBuf, String> {
    if !valid_session_id(session_id) || !session_id.starts_with("h-") {
        return Err("That Harness session identifier is not valid.".into());
    }
    Ok(base.join("harness").join("sessions").join(format!("{session_id}.jsonl")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportPaths {
    app_log_path: String,
    session_log_path: Option<String>,
}

/// App-owned paths only. Other agents do not expose a canonical per-session log
/// to Glitter, so the menu offers Copy task path for Harness sessions alone.
#[tauri::command]
fn support_paths(app: AppHandle, session_id: Option<String>, agent_id: Option<String>) -> Result<SupportPaths, String> {
    let session_log_path = match (agent_id.as_deref(), session_id) {
        (Some("harness"), Some(session_id)) => {
            let base = app.path().app_data_dir().map_err(|err| format!("Could not resolve the session log path: {err}"))?;
            let path = harness_session_log_file(&base, &session_id)?;
            path.is_file().then(|| path.to_string_lossy().into_owned())
        }
        _ => None,
    };
    Ok(SupportPaths { app_log_path: app_log_path(&app)?.to_string_lossy().into_owned(), session_log_path })
}

/// The config destination is app-owned, never a renderer-supplied path or editor.
#[tauri::command]
fn open_config_file(app: AppHandle) -> Result<(), String> {
    let path = store_document_path(&app)?;
    if !path.is_file() {
        return Err("The settings file is not available yet. Change a setting, then try again.".into());
    }
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|err| format!("Could not open the settings file: {err}"))
}

#[tauri::command]
async fn diagnostics_snapshot(app: AppHandle) -> Result<DiagnosticsSnapshot, String> {
    blocking(move || {
        let path = app_log_path(&app)?;
        Ok(DiagnosticsSnapshot {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            log_tail: log_tail(&path, 200, 64 * 1024)?,
        })
    })
    .await
}

/// An accelerator the renderer may ask for: the platform modifier, optional
/// Shift and Alt, then one key from a closed set. This is the whole grammar
/// the shortcut table can produce, so anything else is refused before it
/// reaches the menu library.
fn valid_accelerator(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("CmdOrCtrl+") else {
        return false;
    };
    let rest = rest.strip_prefix("Shift+").unwrap_or(rest);
    let key = rest.strip_prefix("Alt+").unwrap_or(rest);
    let function = key.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()).is_some_and(|n| (1..=12).contains(&n));
    function || matches!(key, "Backspace" | "Tab" | "Enter") || (key.len() == 1 && key.chars().all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ",./;'\\[]=-`".contains(ch)))
}

/// Rebuild the application menu with the user's rebound accelerators. Only
/// the ids this app forwards to the renderer can be rebound, and each value
/// must be a plain accelerator; the menu's structure and labels never change.
#[tauri::command]
fn set_menu_shortcuts(app: AppHandle, accelerators: HashMap<String, String>) -> Result<(), String> {
    if accelerators.len() > APP_MENU_IDS.len() || accelerators.iter().any(|(id, value)| !APP_MENU_IDS.contains(&id.as_str()) || !valid_accelerator(value)) {
        return Err("Those shortcuts are not valid for the menu.".into());
    }
    let menu = build_app_menu(&app, &accelerators).map_err(|err| err.to_string())?;
    app.set_menu(menu).map(|_| ()).map_err(|err| err.to_string())
}

/// Open a terminal: the user's shell on a PTY, started in a granted folder.
/// Output arrives as `terminal-output` events (base64, since a chunk can end
/// mid-character) and the end of the shell as `terminal-exit`.
#[tauri::command]
async fn terminal_open(app: AppHandle, grant_id: String, cols: u16, rows: u16) -> Result<String, String> {
    blocking(move || {
        let state = app.state::<AppState>();
        if state.shell_disabled.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("The terminal is off because shell commands are disabled in Settings → Permissions.".into());
        }
        let root = grant_root(&state, &grant_id)?;
        let handle = app.clone();
        let id = state.terminals.lock().map_err(|err| err.to_string())?.open(&grant_id, &root, cols, rows, move |id, event| {
            use base64::Engine;
            match event {
                terminal::Event::Output(bytes) => {
                    let _ = handle.emit("terminal-output", json!({ "id": id, "data": base64::engine::general_purpose::STANDARD.encode(bytes) }));
                }
                terminal::Event::Exit(code) => {
                    if let Ok(mut terminals) = handle.state::<AppState>().terminals.lock() {
                        terminals.forget(id);
                    }
                    let _ = handle.emit("terminal-exit", json!({ "id": id, "code": code }));
                }
            }
        })?;
        native_log("info", "terminal.open", &format!("terminal opened in grant {}", grant_tag(&grant_id)));
        Ok(id)
    })
    .await
}

/// Send keystrokes or a paste to a terminal.
#[tauri::command]
async fn terminal_write(app: AppHandle, id: String, data: String) -> Result<(), String> {
    if !terminal::valid_id(&id) {
        return Err("That terminal has closed.".into());
    }
    if data.len() > terminal::WRITE_LIMIT {
        return Err("That is too much to send to the terminal at once.".into());
    }
    let writer = app.state::<AppState>().terminals.lock().map_err(|err| err.to_string())?.writer(&id)?;
    blocking(move || {
        let mut writer = writer.lock().map_err(|_| "Terminal writer lock failed")?;
        writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|err| format!("Could not write to the terminal: {err}"))
    }).await
}

#[tauri::command]
fn terminal_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    if !terminal::valid_id(&id) {
        return Err("That terminal has closed.".into());
    }
    state.terminals.lock().map_err(|err| err.to_string())?.resize(&id, cols, rows)
}

/// End a terminal and everything running in it.
#[tauri::command]
async fn terminal_close(app: AppHandle, id: String) -> Result<(), String> {
    if !terminal::valid_id(&id) {
        return Ok(());
    }
    blocking(move || {
        app.state::<AppState>().terminals.lock().map_err(|err| err.to_string())?.close(&id);
        Ok(())
    })
    .await
}

/// Zoom the window's webview. The level is the renderer's saved preference;
/// anything outside the range the menu can reach is refused.
#[tauri::command]
fn set_interface_zoom(window: tauri::WebviewWindow, level: f64) -> Result<(), String> {
    if !level.is_finite() || !(0.5..=2.0).contains(&level) {
        return Err("That zoom level is out of range.".into());
    }
    window.set_zoom(level).map_err(|err| err.to_string())
}

/// Give the main window the interface's appearance, so the material behind a
/// translucent sidebar is the light or dark one the theme expects. Only the
/// window is touched: the application keeps following macOS, which is what the
/// Dock icon reads (see `app_icon`).
#[tauri::command]
fn set_window_appearance(window: tauri::WebviewWindow, theme: String) -> Result<(), String> {
    let dark = window_appearance(&theme)?;
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSWindow};
        let target = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(handle) = target.ns_window() else {
                    return;
                };
                // SAFETY: Tauri returns this window's live NSWindow, and AppKit is only touched here, on the main thread.
                let ns_window = unsafe { &*handle.cast::<NSWindow>() };
                // SAFETY: both names are AppKit constants that live for the whole process.
                let appearance = match dark {
                    Some(true) => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameDarkAqua }),
                    Some(false) => NSAppearance::appearanceNamed(unsafe { NSAppearanceNameAqua }),
                    None => None,
                };
                ns_window.setAppearance(appearance.as_deref());
            })
            .map_err(|err| err.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, dark);
    Ok(())
}

/// The renderer's theme as a window appearance: dark, light, or `None` to follow the OS.
fn window_appearance(theme: &str) -> Result<Option<bool>, String> {
    match theme {
        "dark" => Ok(Some(true)),
        "light" => Ok(Some(false)),
        "system" => Ok(None),
        _ => Err("That appearance is not one of light, dark or system.".into()),
    }
}

#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    if !url_open_allowed(&url) {
        return Err("Only http(s) links can be opened.".into());
    }
    app.opener().open_url(&url, None::<&str>).map_err(|err| err.to_string())
}

fn shutdown_bridge(state: &AppState) {
    if let Ok(mut terminals) = state.terminals.lock() {
        terminals.close_all();
    }
    if let Ok(mut guard) = state.bridge.lock() {
        if let Some(bridge) = guard.take() {
            // EOF first: the bridge treats stdin end as all-host shutdown,
            // which reaps ACP process groups before the Node process exits.
            process::shutdown_tree(bridge.child, bridge.stdin, Duration::from_secs(2));
        }
    }
}

/// Trackpad haptic tick (macOS Force Touch). `kind`: "alignment" for detents,
/// "level" for tier changes, anything else for a generic tap. No-op elsewhere.
#[tauri::command]
fn haptic(app: AppHandle, kind: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime, NSHapticFeedbackPerformer};
        let pattern = match kind.as_str() {
            "alignment" => NSHapticFeedbackPattern::Alignment,
            "level" => NSHapticFeedbackPattern::LevelChange,
            _ => NSHapticFeedbackPattern::Generic,
        };
        app.run_on_main_thread(move || {
            let performer = NSHapticFeedbackManager::defaultPerformer();
            performer.performFeedbackPattern_performanceTime(pattern, NSHapticFeedbackPerformanceTime::Now);
        })
        .map_err(|err| err.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, kind);
    Ok(())
}

/// Application menu. Custom items carry stable ids; `on_menu_event` forwards
/// them to the renderer as `app-menu` events that map to the same store
/// actions as the JS keydown shortcuts. Generic over the runtime so tests can
/// build it under `MockRuntime` without a window server.
fn build_app_menu<R: Runtime>(app: &AppHandle<R>, rebound: &HashMap<String, String>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    // A shortcut the user rebound replaces the item's default accelerator.
    let item = |id: &str, text: &str, accelerator: &str| MenuItemBuilder::with_id(id, text).accelerator(rebound.get(id).map(String::as_str).unwrap_or(accelerator)).build(app);
    let file = SubmenuBuilder::new(app, "File").item(&item("new-thread", "New Thread", "CmdOrCtrl+N")?).item(&item("open-workspace", "Open Workspace…", "CmdOrCtrl+P")?).separator().item(&PredefinedMenuItem::close_window(app, None)?).build()?;
    let edit = SubmenuBuilder::new(app, "Edit").item(&PredefinedMenuItem::undo(app, None)?).item(&PredefinedMenuItem::redo(app, None)?).separator().item(&PredefinedMenuItem::cut(app, None)?).item(&PredefinedMenuItem::copy(app, None)?).item(&PredefinedMenuItem::paste(app, None)?).item(&PredefinedMenuItem::select_all(app, None)?).build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&item("toggle-sidebar", "Toggle Sidebar", "CmdOrCtrl+B")?)
        .item(&item("toggle-changes", "Toggle Changes", "CmdOrCtrl+I")?)
        .item(&item("command-palette", "Command Palette", "CmdOrCtrl+K")?)
        .separator()
        .item(&item("find-in-thread", "Find in Thread", "CmdOrCtrl+F")?)
        .item(&item("search-threads", "Search Threads", "CmdOrCtrl+Shift+F")?)
        .separator()
        .item(&item("next-thread", "Next Thread", "CmdOrCtrl+Shift+]")?)
        .item(&item("previous-thread", "Previous Thread", "CmdOrCtrl+Shift+[")?)
        .separator()
        .item(&item("shortcuts", "Keyboard Shortcuts", "CmdOrCtrl+/")?)
        .separator()
        .item(&item("zoom-in", "Zoom In", "CmdOrCtrl+=")?)
        .item(&item("zoom-out", "Zoom Out", "CmdOrCtrl+-")?)
        .item(&item("zoom-reset", "Actual Size", "CmdOrCtrl+0")?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").item(&PredefinedMenuItem::minimize(app, None)?).item(&PredefinedMenuItem::maximize(app, None)?).separator().item(&PredefinedMenuItem::fullscreen(app, None)?).build()?;
    #[allow(unused_mut)]
    let mut menu = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "Glitter")
            .item(&PredefinedMenuItem::about(app, Some("About Glitter"), None)?)
            .separator()
            .item(&item("settings", "Settings…", "CmdOrCtrl+,")?)
            .separator()
            .item(&PredefinedMenuItem::services(app, None)?)
            .item(&PredefinedMenuItem::hide(app, None)?)
            .item(&PredefinedMenuItem::hide_others(app, None)?)
            .item(&PredefinedMenuItem::show_all(app, None)?)
            .separator()
            .item(&PredefinedMenuItem::quit(app, None)?)
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.item(&file).item(&edit).item(&view).item(&window).build()
}

/// Renderer-facing ids emitted as `app-menu`; anything else keeps its native behavior.
const APP_MENU_IDS: &[&str] = &["settings", "new-thread", "open-workspace", "toggle-sidebar", "toggle-changes", "command-palette", "search-threads", "find-in-thread", "next-thread", "previous-thread", "shortcuts", "zoom-in", "zoom-out", "zoom-reset"];

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic reports join the same redacted channel as every other diagnostic:
    // the default hook writes raw text to stderr, which lands in the OS log
    // outside the redactor on packaged builds. The app-log append below is
    // best-effort — panics before `setup` still reach stderr redacted.
    std::panic::set_hook(Box::new(|info| {
        let message = info.payload().downcast_ref::<&str>().copied().or_else(|| info.payload().downcast_ref::<String>().map(String::as_str)).unwrap_or("panic");
        let location = info.location().map(|loc| format!(" at {}:{}:{}", loc.file(), loc.line(), loc.column())).unwrap_or_default();
        let safe = redact_log_detail(&format!("{message}{location}"));
        eprintln!("[glitter] panic: {safe}");
        if let Some(path) = APP_LOG_PATH.get() {
            let _ = append_log_line(path, "error", "panic", &safe);
        }
    }));
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        native_log("info", "app.second_instance", "focused the running window");
    }));
    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler({
            let commands: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                bridge_request,
                verify_grants,
                remove_grant,
                agent_identities,
                confirm_agent_bin,
                git_snapshot,
                git_review,
                turn_snapshots,
                turn_snapshot_restore,
                turn_snapshots_forget,
                git_init,
                git_worktree_create,
                git_worktree_remove,
                git_worktree_handoff,
                git_branches,
                git_switch,
                git_push,
                git_pull,
                git_pull_request,
                list_workspace_files,
                read_workspace_file,
                git_discard_files,
                git_discard_all,
                git_discard_hunk,
                git_stage,
                git_commit,
                pick_folder,
                export_session,
                save_output_text,
                trust_preview,
                mcp_consent::review_mcp,
                mcp_consent::consent_mcp,
                mcp_consent::workspace_trust,
                mcp_consent::workspace_trust_set,
                mcp_login,
                mcp_logout,
                cli_logout,
                project_init,
                enterprise_status,
                skill_list,
                skill_set,
                skill_install,
                skill_import,
                skill_inspect,
                skill_uninstall,
                pick_skill_source,
                plugin_list,
                plugin_inspect,
                plugin_review,
                plugin_install,
                pick_plugin_bundle,
                catalog_list,
                catalog_install,
                catalog_remove,
                read_dropped_files,
                open_path,
                open_url,
                set_interface_zoom,
                set_window_appearance,
                set_menu_shortcuts,
                terminal_open,
                terminal_write,
                terminal_resize,
                terminal_close,
                persist_store_atomic,
                repair_store_document,
                append_app_log,
                open_log_folder,
                support_paths,
                open_config_file,
                diagnostics_snapshot,
                haptic,
                credentials::credential_get,
                credentials::credential_set,
                credentials::acp_isolation_consent_get,
                credentials::acp_isolation_consent_set,
                credentials::provider_keys_get,
                credentials::provider_key_set
            ];
            move |invoke| {
                if ipc_body_oversized(invoke.message.payload()) {
                    invoke.resolver.reject("Request exceeds the IPC byte limit.");
                    return true;
                }
                commands(invoke)
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            // Before anything below opens the app's folders or keychain entries.
            let moved = match (handle.path().app_data_dir(), handle.path().app_log_dir()) {
                (Ok(data), Ok(logs)) => legacy::migrate(&data, &logs),
                _ => None,
            };
            if let Ok(dir) = handle.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = SECURITY_AUDIT.set(dir.join("security-audit.log"));
                let _ = APP_LOG_PATH.set(dir.join("glitter.log"));
            }
            if let Some((level, detail)) = moved {
                native_log(level, "legacy.migrate", &detail);
            }
            if let Ok(mut grants) = state.grants.lock() {
                *grants = load_grants();
            }
            if let Ok(data) = handle.path().app_data_dir() {
                state.workspace_security.load_from(&data.join("workspace-security.json"));
            }
            state.agent_pins.replace(load_agent_pins());
            // Warm the bridge beside the webview instead of before it. Starting it
            // means hashing the bundled Node runtime (~150 MB) and spawning it, which
            // used to run here, holding the window back on every launch. A request
            // that arrives first simply waits on the same lock inside `ensure_bridge`.
            let warm = handle.clone();
            std::thread::spawn(move || {
                let state = warm.state::<AppState>();
                if let Err(err) = ensure_bridge(&warm, &state) {
                    native_log("warn", "bridge.start_deferred", &format!("bridge start deferred: {err}"));
                }
            });
            if let Err(err) = build_app_menu(&handle, &HashMap::new()).and_then(|menu| app.set_menu(menu)) {
                native_log("warn", "menu.setup_skipped", &format!("menu setup skipped: {err}"));
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id.0.as_str();
            if APP_MENU_IDS.contains(&id) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("app-menu", json!({ "id": id }));
                }
            }
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if let tauri::WindowEvent::ThemeChanged(theme) = event {
                if window.label() == "main" {
                    app_icon::update(window.app_handle(), *theme);
                }
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop {
                paths,
                ..
            }) = event
            {
                if let Ok(mut grants) = window.state::<AppState>().dropped_paths.lock() {
                    grants.clear();
                    grants.extend(paths.iter().filter_map(|path| path.canonicalize().ok()));
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let state = window.state::<AppState>();
                    shutdown_bridge(&state);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Glitter")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if matches!(_event, tauri::RunEvent::Ready) {
                if let Some(window) = _app.get_webview_window("main") {
                    app_icon::update(_app, window.theme().unwrap_or(tauri::Theme::Light));
                }
            }
        });
}

/// Lenient `plugins list --json` rows: `{ plugins: [...] }` or a bare
/// array, entries named by id, pluginId, or name.
fn parse_plugin_list(stdout: &str) -> Vec<PluginEntry> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("plugins").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    fn text(object: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
        keys.iter().filter_map(|key| object.get(*key)?.as_str()).next().map(str::to_string)
    }
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = text(object, &["id", "pluginId", "name"])?;
            if id.is_empty() {
                return None;
            }
            Some(PluginEntry {
                id,
                version: text(object, &["version"]),
                description: text(object, &["description", "summary"]).unwrap_or_default().chars().take(280).collect(),
                enabled: object.get("enabled").and_then(Value::as_bool),
            })
        })
        .take(200)
        .collect()
}

/// Lenient `plugins inspect --json`: metadata plus runtime capabilities.
fn parse_plugin_detail(id: &str, stdout: &str) -> PluginDetail {
    let value: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    let object = value.as_object().cloned().unwrap_or_default();
    let text = |keys: &[&str]| -> Option<String> { keys.iter().filter_map(|key| object.get(*key)?.as_str()).next().map(str::to_string) };
    let capabilities = object
        .get("capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|entry| {
            let cap = entry.as_object()?;
            let cid = ["id", "capabilityId", "stableId", "name"].iter().filter_map(|key| cap.get(*key)?.as_str()).next()?;
            if cid.is_empty() {
                return None;
            }
            Some(PluginCapability {
                id: cid.to_string(),
                kind: cap.get("kind").and_then(Value::as_str).map(str::to_string),
                description: cap.get("description").and_then(Value::as_str).unwrap_or("").chars().take(280).collect(),
                enabled: cap.get("enabled").and_then(Value::as_bool),
            })
        })
        .take(200)
        .collect();
    PluginDetail {
        id: text(&["id", "pluginId"]).unwrap_or_else(|| id.to_string()),
        version: text(&["version"]),
        description: text(&["description", "summary"]).unwrap_or_default().chars().take(280).collect(),
        capabilities,
    }
}

/// Lenient `skills list --json` rows: `{ skills: [...] }` or a bare
/// array, identified by id with name/scope/activation alongside.
fn parse_skill_inventory(stdout: &str) -> Vec<SkillEntry> {
    let value: Value = match serde_json::from_str(stdout) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let entries = match &value {
        Value::Array(items) => items.clone(),
        Value::Object(map) => map.get("skills").and_then(Value::as_array).cloned().unwrap_or_default(),
        _ => Vec::new(),
    };
    entries
        .iter()
        .filter_map(|entry| {
            let object = entry.as_object()?;
            let id = object.get("id")?.as_str()?;
            if id.is_empty() {
                return None;
            }
            Some(SkillEntry {
                id: id.to_string(),
                name: object.get("name").and_then(Value::as_str).unwrap_or(id).to_string(),
                description: object.get("description").or_else(|| object.get("short_description")).and_then(Value::as_str).unwrap_or("").chars().take(280).collect(),
                scope: object.get("scope").and_then(Value::as_str).unwrap_or("").to_string(),
                activation: object.get("activation").and_then(Value::as_str).unwrap_or("").to_string(),
            })
        })
        .take(200)
        .collect()
}

/// Lenient `config status` text: a `Generation:` line plus `plane=…`
/// source rows. Unknown lines are ignored so new CLI output never breaks
/// the read.
fn parse_enterprise_status(stdout: &str) -> EnterpriseStatus {
    let mut generation = None;
    let mut sources = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("Generation:") {
            let value = value.trim();
            if !value.is_empty() {
                generation = Some(value.chars().take(128).collect());
            }
            continue;
        }
        if trimmed.starts_with("plane=") {
            let mut plane = String::new();
            let mut source_class = String::new();
            let mut state = String::new();
            for part in trimmed.split_whitespace() {
                let (key, value) = part.split_once('=').unwrap_or(("", ""));
                match key {
                    "plane" => plane = value.to_string(),
                    "source_class" => source_class = value.to_string(),
                    "state" => state = value.to_string(),
                    _ => {}
                }
            }
            if !plane.is_empty() {
                sources.push(EnterpriseSource {
                    plane,
                    source_class,
                    state,
                });
            }
        }
    }
    EnterpriseStatus {
        generation,
        sources: sources.into_iter().take(32).collect(),
    }
}

/// Lenient `skills inspect --json`: a flat object or a `{ skill: … }`
/// envelope, keyed by id with scope/activation/path alongside.
fn parse_skill_detail(fallback_id: &str, stdout: &str) -> SkillDetail {
    let value: Value = serde_json::from_str(stdout).unwrap_or(Value::Null);
    let object = value.get("skill").or(Some(&value)).and_then(Value::as_object);
    let text = |keys: &[&str]| -> Option<String> { object.and_then(|map| keys.iter().find_map(|key| map.get(*key)?.as_str())).map(str::to_string) };
    SkillDetail {
        id: text(&["id"]).unwrap_or_else(|| fallback_id.to_string()),
        name: text(&["name"]).unwrap_or_else(|| fallback_id.to_string()),
        description: text(&["description", "short_description"]).unwrap_or_default().chars().take(280).collect(),
        scope: text(&["scope"]).unwrap_or_default(),
        activation: text(&["activation"]).unwrap_or_default(),
        path: text(&["path"]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LogTestDir(PathBuf);

    impl LogTestDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("muse-log-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("log test dir");
            Self(path)
        }

        fn file(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for LogTestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A fresh scratch dir with a store document in it.
    fn store_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muse-store-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn store_document_is_valid_rejects_a_truncated_document() {
        let dir = store_dir("valid");
        let target = dir.join("glitter.json");
        std::fs::write(&target, "{\"settings\":{},\"sessionMemory\":{}}").expect("write");
        assert!(store_document_is_valid(&target));
        // What a crash part-way through a truncate-and-write leaves behind.
        std::fs::write(&target, "{\"settings\":{").expect("write");
        assert!(!store_document_is_valid(&target), "truncated JSON must not be accepted");
        assert!(!store_document_is_valid(&dir.join("glitter.json.missing")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_truncated_store_is_quarantined_and_restored_from_the_backup() {
        let dir = store_dir("restore");
        let target = dir.join("glitter.json");
        // The atomic writer rotated the last good copy aside before replacing it.
        std::fs::write(dir.join("glitter.json.bak"), "{\"sessionMemory\":{\"version\":1}}").expect("write");
        std::fs::write(&target, "{\"settings\":{").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "restored");
        assert_eq!(repaired.restored_from.as_deref(), Some("glitter.json.bak"));
        assert_eq!(repaired.quarantined_to.as_deref(), Some("glitter.json.corrupt"));
        assert!(store_document_is_valid(&target), "the good copy must be back in place");
        // The damaged original is preserved for forensics rather than overwritten.
        assert!(dir.join("glitter.json.corrupt").exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_write_prefers_the_newer_tmp_over_the_backup() {
        let dir = store_dir("tmp-wins");
        let target = dir.join("glitter.json");
        // Crash between the two renames: the old copy is already at `.bak` and
        // the interrupted write is a complete `.tmp`.
        std::fs::write(dir.join("glitter.json.bak"), "{\"sessionMemory\":{\"generation\":1}}").expect("write");
        std::fs::write(dir.join("glitter.json.tmp"), "{\"sessionMemory\":{\"generation\":2}}").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "restored");
        assert_eq!(repaired.restored_from.as_deref(), Some("glitter.json.tmp"));
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "{\"sessionMemory\":{\"generation\":2}}", "the interrupted write is newer than the backup and must win");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_interrupted_write_with_a_per_call_tmp_name_still_beats_the_backup() {
        let dir = store_dir("tmp-suffix");
        let target = dir.join("glitter.json");
        // Every save now writes its own `glitter.json.tmp.<pid>.<n>`;
        // repair must recognize a suffixed interrupted write the same way.
        std::fs::write(dir.join("glitter.json.bak"), "{\"sessionMemory\":{\"generation\":1}}").expect("write");
        std::fs::write(dir.join("glitter.json.tmp.123.7"), "{\"sessionMemory\":{\"generation\":2}}").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "restored");
        assert_eq!(repaired.restored_from.as_deref(), Some("glitter.json.tmp.123.7"));
        assert_eq!(std::fs::read_to_string(&target).expect("read"), "{\"sessionMemory\":{\"generation\":2}}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overlapping_store_writes_stay_whole_and_leave_no_temp_files() {
        let dir = store_dir("concurrent");
        let target = dir.join("glitter.json");
        std::fs::write(&target, "{\"settings\":{}}").expect("seed");
        // Session-memory saves are not serialized renderer-side, so two calls
        // can genuinely overlap. Each document is self-describing: a pad whose
        // length equals the writer index would betray any interleaved write.
        let mut handles = Vec::new();
        for n in 0..8usize {
            let dir = dir.clone();
            handles.push(std::thread::spawn(move || {
                for round in 0..4 {
                    write_store_document(&dir, &format!("{{\"writer\":{n},\"round\":{round},\"pad\":\"{}\"}}", "x".repeat(n))).expect("save");
                }
            }));
        }
        for handle in handles {
            handle.join().expect("writer");
        }
        let saved: Value = serde_json::from_slice(&std::fs::read(&target).expect("read")).expect("final document must parse");
        assert_eq!(
            saved["pad"].as_str().unwrap_or_default().len(),
            saved["writer"].as_u64().unwrap_or(u64::MAX) as usize,
            "a document whose pad does not match its writer means two saves interleaved"
        );
        assert!(
            std::fs::read_dir(&dir)
                .expect("dir")
                .flatten()
                .all(|entry| !entry.file_name().to_str().is_some_and(is_store_temp_name)),
            "a completed save must sweep every interrupted temp"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_store_with_no_fallback_is_quarantined_not_silently_reset() {
        let dir = store_dir("quarantine");
        let target = dir.join("glitter.json");
        std::fs::write(&target, "not json at all").expect("write");

        let repaired = repair_store_files(&target).expect("repair");

        assert_eq!(repaired.status, "quarantined");
        assert_eq!(repaired.restored_from, None, "nothing recoverable, so nothing restored");
        assert!(!target.exists(), "the unreadable file must not be left to poison the next load");
        assert_eq!(std::fs::read_to_string(dir.join("glitter.json.corrupt")).expect("read"), "not json at all", "the damaged file must survive byte-for-byte");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_store_is_a_clean_first_run() {
        let dir = store_dir("first-run");
        let repaired = repair_store_files(&dir.join("glitter.json")).expect("repair");
        assert_eq!(repaired.status, "empty");
        assert_eq!(repaired.restored_from, None);
        assert_eq!(repaired.quarantined_to, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cli_names_reject_flags_paths_and_blanks() {
        assert!(check_cli_name("server name", "acme-tools").is_ok());
        assert!(check_cli_name("server name", "").is_err());
        assert!(check_cli_name("server name", "--json").is_err());
        assert!(check_cli_name("server name", "a/b").is_err());
        assert!(check_cli_name("server name", "a b").is_err());
    }

    #[test]
    fn plugin_parsers_cover_envelopes_details_and_garbage() {
        let listed = parse_plugin_list(r#"{"plugins": [{"id": "acme", "version": "1.2", "description": "Tools", "enabled": true}, {}]}"#);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "acme");
        assert_eq!(listed[0].enabled, Some(true));
        assert!(parse_plugin_list("nope").is_empty());
        let detail = parse_plugin_detail("acme", r#"{"id": "acme", "capabilities": [{"stableId": "s1", "kind": "tool", "description": "Runs shell"}]}"#);
        assert_eq!(detail.capabilities.len(), 1);
        let skills = parse_skill_inventory(r#"{"skills": [{"id": "bundled:git", "name": "git", "description": "Git help", "scope": "bundled", "activation": "on"}, {}]}"#);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].id, "bundled:git");
        assert_eq!(skills[0].activation, "on");
        assert!(parse_skill_inventory("nope").is_empty());
        let enterprise = parse_enterprise_status("Enterprise configuration status\nGeneration: sha256:abc123\nSources:\n  plane=defaults source_class=system_file state=absent\n  plane=policy source_class=macos_managed_preferences state=active\n");
        assert_eq!(enterprise.generation.as_deref(), Some("sha256:abc123"));
        assert_eq!(enterprise.sources.len(), 2);
        assert_eq!(enterprise.sources[1].state, "active");
        assert!(parse_enterprise_status("nothing useful").generation.is_none());
        let flat = parse_skill_detail("bundled:git", r#"{"id": "bundled:git", "name": "git", "scope": "bundled", "activation": "on", "path": "bundled://skills/git/SKILL.md"}"#);
        assert_eq!(flat.path.as_deref(), Some("bundled://skills/git/SKILL.md"));
        let wrapped = parse_skill_detail("x", r#"{"skill": {"id": "user:acme", "scope": "user", "activation": "off"}}"#);
        assert_eq!(wrapped.id, "user:acme");
        assert_eq!(wrapped.activation, "off");
        assert!(parse_skill_detail("x", "nope").path.is_none());
        let diff = "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n d\n@@ -10,2 +10,2 @@\n x\n-y\n+z\n";
        let patch = single_hunk_patch(diff, 1).expect("second hunk");
        assert!(patch.contains("diff --git a/f.txt b/f.txt"));
        assert!(patch.contains("@@ -10,2 +10,2 @@"));
        assert!(!patch.contains("@@ -1,3"));
        assert!(single_hunk_patch(diff, 2).is_err());
        assert_eq!(detail.capabilities[0].id, "s1");
        let fallback = parse_plugin_detail("acme", "nope");
        assert_eq!(fallback.id, "acme");
        assert!(fallback.capabilities.is_empty());
    }

    #[test]
    fn skill_list_parses_envelopes_and_skips_nameless() {
        let enveloped = parse_skill_list(r#"{"skills": [{"selector": "/review", "description": "Review code"}, {"description": "nameless"}]}"#);
        assert_eq!(enveloped.len(), 1);
        assert_eq!(enveloped[0].name, "/review");
        assert_eq!(enveloped[0].description, "Review code");
        let bare = parse_skill_list(r#"[{"displayName": "Plan", "description": "x"}]"#);
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].name, "Plan");
        assert!(parse_skill_list("not json").is_empty());
        assert!(parse_skill_list(r#"{"other": []}"#).is_empty());
    }

    #[test]
    fn extra_bin_dirs_include_user_local_bin() {
        let home = dirs::home_dir().expect("home directory");
        assert!(extra_bin_dirs().contains(&home.join(".local/bin")));
    }

    #[test]
    fn extra_dirs_find_node_without_shell_path() {
        let path = std::env::join_paths(extra_bin_dirs().into_iter().filter(|dir| dir.is_dir())).expect("join extra bin dirs");
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let found = which::which_in("node", Some(path), cwd);
        assert!(found.is_ok(), "node should be in well-known bin dirs: {found:?}");
    }

    #[test]
    fn muse_bin_rejects_missing_temp_and_wrong_names() {
        let state = AppState::new();
        // Nothing exists at these paths (or temp forbids them): all fail.
        assert!(resolve_muse_bin(&state, "/tmp/muse").is_err());
        assert!(resolve_muse_bin(&state, "/tmp/muse-audit-probe.sh").is_err());
        assert!(resolve_muse_bin(&state, "muse").is_err());
        assert!(resolve_muse_bin(&state, "/definitely/not/here").is_err());
        // Canonical validation (temp symlink smuggling, name checks, exec bit)
        // is covered in `exec.rs`; auto-discovery finds a real install or errs.
        let found = resolve_muse_bin(&state, "");
        assert!(found.is_ok() || found.unwrap_err().contains("not found"));
    }

    fn fixture_repo(tag: &str) -> (AppState, String, PathBuf) {
        // Tags repeat across tests (for example, unborn HEAD). Cargo runs them
        // concurrently, so each invocation needs its own repository/index.
        let dir = std::env::temp_dir().join(format!("muse-discard-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        run_git(&dir, &["init", "-q"]).expect("init");
        run_git(&dir, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&dir, &["config", "user.name", "Test"]).expect("config");
        run_git(&dir, &["config", "commit.gpgsign", "false"]).expect("config");
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), dir.canonicalize().expect("canon"));
        (state, id, dir)
    }

    fn commit_all(dir: &Path, message: &str) {
        run_git(dir, &["add", "-A"]).expect("add");
        run_git(dir, &["commit", "-qm", message]).expect("commit");
    }

    fn review_request(scope: ReviewScope, base: Option<&str>) -> GitReviewRequest {
        GitReviewRequest {
            scope,
            base: base.map(String::from),
            session_id: None,
            snapshot_id: None,
        }
    }

    #[test]
    fn git_review_scopes_separate_index_and_worktree_without_writing_the_index() {
        let (_state, _grant, dir) = fixture_repo("scopes");
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        commit_all(&dir, "base");
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        run_git(&dir, &["add", "a.txt"]).unwrap();
        std::fs::write(dir.join("a.txt"), "working\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new text\n").unwrap();
        std::fs::write(dir.join("blob.bin"), [0, 1, 2]).unwrap();
        let index = std::fs::read(dir.join(".git/index")).unwrap();
        let staged = git_review_for(&dir, &review_request(ReviewScope::Staged, None)).unwrap();
        assert!(staged.diff.contains("-base\n+staged"));
        assert!(!staged.diff.contains("working"));
        assert_eq!(staged.files.len(), 1);
        assert_eq!(staged.files[0].path, "a.txt");
        let unstaged = git_review_for(&dir, &review_request(ReviewScope::Unstaged, None)).unwrap();
        assert!(unstaged.diff.contains("-staged\n+working"));
        assert!(unstaged.diff.contains("+new text"));
        assert!(unstaged.files.iter().any(|file| file.path == "blob.bin" && file.preview_skipped.as_deref() == Some("binary")));
        assert_eq!(std::fs::read(dir.join(".git/index")).unwrap(), index);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_review_staged_scope_supports_an_unborn_head() {
        let (_state, _grant, dir) = fixture_repo("staged-unborn");
        std::fs::write(dir.join("a.txt"), "staged\n").unwrap();
        run_git(&dir, &["add", "a.txt"]).unwrap();
        std::fs::write(dir.join("a.txt"), "unstaged\n").unwrap();
        let staged = git_review_for(&dir, &review_request(ReviewScope::Staged, None)).unwrap();
        assert!(staged.diff.contains("+staged"));
        assert!(!staged.diff.contains("unstaged"));
        assert_eq!(staged.files[0].status, "A");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_review_branch_uses_the_common_ancestor_and_only_committed_changes() {
        let (_state, _grant, dir) = fixture_repo("branch-scope");
        std::fs::write(dir.join("a.txt"), "base\n").unwrap();
        commit_all(&dir, "base");
        run_git(&dir, &["branch", "review-base"]).unwrap();
        run_git(&dir, &["checkout", "-qb", "codex/feature"]).unwrap();
        std::fs::write(dir.join("a.txt"), "committed feature\n").unwrap();
        commit_all(&dir, "feature");
        run_git(&dir, &["checkout", "-q", "review-base"]).unwrap();
        std::fs::write(dir.join("base-only.txt"), "base branch secret\n").unwrap();
        commit_all(&dir, "base diverged");
        run_git(&dir, &["checkout", "-q", "codex/feature"]).unwrap();
        std::fs::write(dir.join("a.txt"), "staged feature\n").unwrap();
        run_git(&dir, &["add", "a.txt"]).unwrap();
        std::fs::write(dir.join("a.txt"), "working feature\n").unwrap();
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();
        let branch = git_review_for(&dir, &review_request(ReviewScope::Branch, Some("review-base"))).unwrap();
        assert!(branch.diff.contains("-base\n+committed feature"));
        assert!(!branch.diff.contains("staged feature"));
        assert!(!branch.diff.contains("working feature"));
        assert!(!branch.diff.contains("base branch secret"));
        assert_eq!(branch.files.len(), 1);
        assert!(branch.base_commit.is_some());
        assert!(branch.head_commit.is_some());
        for invalid in ["", "--output=outside.patch", "main\nHEAD", "missing-base"] {
            assert!(git_review_for(&dir, &review_request(ReviewScope::Branch, Some(invalid))).is_err());
        }
        assert!(!dir.join("outside.patch").exists());
        assert!(git_review_for(&dir, &review_request(ReviewScope::Staged, Some("HEAD"))).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_review_scopes_confine_nested_grants_and_cross_boundary_renames() {
        let (_state, _grant, dir) = fixture_repo("nested-scopes");
        let child = dir.join("allowed");
        std::fs::create_dir(&child).unwrap();
        std::fs::write(child.join("a.txt"), "inside\n").unwrap();
        std::fs::write(dir.join("sibling.txt"), "outside private\n").unwrap();
        commit_all(&dir, "base");
        std::fs::write(child.join("a.txt"), "inside staged\n").unwrap();
        std::fs::write(dir.join("sibling.txt"), "outside staged private\n").unwrap();
        commit_all(&dir, "committed");
        std::fs::write(child.join("a.txt"), "stage\n").unwrap();
        std::fs::write(dir.join("sibling.txt"), "outside staged\n").unwrap();
        run_git(&dir, &["add", "-A"]).unwrap();
        std::fs::write(child.join("a.txt"), "work\n").unwrap();
        std::fs::write(dir.join("sibling.txt"), "outside work\n").unwrap();
        for scope in [ReviewScope::Staged, ReviewScope::Unstaged, ReviewScope::Branch] {
            let review = git_review_for(&child, &review_request(scope, (scope == ReviewScope::Branch).then_some("HEAD~1"))).unwrap();
            assert_eq!(review.files.len(), 1);
            assert_eq!(review.files[0].path, "a.txt");
            assert!(!review.diff.contains("outside"));
            assert!(!review.diff.contains("allowed/"));
        }
        run_git(&dir, &["reset", "--hard", "HEAD"]).unwrap();
        run_git(&dir, &["mv", "allowed/a.txt", "outside-renamed.txt"]).unwrap();
        let review = git_review_for(&child, &review_request(ReviewScope::Staged, None)).unwrap();
        assert_eq!(review.files[0].status, "D");
        assert!(!review.diff.contains("outside-renamed"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn git_review_requests_reject_unknown_scopes_and_fields() {
        for value in [json!({"scope":"commit"}), json!({"scope":"staged", "cwd":"/private"}), json!({"scope":"unstaged", "patch":"x"})] {
            assert!(serde_json::from_value::<GitReviewRequest>(value).is_err());
        }
        let mut request = review_request(ReviewScope::Staged, None);
        request.snapshot_id = Some("fake".into());
        assert!(git_review_for(Path::new("/unused"), &request).is_err());
    }

    #[test]
    fn workspace_files_lists_repo_and_plain_trees() {
        // Repo path: tracked + untracked-not-ignored show; ignored entries don't.
        let (_state, _grant, dir) = fixture_repo("fileindex");
        std::fs::write(dir.join(".gitignore"), "ignored.log\nnode_modules/\n").expect("fixture");
        std::fs::create_dir_all(dir.join("src")).expect("fixture");
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        std::fs::write(dir.join("ignored.log"), "x\n").expect("fixture");
        std::fs::create_dir_all(dir.join("node_modules/pkg")).expect("fixture");
        std::fs::write(dir.join("node_modules/pkg/index.js"), "x\n").expect("fixture");
        let listed = workspace_files_for(&dir).expect("repo index");
        assert!(listed.iter().any(|p| p == "src/main.rs"));
        assert!(listed.iter().any(|p| p == "loose.txt"), "untracked files list: {listed:?}");
        assert!(!listed.iter().any(|p| p == "ignored.log" || p.starts_with("node_modules/")), "ignored excluded: {listed:?}");
        let _ = std::fs::remove_dir_all(&dir);

        // Plain dir: bounded walk skips dependency, build, and hidden dirs.
        let plain = std::env::temp_dir().join(format!("muse-fileindex-plain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(plain.join("src")).expect("fixture");
        std::fs::write(plain.join("src/lib.rs"), "x\n").expect("fixture");
        std::fs::create_dir_all(plain.join("node_modules/dep")).expect("fixture");
        std::fs::write(plain.join("node_modules/dep/x.js"), "x\n").expect("fixture");
        std::fs::create_dir_all(plain.join(".cache")).expect("fixture");
        std::fs::write(plain.join(".cache/x"), "x\n").expect("fixture");
        let listed = workspace_files_for(&plain).expect("walk index");
        assert_eq!(listed, vec!["src/lib.rs".to_string()], "walk result: {listed:?}");
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[test]
    fn discard_restores_tracked_and_removes_untracked() {
        let (state, grant, dir) = fixture_repo("files");
        std::fs::write(dir.join("a.txt"), "original\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("edit");
        std::fs::write(dir.join("b.txt"), "staged new\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        std::fs::write(dir.join("c.txt"), "untracked\n").expect("fixture");
        let snap = git_discard_files_inner(&state, &grant, vec!["a.txt".into(), "c.txt".into()]).expect("discard");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "original\n");
        assert!(!dir.join("c.txt").exists());
        // b.txt was not selected: still staged.
        assert!(snap.files.iter().any(|file| file.path == "b.txt"));
        // Staged-new files restore to HEAD-absent (unstaged and removed).
        let snap = git_discard_files_inner(&state, &grant, vec!["b.txt".into()]).expect("discard staged");
        assert!(!dir.join("b.txt").exists());
        assert!(!snap.dirty, "tree should be clean: {:?}", snap.files);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_rejects_escapes_limits_and_unknown_grants() {
        let (state, grant, dir) = fixture_repo("escapes");
        std::fs::write(dir.join("a.txt"), "x\n").expect("fixture");
        commit_all(&dir, "one");
        for bad in ["", "/etc/passwd", "../x", "a/../../b", "..", "sub/../../evil", &"x".repeat(1025)] {
            assert!(git_discard_files_inner(&state, &grant, vec![bad.into()]).is_err(), "{bad:?} must fail");
        }
        assert!(git_discard_files_inner(&state, &grant, vec![]).is_err());
        let many: Vec<String> = (0..201).map(|n| format!("f{n}.txt")).collect();
        assert!(git_discard_files_inner(&state, &grant, many).is_err());
        assert!(git_discard_files_inner(&state, "wg-00000000000000000000000000000000", vec!["a.txt".into()]).is_err());
        assert!(git_discard_all_inner(&state, "wg-00000000000000000000000000000000").is_err());
        // Nothing was touched by the rejections.
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "x\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_symlink_inside_repo_cannot_escape() {
        let (state, grant, dir) = fixture_repo("symlink");
        let outside = std::env::temp_dir().join(format!("muse-discard-outside-{}", std::process::id()));
        std::fs::write(&outside, "precious\n").expect("fixture");
        std::os::unix::fs::symlink(&outside, dir.join("link")).expect("symlink");
        commit_all(&dir, "one");
        std::fs::write(&outside, "changed\n").expect("edit outside");
        let err = git_discard_files_inner(&state, &grant, vec!["link".into()]).unwrap_err();
        assert!(err.contains("workspace"), "{err}");
        assert_eq!(std::fs::read_to_string(&outside).expect("read"), "changed\n");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn discard_all_cleans_everything_but_ignored() {
        let (state, grant, dir) = fixture_repo("all");
        std::fs::write(dir.join(".gitignore"), "ignored.log\n").expect("fixture");
        std::fs::write(dir.join("a.txt"), "original\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("edit");
        std::fs::write(dir.join("b.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        std::fs::write(dir.join("c.txt"), "untracked\n").expect("fixture");
        std::fs::write(dir.join("ignored.log"), "keep me\n").expect("fixture");
        git_discard_all_inner(&state, &grant).expect("discard all");
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("read"), "original\n");
        assert!(!dir.join("b.txt").exists());
        assert!(!dir.join("c.txt").exists());
        assert_eq!(std::fs::read_to_string(dir.join("ignored.log")).expect("read"), "keep me\n");
        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert!(!snap.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discard_handles_unborn_head() {
        let (state, grant, dir) = fixture_repo("unborn");
        std::fs::write(dir.join("new.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "new.txt"]).expect("stage");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        let snap = git_discard_files_inner(&state, &grant, vec!["new.txt".into(), "loose.txt".into()]).expect("discard");
        assert!(!dir.join("new.txt").exists());
        assert!(!dir.join("loose.txt").exists());
        assert!(!snap.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capping_text_never_splits_a_character() {
        // "é" is two bytes, so a cut at an odd offset lands inside it; a plain
        // `String::truncate` would panic there.
        let mut text = "é".repeat(10);
        assert!(cap_text(&mut text, 5));
        assert_eq!(text, "éé", "the cut backs up to the previous boundary");
        let mut short = "abc".to_string();
        assert!(!cap_text(&mut short, 10));
        assert_eq!(short, "abc");
    }

    #[test]
    fn a_huge_multibyte_diff_is_cut_without_panicking() {
        let (_state, _grant, dir) = fixture_repo("huge-diff");
        std::fs::write(dir.join("big.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        // Well past DIFF_LIMIT, all multi-byte, so the byte cap lands mid-character.
        std::fs::write(dir.join("big.txt"), "é".repeat(DIFF_LIMIT)).expect("fixture");
        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert!(snap.truncated, "a diff past the limit must report truncation");
        assert!(snap.diff.ends_with("…truncated"), "the truncation marker is appended");
        assert!(snap.diff.len() < DIFF_LIMIT + 64, "the diff is bounded, not buffered in full");
        assert_eq!(snap.files.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_reads_side_by_side_still_match_the_sequential_answer() {
        let (_state, _grant, dir) = fixture_repo("parallel-snapshot");
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").expect("fixture");
        std::fs::write(dir.join("b.txt"), "keep\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").expect("fixture");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert!(snap.dirty);
        assert!(!snap.branch.is_empty());
        let a = snap.files.iter().find(|file| file.path == "a.txt").expect("modified file listed");
        assert_eq!((a.added, a.removed), (1, 0), "numstat is joined to the right file");
        assert!(snap.files.iter().any(|file| file.path == "loose.txt" && file.status == "??"));
        assert!(snap.diff.contains("+three"), "the tracked diff is included");
        assert!(!snap.truncated);
        // An unborn branch takes the fallback reads and still answers.
        let (_s, _g, empty) = fixture_repo("parallel-unborn");
        std::fs::write(empty.join("new.txt"), "staged\n").expect("fixture");
        run_git(&empty, &["add", "new.txt"]).expect("stage");
        let unborn = git_snapshot_for(&empty.canonicalize().expect("canon")).expect("unborn snapshot");
        assert!(unborn.files.iter().any(|file| file.path == "new.txt"));
        assert!(unborn.diff.contains("+staged"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn bridge_script_verification_rejects_swaps() {
        assert!(verify_bridge_script(Path::new("/definitely/not/here.js")).is_err());
        let swap = std::env::temp_dir().join(format!("muse-script-swap-{}.js", std::process::id()));
        std::fs::write(&swap, b"console.log('evil')").expect("fixture");
        let err = verify_bridge_script(&swap).unwrap_err();
        assert!(err.contains("ridge script"), "{err}");
        let _ = std::fs::remove_file(&swap);
        // The worktree bundle verifies when it exists, proving the baked
        // digest tracks the packaged script.
        let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../packages/glitter-bridge/dist/index.js");
        if dist.exists() {
            assert!(verify_bridge_script(&dist).is_ok());
        }
    }

    #[test]
    fn sidecar_name_matches_installed_bundle() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let staged = config["bundle"]["externalBin"][0].as_str().unwrap();
        let base = Path::new(staged).file_name().unwrap().to_str().unwrap();
        assert_eq!(sidecar_file_name(), base);
    }

    #[cfg(unix)]
    #[test]
    fn terminal_runs_a_shell_in_the_folder_and_ends_with_its_grant() {
        use std::sync::mpsc;
        let dir = std::env::temp_dir().join(format!("muse-terminal-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("fixture");
        let root = dir.canonicalize().expect("canon");
        let mut terminals = terminal::Terminals::default();
        let (tx, rx) = mpsc::channel::<(String, Option<Vec<u8>>, Option<Option<u32>>)>();
        let open = |terminals: &mut terminal::Terminals, grant: &str| {
            let tx = tx.clone();
            terminals
                .open(grant, &root, 80, 24, move |id, event| {
                    let _ = match event {
                        terminal::Event::Output(bytes) => tx.send((id.to_string(), Some(bytes), None)),
                        terminal::Event::Exit(code) => tx.send((id.to_string(), None, Some(code))),
                    };
                })
                .expect("open")
        };
        let id = open(&mut terminals, "wg-a");
        assert!(terminal::valid_id(&id) && !terminal::valid_id("pt-../x") && !terminal::valid_id(""));

        // What the shell prints comes back, and it runs in the granted folder.
        terminals.write(&id, b"printf 'here:%s\\n' \"$PWD\"\n").expect("write");
        let wanted = format!("here:{}", root.display());
        let mut seen = String::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while !seen.contains(&wanted) && Instant::now() < deadline {
            if let Ok((_, Some(bytes), _)) = rx.recv_timeout(Duration::from_millis(250)) {
                seen.push_str(&String::from_utf8_lossy(&bytes));
            }
        }
        assert!(seen.contains(&wanted), "shell output never arrived: {seen:?}");
        terminals.resize(&id, 120, 40).expect("resize");
        assert!(terminals.write(&id, &vec![b'x'; terminal::WRITE_LIMIT + 1]).is_err());

        // Revoking a grant ends its terminals and leaves the others.
        let other = open(&mut terminals, "wg-b");
        terminals.close_grants(&["wg-a".to_string()]);
        assert_eq!(terminals.len(), 1);
        assert!(terminals.write(&id, b"echo\n").is_err(), "a closed terminal takes no input");
        let ended = (0..80).any(|_| matches!(rx.recv_timeout(Duration::from_millis(250)), Ok((ref from, None, Some(_))) if from == &id));
        assert!(ended, "the closed shell reports its exit");
        terminals.write(&other, b"exit 3\n").expect("write");
        let code = (0..80).find_map(|_| match rx.recv_timeout(Duration::from_millis(250)) {
            Ok((ref from, None, Some(code))) if from == &other => Some(code),
            _ => None,
        });
        assert_eq!(code, Some(Some(3)), "a shell that exits on its own reports its code");

        // The command layer forgets a shell when it reports its exit.
        assert!(terminals.forget(&other) && !terminals.forget(&other));
        for _ in 0..terminal::MAX_TERMINALS {
            open(&mut terminals, "wg-c");
        }
        assert_eq!(terminals.len(), terminal::MAX_TERMINALS);
        let tx2 = tx.clone();
        assert!(
            terminals
                .open("wg-c", &root, 80, 24, move |_, _| {
                    let _ = &tx2;
                })
                .is_err(),
            "the cap holds"
        );
        terminals.close_all();
        assert_eq!(terminals.len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn menu_accelerators_follow_a_closed_grammar() {
        for ok in ["CmdOrCtrl+K", "CmdOrCtrl+Shift+F", "CmdOrCtrl+Shift+Alt+]", "CmdOrCtrl+Alt+A", "CmdOrCtrl+=", "CmdOrCtrl+0", "CmdOrCtrl+F12", "CmdOrCtrl+/", "CmdOrCtrl+Shift+\\"] {
            assert!(valid_accelerator(ok), "{ok}");
        }
        for bad in ["K", "Cmd+K", "CmdOrCtrl+", "CmdOrCtrl+k", "CmdOrCtrl+Alt+Shift+K", "CmdOrCtrl+F13", "CmdOrCtrl+F0", "CmdOrCtrl+Space", "CmdOrCtrl+KK", "CmdOrCtrl+Shift+Shift+K", "CmdOrCtrl+K;rm", ""] {
            assert!(!valid_accelerator(bad), "{bad}");
        }
    }

    #[test]
    fn editor_choice_is_a_closed_list() {
        assert_eq!(editor_program(None), Ok(None));
        assert_eq!(editor_program(Some("default")), Ok(None));
        for id in ["vscode", "cursor", "zed", "idea"] {
            assert!(editor_program(Some(id)).expect("known editor").is_some(), "{id}");
        }
        for id in ["/bin/sh", "open -a Terminal", "Visual Studio Code", "code;rm -rf", "VSCODE"] {
            assert!(editor_program(Some(id)).is_err(), "{id}");
        }
    }

    #[test]
    fn window_appearance_accepts_only_the_three_themes() {
        assert_eq!(window_appearance("dark"), Ok(Some(true)));
        assert_eq!(window_appearance("light"), Ok(Some(false)));
        assert_eq!(window_appearance("system"), Ok(None));
        for other in ["", "Dark", "auto", "NSAppearanceNameVibrantDark"] {
            assert!(window_appearance(other).is_err(), "{other:?} must be refused");
        }
    }

    #[test]
    fn open_url_allows_only_remote_http() {
        assert!(url_open_allowed("https://muse.ai/docs"));
        assert!(url_open_allowed("http://localhost:3000/preview"));
        assert!(!url_open_allowed("file:///etc/passwd"));
        assert!(!url_open_allowed("muse://session/123"));
        assert!(!url_open_allowed("//evil.example/x"));
        assert!(!url_open_allowed("HTTP://example.com/"));
        assert!(!url_open_allowed("javascript:alert(1)"));
        assert!(!url_open_allowed(""));
    }

    #[cfg(unix)]
    #[test]
    fn default_open_refuses_extensionless_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("muse-open-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("fixture dir");
        // An extensionless shell script and an extensionless "binary" both run
        // under the OS default open when their execute bits are set.
        for name in ["runme", "payload"] {
            let file = dir.join(name);
            std::fs::write(&file, b"#!/bin/sh\necho hi\n").expect("fixture file");
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).expect("chmod");
            assert!(default_open_would_execute(&file), "+x {name} must be refused");
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).expect("chmod");
            assert!(!default_open_would_execute(&file), "non-executable {name} may open");
        }
        // Directories carry search bits yet only reveal in a file manager.
        assert!(!default_open_would_execute(&dir), "directories are not executables");
        // Listed extensions refuse even without the bit — which extension is
        // listed is platform-specific, so the test takes the list's own word.
        if let Some(ext) = EXECUTABLE_EXTENSIONS.first() {
            let listed = dir.join(format!("tool.{ext}"));
            std::fs::write(&listed, b"echo hi\n").expect("fixture file");
            assert!(default_open_would_execute(&listed), ".{ext} must be refused");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_log_details_fail_closed_on_secret_markers() {
        assert_eq!(redact_log_detail(r#"{"apiKey":"secret"}"#), "[redacted sensitive fields]");
        assert_eq!(redact_log_detail("host stopped unexpectedly"), "host stopped unexpectedly");
        assert!(!redact_log_detail(&"x".repeat(9_000)).len() > 8_000);
    }

    #[test]
    fn native_diagnostics_suppress_credentials_and_multiline_keys() {
        for text in ["Authorization: Bearer CANARY-BEARER", "Basic CANARY-BASIC", "https://user:CANARY-URL@example.invalid/path", "client_secret=CANARY-SECRET", "cookie=CANARY-COOKIE", "sk-CANARY-PROVIDER", "https://auth.invalid/?code=CANARY-CODE"] {
            assert!(!redact_log_detail(text).contains("CANARY"));
        }
        let mut private_key = false;
        assert!(redact_stderr_line("-----BEGIN RSA PRIVATE KEY-----", &mut private_key).is_some());
        assert!(redact_stderr_line("CANARY-BODY", &mut private_key).is_none());
        assert!(redact_stderr_line("-----END RSA PRIVATE KEY-----", &mut private_key).is_none());
        assert_eq!(redact_stderr_line("connected", &mut private_key).as_deref(), Some("connected"));
        assert!(!redact_stderr_line("CANARY-PREFIX [truncated]", &mut private_key).unwrap().contains("CANARY"));
    }

    #[test]
    fn log_tail_returns_empty_when_the_log_is_missing() {
        let dir = LogTestDir::new("tail-missing");
        assert!(log_tail(&dir.file("missing.log"), 200, 64 * 1024).expect("tail missing log").is_empty());
    }

    #[test]
    fn log_tail_returns_all_lines_from_a_small_file() {
        let dir = LogTestDir::new("tail-small");
        let path = dir.file("glitter.log");
        std::fs::write(&path, "first\nsecond\nthird\n").expect("write log");

        assert_eq!(log_tail(&path, 200, 64 * 1024).expect("read log"), vec!["first".to_string(), "second".to_string(), "third".to_string()]);
    }

    #[test]
    fn log_tail_drops_a_partial_first_line_after_seeking_to_the_window() {
        let dir = LogTestDir::new("tail-window");
        let path = dir.file("glitter.log");
        let contents = format!("{}\nkept-one\nkept-two\n", "x".repeat(20));
        std::fs::write(&path, contents).expect("write log");

        assert_eq!(log_tail(&path, 200, 20).expect("read log"), vec!["kept-one".to_string(), "kept-two".to_string()]);
    }

    #[test]
    fn log_tail_keeps_only_the_most_recent_lines() {
        let dir = LogTestDir::new("tail-limit");
        let path = dir.file("glitter.log");
        std::fs::write(&path, "one\ntwo\nthree\nfour\n").expect("write log");

        assert_eq!(log_tail(&path, 2, 64 * 1024).expect("read log"), vec!["three".to_string(), "four".to_string()]);
    }

    #[test]
    fn log_tail_redacts_secret_canaries() {
        let dir = LogTestDir::new("tail-redaction");
        let path = dir.file("glitter.log");
        std::fs::write(&path, "approval stripe sk_live_CANARYabcdefghijklmnop\n").expect("write log");

        assert_eq!(log_tail(&path, 200, 64 * 1024).expect("read log"), vec!["[redacted sensitive fields]".to_string()]);
    }

    #[test]
    fn unlabelled_credential_formats_redact_without_a_label() {
        for text in [
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c end",
            "aws AKIAIOSFODNN7EXAMPLE seen",
            "temp ASIAIOSFODNN7EXAMPLE seen",
            "slack xoxb-1234567890-CANARYTOKENabcd",
            "npm npm_aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1aB1 token",
            "google AIzaSySySySySySySySySySySySySySySySySy1 key",
            "stripe sk_live_CANARYabcdefghijklmnop",
            "sendgrid SG.xxxxxxxxxxxxxxxxxxxxxx.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY tail",
            "age AGE-SECRET-KEY-1qqpqaze9canary9x8gf2tvdw0s3jn54khce6mua7l",
            "shopify shpat_cafecafecafecafecafecafecafecafe",
            "linear lin_api_CANARYabcdefghijklmnopqrstuvwx",
            "gitlab glpat-CANARYabcdefghijklmnop",
            "pypi pypi-CANARYabcdefghijklmnop",
            "doppler dp.pt.CANARYabcdefghijklmnopqrstuvwx",
        ] {
            assert_eq!(redact_log_detail(text), "[redacted sensitive fields]", "{text}");
        }
    }

    #[test]
    fn entropy_runs_redact_but_hashes_and_ids_stay_visible() {
        assert_eq!(redact_log_detail("session Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1Ab1"), "[redacted sensitive fields]");
        assert_eq!(redact_log_detail("commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a"), "commit 54d702f8a1b2c3d4e5f60718293a4b5c6d7e8f9a");
        assert_eq!(redact_log_detail("session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c"), "session 3f8a2b1c-9d4e-4f5a-8b6c-7d8e9f0a1b2c");
    }

    #[test]
    fn ipc_body_budget_rejects_oversized_trees_before_dto() {
        use tauri::ipc::InvokeBody;
        let under = json!({ "method": "sendTurn", "text": "x".repeat(1_000_000), "images": ["a".repeat(32 * 1024 * 1024)] });
        assert!(!ipc_body_oversized(&InvokeBody::Json(under)));
        assert!(ipc_body_oversized(&InvokeBody::Json(json!({ "blob": "x".repeat(IPC_BODY_LIMIT + 1) }))));
        assert!(ipc_body_oversized(&InvokeBody::Json(json!({ ("k".repeat(IPC_BODY_LIMIT)): true }))));
        assert!(ipc_body_oversized(&InvokeBody::Raw(vec![0u8; IPC_BODY_LIMIT + 1])));
        // Wide-but-small and deep structures stay under the node cap.
        let wide: Value = (0..100_000).map(|i| json!({ "k": i })).collect();
        assert!(!ipc_body_oversized(&InvokeBody::Json(wide)));
        let mut deep = json!(1);
        for _ in 0..512 {
            deep = json!([deep]);
        }
        assert!(!ipc_body_oversized(&InvokeBody::Json(deep)));
        // Node-count abuse still fails closed.
        let swarm: Value = (0..IPC_NODE_LIMIT + 1).map(|_| json!(0)).collect();
        assert!(ipc_body_oversized(&InvokeBody::Json(swarm)));
    }

    #[test]
    fn export_names_are_safe_and_readable() {
        assert_eq!(export_file_name("Fix auth / retry bug", "json"), "fix-auth-retry-bug.json");
        assert_eq!(export_file_name("  ", "json"), "muse-session.json");
        assert_eq!(export_file_name("Fix auth", "md"), "fix-auth.md");
        assert!(!export_file_name("../../secret", "json").contains('/'));
    }

    #[test]
    fn picked_install_is_single_use_and_picker_bound() {
        let dir = std::env::temp_dir().join(format!("muse-pick-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let raw = dir.to_string_lossy().into_owned();

        // Unpicked paths are refused, even for a real directory.
        let mut picked = HashSet::new();
        assert!(take_picked_install_in(&mut picked, &raw).is_err());

        // A pick authorizes exactly once: the second install must re-pick.
        picked.insert(dir.canonicalize().unwrap());
        assert!(take_picked_install_in(&mut picked, &raw).is_ok());
        assert!(take_picked_install_in(&mut picked, &raw).is_err());

        // A missing folder is refused before any authorization is consumed.
        picked.insert(dir.canonicalize().unwrap());
        assert!(take_picked_install_in(&mut picked, &format!("{raw}/gone")).is_err());
        assert!(take_picked_install_in(&mut picked, &raw).is_ok());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn porcelain_z_skips_rename_sources() {
        let raw = " M src/a.rs\0R  new name.rs\0old name.rs\0?? notes.txt\0";
        let files = parse_porcelain_z(raw);
        // Both XY columns are kept verbatim — " M" is unstaged, "M " staged.
        assert_eq!(files, vec![("src/a.rs".to_string(), " M".to_string()), ("new name.rs".to_string(), "R ".to_string()), ("notes.txt".to_string(), "??".to_string()),]);
    }

    #[test]
    fn numstat_z_maps_renames_to_new_path() {
        let raw = "12\t3\0plain.txt\0renamed file.txt\0";
        let counts = parse_numstat_z(raw);
        assert_eq!(counts.get("renamed file.txt").copied(), Some((12, 3)));
    }

    #[test]
    fn drop_media_type_matches_client_table() {
        assert_eq!(drop_media_type(Path::new("shot.PNG")), Some("image/png"));
        assert_eq!(drop_media_type(Path::new("photo.jpeg")), Some("image/jpeg"));
        assert_eq!(drop_media_type(Path::new("anim.gif")), Some("image/gif"));
        assert_eq!(drop_media_type(Path::new("pic.webp")), Some("image/webp"));
        assert_eq!(drop_media_type(Path::new("icon.svg")), Some("image/svg+xml"));
        assert_eq!(drop_media_type(Path::new("scan.tiff")), Some("image/tiff"));
        assert_eq!(drop_media_type(Path::new("live.heic")), Some("image/heic"));
        assert_eq!(drop_media_type(Path::new("notes.txt")), None);
        assert_eq!(drop_media_type(Path::new("Makefile")), None);
        assert_eq!(drop_media_type(Path::new("archive.tar.gz")), None);
    }

    #[test]
    fn read_dropped_files_reports_dirs_and_missing_paths() {
        let dir = std::env::temp_dir().join("muse-drop-test");
        let _ = std::fs::create_dir_all(&dir);
        let missing = dir.join("gone.png");
        let _ = std::fs::remove_file(&missing);
        let files = inspect_dropped_files(vec![dir.to_string_lossy().into_owned(), missing.to_string_lossy().into_owned()]).expect("drop read");
        assert_eq!(files.len(), 2);
        assert!(files[0].is_dir);
        assert!(files[0].error.is_none());
        assert!(files[1].error.is_some());
        assert!(files[1].base64_data.is_none());
    }

    #[test]
    fn read_dropped_files_inlines_small_images() {
        let dir = std::env::temp_dir().join("muse-drop-test");
        let _ = std::fs::create_dir_all(&dir);
        let image = dir.join("tiny.png");
        std::fs::write(&image, [0x89, b'P', b'N', b'G']).expect("write fixture");
        let files = inspect_dropped_files(vec![image.to_string_lossy().into_owned()]).expect("drop read");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].media_type.as_deref(), Some("image/png"));
        assert!(files[0].base64_data.is_some());
        assert!(files[0].error.is_none());
        let _ = std::fs::remove_file(&image);
    }

    #[test]
    fn read_dropped_files_caps_batch_size() {
        let paths: Vec<String> = (0..DROP_FILE_LIMIT + 5).map(|n| format!("/definitely/missing/file-{n}.txt")).collect();
        let files = inspect_dropped_files(paths).expect("drop read");
        assert_eq!(files.len(), DROP_FILE_LIMIT);
    }

    #[test]
    fn grant_ids_are_valid_and_unique() {
        let ids: Vec<String> = (0..500).map(|_| mint_grant_id()).collect();
        assert!(ids.iter().all(|id| valid_grant_id(id)));
        let unique: HashSet<&str> = ids.iter().map(String::as_str).collect();
        assert_eq!(unique.len(), ids.len());
        assert!(!valid_grant_id("wg-short"));
        assert!(!valid_grant_id("wg-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"));
        assert!(!valid_grant_id(""));
        assert!(!valid_session_id(""));
        assert!(!valid_session_id("has space"));
        assert!(!valid_session_id(&"x".repeat(513)));
        assert!(valid_session_id("01a0bcbb-8b53-7df0-8a17-08a6702c9d68"));
        assert!(harness_session_log_file(Path::new("/data"), "h-thread-123").unwrap().ends_with("harness/sessions/h-thread-123.jsonl"));
        assert!(harness_session_log_file(Path::new("/data"), "../h-thread-123").is_err());
        assert!(harness_session_log_file(Path::new("/data"), "muse-thread-123").is_err());
    }

    #[test]
    fn grants_serialize_and_drop_stale_entries() {
        let dir = std::env::temp_dir().join(format!("muse-grants-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let live = dir.join("live");
        let _ = std::fs::create_dir_all(&live);
        let mut grants = HashMap::new();
        grants.insert(mint_grant_id(), live.canonicalize().unwrap());
        let loaded = parse_grants(&render_grants(&grants).expect("render"));
        assert_eq!(loaded.len(), 1);
        // Stale roots and malformed ids fail closed on load.
        let mut tampered = grants.clone();
        tampered.insert(mint_grant_id(), dir.join("deleted-folder"));
        tampered.insert("not-an-id".into(), live.canonicalize().unwrap());
        let reloaded = parse_grants(&render_grants(&tampered).expect("render"));
        assert_eq!(reloaded.len(), 1);
        assert!(parse_grants("not json").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grant_containment_checks_escape() {
        let dir = std::env::temp_dir().join(format!("muse-grant-path-{}", std::process::id()));
        let child = dir.join("repo");
        let _ = std::fs::create_dir_all(&child);
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), dir.canonicalize().unwrap());
        assert!(path_within_grant(&state, &id, &child).unwrap());
        assert!(path_within_grant(&state, &id, &dir).unwrap());
        assert!(!path_within_grant(&state, &id, Path::new("/definitely/not/granted")).unwrap());
        assert!(path_within_grant(&state, "wg-00000000000000000000000000000000", &child).is_err());
        assert!(grant_root(&state, "wg-00000000000000000000000000000000").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_huge_agents_md_is_read_only_up_to_the_preview_limit() {
        // The trust preview shows 2000 characters of AGENTS.md. Reading the whole
        // file let a symlink to /dev/zero — or a merely enormous file — allocate
        // until the process aborted, from a folder the user had just opened.
        let dir = std::env::temp_dir().join(format!("muse-rules-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A regular file far past the ceiling, written sparsely where possible.
        let body = "a".repeat((RULES_PREVIEW_LIMIT as usize) * 4);
        std::fs::write(dir.join("AGENTS.md"), &body).unwrap();
        let preview = read_rules_preview(&dir).expect("regular rules file");
        assert_eq!(preview.excerpt.chars().count(), 2000, "the preview stops at the character ceiling");
        assert!(preview.truncated, "the UI must be told the excerpt is partial");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn agents_md_symlink_outside_the_workspace_is_not_previewed() {
        let dir = std::env::temp_dir().join(format!("muse-rules-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let root = dir.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let outside = dir.join("outside.txt");
        std::fs::write(&outside, b"private rules").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("AGENTS.md")).unwrap();
        assert!(read_rules_preview(&root).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn containment_rejects_sibling_prefix_and_symlink_escape() {
        let dir = std::env::temp_dir().join(format!("muse-grant-sib-{}", std::process::id()));
        let root = dir.join("repo");
        let sibling = dir.join("repo-evil");
        let _ = std::fs::create_dir_all(&root);
        let _ = std::fs::create_dir_all(&sibling);
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), root.canonicalize().unwrap());
        // String-prefix sibling shares characters but no path components.
        assert!(!path_within_grant(&state, &id, &sibling).unwrap());
        // A symlink inside the grant pointing out resolves outside.
        #[cfg(unix)]
        {
            let outside = dir.join("outside");
            let _ = std::fs::create_dir_all(&outside);
            std::fs::write(outside.join("secret.txt"), b"nope").expect("fixture");
            let link = root.join("escape");
            let _ = std::os::unix::fs::symlink(&outside, &link);
            assert!(!path_within_grant(&state, &id, &link.join("secret.txt")).unwrap());
            // .. segments that stay inside still verify.
            let sub = root.join("sub");
            let _ = std::fs::create_dir_all(&sub);
            assert!(path_within_grant(&state, &id, &sub.join("..")).unwrap());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn revocation_drops_sessions_and_approvals() {
        let state = AppState::new();
        state.sessions.lock().unwrap().insert("s-keep".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        state.sessions.lock().unwrap().insert("s-drop".into(), "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
        state.approvals.lock().unwrap().insert("a-drop".into(), ("s-drop".into(), "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into()));
        state.approvals.lock().unwrap().insert("a-keep".into(), ("s-keep".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into()));
        drop_grant_bindings(&state, "wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let sessions = state.sessions.lock().unwrap();
        assert!(sessions.contains_key("s-keep"));
        assert!(!sessions.contains_key("s-drop"));
        drop(sessions);
        let approvals = state.approvals.lock().unwrap();
        assert!(approvals.contains_key("a-keep"));
        assert!(!approvals.contains_key("a-drop"));
    }

    #[test]
    fn approval_events_track_ownership_and_prune() {
        let state = AppState::new();
        state.sessions.lock().unwrap().insert("s-1".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        // Unbound sessions never record approvals.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-x", "sessionId": "s-ghost" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Bound sessions record; resolution prunes.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-1", "sessionId": "s-1" } }));
        assert_eq!(state.approvals.lock().unwrap().get("a-1"), Some(&("s-1".to_string(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string())));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approvalResolved", "payload": { "approvalId": "a-1", "sessionId": "s-1" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Turn end prunes the whole session; host death clears everything.
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-2", "sessionId": "s-1" } }));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "turnCompleted", "payload": { "sessionId": "s-1", "turnId": "t" } }));
        assert!(state.approvals.lock().unwrap().is_empty());
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "approval", "payload": { "approvalId": "a-3", "sessionId": "s-1" } }));
        snoop_bridge_event(&state, &json!({ "type": "event", "event": "hostExit", "payload": {} }));
        assert!(state.approvals.lock().unwrap().is_empty());
        // Malformed events never panic.
        snoop_bridge_event(&state, &json!({ "type": "event" }));
        snoop_bridge_event(&state, &json!({ "id": "x", "ok": true }));
    }

    #[test]
    fn duplicate_in_flight_ids_are_rejected() {
        let state = AppState::new();
        assert!(track_pending(&state, "dup", "listSessions", None).is_ok());
        assert!(track_pending(&state, "dup", "startSession", None).is_err());
    }

    #[test]
    fn the_session_binding_table_is_capped() {
        // `listSessions` is repeatable and a renderer can page it for the whole
        // app lifetime, so the binding table needs the same ceiling `pending` has.
        // Bindings are re-learned on the next listing, so dropping the oldest is safe.
        let state = AppState::new();
        for index in 0..(MAX_SESSION_BINDINGS + 50) {
            bind_sessions(&state, vec![format!("s-{index}")], "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        }
        let sessions = state.sessions.lock().unwrap();
        assert_eq!(sessions.len(), MAX_SESSION_BINDINGS);
        assert!(!sessions.contains_key("s-0"), "oldest binding is evicted first");
        assert!(!sessions.contains_key("s-49"), "first 50 bindings are evicted");
        assert!(sessions.contains_key("s-50"), "51st binding is kept");
        assert!(sessions.contains_key(&format!("s-{}", MAX_SESSION_BINDINGS + 49)), "newest binding is never evicted by its own insert");
    }

    #[test]
    fn the_security_audit_log_refuses_forged_columns() {
        // The log is TSV. A renderer-chosen id carrying a tab must not be able
        // to append columns to an approval decision.
        let safe = redact_log_detail("approval a-1\tchoice\tfake")
            .replace(['\n', '\r', '\t'], " ")
            .chars()
            .map(|ch| {
                if ch.is_control() {
                    ' '
                } else {
                    ch
                }
            })
            .collect::<String>();
        assert!(!safe.contains('\t'), "tabs must not survive into the audit log");
        assert!(!safe.contains('\n'));
        assert!(safe.starts_with("approval a-1 choice fake"));
    }

    #[test]
    fn rotate_if_large_rotates_at_limit_but_not_below_it() {
        let dir = LogTestDir::new("rotate");
        let path = dir.file("glitter.log");
        let previous = dir.file("glitter.previous.log");

        std::fs::write(&path, b"12345678").expect("write log");
        rotate_if_large(&path, 8).expect("rotate at limit");
        assert_eq!(std::fs::read(&previous).expect("read rotated log"), b"12345678");
        assert!(!path.exists());

        std::fs::remove_file(&previous).expect("remove rotated log");
        std::fs::write(&path, b"1234567").expect("write small log");
        rotate_if_large(&path, 8).expect("keep log below limit");
        assert_eq!(std::fs::read(&path).expect("read small log"), b"1234567");
        assert!(!previous.exists());
    }

    #[test]
    fn append_audit_line_rotates_and_writes_one_redacted_tsv_line() {
        let dir = LogTestDir::new("audit");
        let path = dir.file("security-audit.log");
        let previous = dir.file("security-audit.previous.log");

        std::fs::write(&path, vec![b'x'; APP_LOG_LIMIT as usize + 1]).expect("write large audit log");
        append_audit_line(&path, "approval\tstripe sk_live_CANARYabcdefghijklmnop\nforged").expect("append audit line");

        let old = std::fs::read(&previous).expect("read rotated audit log");
        assert_eq!(old.len(), APP_LOG_LIMIT as usize + 1);
        let contents = std::fs::read_to_string(&path).expect("read audit line");
        assert_eq!(contents.lines().count(), 1);
        assert_eq!(contents.split('\t').count(), 2);
        assert!(contents.ends_with("\t[redacted sensitive fields]\n"));
        assert!(!contents.contains("CANARY"));
        assert!(!contents.contains("forged"));
    }

    #[test]
    fn concurrent_app_log_writes_are_complete_tsv_lines() {
        let dir = LogTestDir::new("concurrent");
        let path = dir.file("glitter.log");

        std::thread::scope(|scope| {
            for worker in 0..8 {
                let path = &path;
                scope.spawn(move || {
                    for line in 0..200 {
                        append_log_line(path, "info", "test.concurrent", &format!("{worker}-{line}")).expect("append app log");
                    }
                });
            }
        });

        let contents = std::fs::read_to_string(&path).expect("read concurrent log");
        let lines: Vec<&str> = contents.lines().collect();
        assert_eq!(lines.len(), 1600);
        for line in lines {
            let fields: Vec<&str> = line.split('\t').collect();
            assert_eq!(fields.len(), 4);
            assert!(fields[0].parse::<u128>().is_ok());
            assert_eq!(fields[1], "info");
            assert_eq!(fields[2], "test.concurrent");
        }
    }

    #[test]
    fn grant_ids_are_never_logged_whole() {
        // A grant id is a capability handle: anything reading the system log
        // must not be able to harvest a working one.
        let id = "wg-1234567890abcdef1234567890abcdef123";
        assert_eq!(grant_tag(id), "wg-123456789");
        assert!(grant_tag(id).len() < id.len());
    }

    #[test]
    fn the_pending_table_is_actually_capped() {
        let state = AppState::new();
        for index in 0..MAX_PENDING_CALLS {
            track_pending(&state, &format!("call-{index}"), "listSessions", None).expect("track");
        }
        // The table is full with fresh entries: more calls are refused.
        assert!(track_pending(&state, "call-extra", "listSessions", None).is_err());
    }

    #[test]
    fn fork_responses_bind_to_the_source_grant() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        state.sessions.lock().unwrap().insert("s-src".into(), grant.clone());
        track_pending(&state, "call-fork", "forkSession", Some(grant.clone())).expect("track");
        snoop_bridge_response(&state, &json!({ "id": "call-fork", "ok": true, "result": { "sessionId": "s-fork" } }));
        assert_eq!(state.sessions.lock().unwrap().get("s-fork"), Some(&grant));
    }

    #[test]
    fn close_session_is_a_known_session_scoped_verb() {
        // Every bridge verb needs an allowlist entry and a typed DTO; a
        // session-scoped one must also be bound to a live grant before it
        // reaches the bridge, or a renderer could close another workspace's
        // session.
        assert!(BRIDGE_METHODS.contains(&"closeSession"));
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), PathBuf::from("/tmp"));
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.insert("s-live".into(), id.clone());
        }
        assert!(require_session(&state, "s-live").is_ok());
        assert!(require_session(&state, "s-ghost").is_err());
    }

    #[test]
    fn unbound_sessions_are_rejected() {
        let state = AppState::new();
        assert!(require_session(&state, "nope-missing").is_err());
        assert!(require_session(&state, "").is_err());
        state.sessions.lock().unwrap().insert("s-bound".into(), "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        assert!(require_session(&state, "s-bound").is_ok());
    }

    #[test]
    fn bridge_responses_bind_sessions_to_the_calling_grant() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        track_pending(&state, "call-1", "startSession", Some(grant.clone())).expect("track");
        track_pending(&state, "call-2", "listSessions", Some(grant.clone())).expect("track");
        snoop_bridge_response(&state, &json!({ "id": "call-1", "ok": true, "result": { "sessionId": "s-new" } }));
        snoop_bridge_response(&state, &json!({ "id": "call-2", "ok": true, "result": { "sessions": [{ "sessionId": "s-a" }, { "sessionId": "s-b" }] } }));
        let sessions = state.sessions.lock().unwrap();
        assert_eq!(sessions.get("s-new"), Some(&grant));
        assert_eq!(sessions.get("s-a"), Some(&grant));
        assert_eq!(sessions.get("s-b"), Some(&grant));
        assert!(state.pending.lock().unwrap().is_empty(), "attribution is single-shot");
    }

    #[test]
    fn list_sessions_rows_from_another_workspace_do_not_bind() {
        let state = AppState::new();
        let grant = mint_grant_id();
        let scratch = std::env::temp_dir().join(format!("muse-snoop-{}", std::process::id()));
        let mine = scratch.join("mine");
        let other = scratch.join("other");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let mine_canon = mine.canonicalize().unwrap();
        let other_canon = other.canonicalize().unwrap();
        state.grants.lock().unwrap().insert(grant.clone(), mine_canon.clone());
        track_pending(&state, "call-x", "listSessions", Some(grant.clone())).expect("track");
        snoop_bridge_response(
            &state,
            &json!({
                "id": "call-x", "ok": true,
                "result": { "sessions": [
                    { "sessionId": "s-in", "workspaceRoot": mine_canon.to_string_lossy() },
                    { "sessionId": "s-out", "workspaceRoot": other_canon.to_string_lossy() },
                    { "sessionId": "s-plain" }
                ] }
            }),
        );
        let sessions = state.sessions.lock().unwrap();
        assert_eq!(sessions.get("s-in"), Some(&grant), "a row naming this workspace binds");
        assert!(sessions.get("s-out").is_none(), "a row naming a foreign workspace never binds");
        assert_eq!(sessions.get("s-plain"), Some(&grant), "a row without a workspace binds to the listing's grant");
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn a_muse_binary_inside_a_granted_workspace_is_refused() {
        #[cfg(unix)]
        {
            let state = AppState::new();
            let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("muse-resolve-{}", std::process::id()));
            let workspace = scratch.join("workspace");
            std::fs::create_dir_all(&workspace).unwrap();
            let bin = workspace.join("muse");
            std::fs::write(&bin, b"#!/bin/sh\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
            let grant = mint_grant_id();
            state.grants.lock().unwrap().insert(grant, workspace.canonicalize().unwrap());
            let err = resolve_muse_bin(&state, &bin.to_string_lossy()).unwrap_err();
            assert!(err.contains("cannot live inside"), "{err}");
            let _ = std::fs::remove_dir_all(&scratch);
        }
    }

    #[test]
    fn snoop_binds_nothing_without_attribution_or_on_failure() {
        let state = AppState::new();
        let grant = mint_grant_id();
        state.grants.lock().unwrap().insert(grant.clone(), PathBuf::from("/tmp"));
        // Unknown call id: no binding.
        snoop_bridge_response(&state, &json!({ "id": "ghost", "ok": true, "result": { "sessionId": "s-ghost" } }));
        // Failed call: no binding.
        track_pending(&state, "call-9", "startSession", Some(grant.clone())).expect("track");
        snoop_bridge_response(&state, &json!({ "id": "call-9", "ok": false, "error": "denied" }));
        // Grant revoked before the response landed: no binding.
        track_pending(&state, "call-10", "startSession", Some("wg-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into())).expect("track");
        snoop_bridge_response(&state, &json!({ "id": "call-10", "ok": true, "result": { "sessionId": "s-revoked" } }));
        // Malformed lines never panic and bind nothing.
        snoop_bridge_response(&state, &json!({ "type": "event" }));
        snoop_bridge_response(&state, &json!({ "id": "call-9" }));
        assert!(state.sessions.lock().unwrap().is_empty());
    }

    /// How long the e2e test waits for its real bridge process. It returns as
    /// soon as the condition holds; the limit only has to cover a cold Node
    /// start on a busy CI runner, which took longer than 5 seconds there.
    const E2E_WAIT_MS: u64 = 30_000;

    fn wait_until(mut check: impl FnMut() -> bool, ms: u64) -> bool {
        let started = Instant::now();
        while started.elapsed() < Duration::from_millis(ms) {
            if check() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        check()
    }

    /// Native-shell e2e through `mock_app` + a real spawned bridge process
    /// (tests/fixtures/stub-bridge.mjs): the grant → session → approval →
    /// export → relaunch → crash-recovery flow the packaged app runs, minus
    /// the dialog gestures themselves. Skips when Node is absent.
    #[cfg(unix)]
    #[test]
    fn bounded_timeout_kills_descendants_that_ignore_term() {
        let dir = std::env::temp_dir().join(format!("muse-bounded-tree-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("pid");
        let ready_file = dir.join("ready");
        let script = r#"
/bin/sh -c 'trap "" TERM; echo $$ > "$1"; while :; do sleep 1; done' sh "$1" &
trap 'exit 0' TERM
echo ready > "$2"
while :; do sleep 1; done
"#;
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(script).arg("sh").arg(&pid_file).arg(&ready_file);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(run_bounded(cmd, "fixture", Duration::from_millis(1000)));
        });
        for _ in 0..100 {
            if ready_file.exists() && pid_file.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let outcome = rx.recv_timeout(Duration::from_secs(8));
        let pid = std::fs::read_to_string(&pid_file).expect("grandchild pid").trim().to_string();
        let mut dead = false;
        for _ in 0..60 {
            if !std::process::Command::new("kill").args(["-0", &pid]).output().is_ok_and(|output| output.status.success()) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = std::process::Command::new("kill").args(["-KILL", &pid]).output();
        let _ = std::fs::remove_dir_all(&dir);
        let error = outcome.expect("bounded command returned").expect_err("the command times out");
        assert!(error.contains("took too long"), "{error}");
        assert!(dead, "the stubborn descendant survived the timeout cleanup");
    }

    #[test]
    fn native_shell_e2e_grant_session_approval_export_relaunch() {
        if which::which("node").is_err() {
            eprintln!("skipping native e2e: node is not on PATH");
            return;
        }
        let pid = std::process::id();
        // Grants must never touch the user's real keyring entry in tests.
        let grants_account = format!("e2e-grants-{pid}");
        std::env::set_var("GLITTER_TEST_GRANTS_ACCOUNT", &grants_account);
        // Non-temp scratch dirs: exec validation rejects /tmp, and grant roots
        // must exist on disk.
        let scratch = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!("e2e-{pid}"));
        let workspace = scratch.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        // The fixture lives under this checkout's ignored target directory.
        // Give it its own repo so its files use normal workspace ignore rules.
        run_git(&workspace, &["init"]).unwrap();
        let stub = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/stub-bridge.mjs").canonicalize().unwrap();
        std::env::set_var("GLITTER_BRIDGE_SCRIPT", &stub);

        use tauri::Listener;
        let app = tauri::test::mock_app();
        let initial = AppState::new();
        initial.snapshots.lock().unwrap().open(scratch.join("snapshots")).unwrap();
        app.manage(initial);
        let handle = app.handle().clone();
        // The reader thread forwards every bridge line as a `bridge-line`
        // event; capture them to assert the response round-trip, not just
        // the request write.
        let lines = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = lines.clone();
        app.listen("bridge-line", move |event| {
            sink.lock().unwrap().push(event.payload().to_string());
        });
        let call = |id: &str, method: &str, params: Value| tauri::async_runtime::block_on(bridge_request(handle.clone(), id.to_string(), method.to_string(), params));
        let response_for = |lines: &Mutex<Vec<String>>, id: &str| -> Option<Value> {
            lines.lock().unwrap().iter().find_map(|line| {
                let value: Value = serde_json::from_str(line).ok()?;
                (value.get("id").and_then(Value::as_str) == Some(id)).then_some(value)
            })
        };

        // Grant minting: dedupe by canonical root; persisted via the test account.
        let canon = workspace.canonicalize().unwrap();
        let state = app.state::<AppState>();
        let grant = mint_grant(&state, canon.clone()).unwrap();
        let again = mint_grant(&state, canon.clone()).unwrap();
        assert_eq!(grant.grant_id, again.grant_id, "re-picking a root returns its grant");

        // A session call without a grant id is refused before the bridge.
        assert!(call("n0", "startSession", json!({})).is_err());

        // The grant-bound call injects workspaceRoot natively (the stub refuses
        // otherwise) and the response binds session -> grant via the snoop.
        call("r1", "startSession", json!({ "grantId": grant.grant_id })).unwrap();
        assert!(wait_until(|| state.sessions.lock().unwrap().get("s-1") == Some(&grant.grant_id), E2E_WAIT_MS), "session did not bind to the grant");

        // The stub's approval event binds approval -> (session, grant).
        assert!(wait_until(|| state.approvals.lock().unwrap().contains_key("a-1"), E2E_WAIT_MS), "approval never arrived");
        // A decision for the wrong session is refused natively; the owning
        // session's decision forwards to the bridge and back.
        assert!(call("r2", "decideApproval", json!({ "approvalId": "a-1", "sessionId": "s-other", "choiceId": "deny" })).is_err());
        call("r3", "decideApproval", json!({ "approvalId": "a-1", "sessionId": "s-1", "choiceId": "deny" })).unwrap();
        assert!(wait_until(|| response_for(&lines, "r3").is_some(), E2E_WAIT_MS), "decideApproval response never arrived");
        assert_eq!(response_for(&lines, "r3").unwrap().get("result").unwrap().get("decided").unwrap(), "deny");

        // Bound session verbs forward; unbound sessions fail closed.
        std::fs::write(canon.join("checkpoint.txt"), b"user edit\n").unwrap();
        call("r4", "sendTurn", json!({ "sessionId": "s-1", "text": "checkpoint test" })).unwrap();
        call("r5", "cancelTurn", json!({ "sessionId": "s-1" })).unwrap();
        assert!(call("r6", "sendTurn", json!({ "sessionId": "s-nope", "text": "x" })).is_err());
        assert!(wait_until(|| response_for(&lines, "r4").is_some() && response_for(&lines, "r5").is_some(), E2E_WAIT_MS), "turn responses never arrived");
        let saved = tauri::async_runtime::block_on(turn_snapshots(handle.clone(), grant.grant_id.clone(), "s-1".into())).unwrap();
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].state, "ready");
        assert_eq!(saved[0].files, ["checkpoint.txt"]);
        let last_request = || GitReviewRequest {
            scope: ReviewScope::LastTurn,
            base: None,
            session_id: Some("s-1".into()),
            snapshot_id: Some(saved[0].snapshot_id.clone()),
        };
        let reviewed = tauri::async_runtime::block_on(git_review(handle.clone(), grant.grant_id.clone(), last_request())).unwrap();
        assert!(reviewed.diff.contains("-user edit\n+agent edit"));
        assert_eq!(reviewed.files[0].path, "checkpoint.txt");
        assert!(tauri::async_runtime::block_on(git_review(handle.clone(), "ungranted".into(), review_request(ReviewScope::Staged, None))).is_err());
        let wrong_thread = GitReviewRequest {
            scope: ReviewScope::LastTurn,
            base: None,
            session_id: Some("s-nope".into()),
            snapshot_id: Some(saved[0].snapshot_id.clone()),
        };
        assert!(tauri::async_runtime::block_on(git_review(handle.clone(), grant.grant_id.clone(), wrong_thread)).is_err());
        let restored = tauri::async_runtime::block_on(turn_snapshot_restore(handle.clone(), grant.grant_id.clone(), "s-1".into(), saved[0].snapshot_id.clone(), false)).unwrap();
        assert!(restored.conflicts.is_empty());
        assert_eq!(restored.snapshot.state, "undone");
        assert_eq!(std::fs::read(canon.join("checkpoint.txt")).unwrap(), b"user edit\n");
        assert_eq!(tauri::async_runtime::block_on(git_review(handle.clone(), grant.grant_id.clone(), last_request())).unwrap().diff, reviewed.diff);
        assert!(tauri::async_runtime::block_on(turn_snapshot_restore(handle.clone(), grant.grant_id.clone(), "s-nope".into(), saved[0].snapshot_id.clone(), true)).is_err());
        tauri::async_runtime::block_on(turn_snapshot_restore(handle.clone(), grant.grant_id.clone(), "s-1".into(), saved[0].snapshot_id.clone(), true)).unwrap();
        assert_eq!(std::fs::read(canon.join("checkpoint.txt")).unwrap(), b"agent edit\n");

        // Export: a fixture `muse` under target/ (non-temp, executable, right
        // name) satisfies exec validation and writes the export file. The
        // fixture is a POSIX script, so this half only runs on unix.
        #[cfg(unix)]
        {
            let bin_dir = scratch.join("bin");
            std::fs::create_dir_all(&bin_dir).unwrap();
            let fake = bin_dir.join("muse");
            std::fs::write(&fake, "#!/bin/sh\nout=\"\"\nsess=\"\"\nwhile [ $# -gt 0 ]; do case \"$1\" in --out) shift; out=\"$1\";; --session) shift; sess=\"$1\";; esac; shift; done\nprintf '{\"exported\":true,\"session\":\"%s\"}\\n' \"$sess\" > \"$out\"\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
            let out = scratch.join("export.json");
            let written = export_to_path(&state, "s-1", out.to_str().unwrap(), fake.to_str().unwrap(), "Alpha", false, false).unwrap();
            assert_eq!(written, out.to_string_lossy());
            assert!(std::fs::read_to_string(&out).unwrap().contains("\"exported\":true"));
            assert!(export_to_path(&state, "s-nope", out.to_str().unwrap(), fake.to_str().unwrap(), "Alpha", false, false).is_err());

            let bin_md = scratch.join("bin-md");
            std::fs::create_dir_all(&bin_md).unwrap();
            let fake_md = bin_md.join("muse");
            std::fs::write(
                &fake_md,
                "#!/bin/sh\nout=\"\"\nred=raw\nwhile [ $# -gt 0 ]; do case \"$1\" in --out) shift; out=\"$1\";; --redacted) red=redacted;; esac; shift; done\ncat > \"$out\" <<EOF\n{\"export_schema_version\":1,\"redaction\":\"$red\",\"sessions\":[{\"session_id\":\"s-1\",\"turn_count\":1}],\"events\":[{\"kind\":\"record\",\"envelope\":{\"payload_type\":\"runtime.user_intent.accepted\",\"payload\":{\"refill_blocks\":[{\"kind\":\"text\",\"text\":\"hello\"}]}}},{\"kind\":\"record\",\"envelope\":{\"payload_type\":\"runtime.session\",\"payload\":{\"kind\":\"run\",\"event\":{\"kind\":\"assistant_message_committed\",\"text\":\"hi there\",\"encrypted_content\":\"cipher-blob\"}}}}]}\nEOF\n",
            )
            .unwrap();
            std::fs::set_permissions(&fake_md, std::fs::Permissions::from_mode(0o755)).unwrap();
            let md = scratch.join("export.md");
            let written = export_to_path(&state, "s-1", md.to_str().unwrap(), fake_md.to_str().unwrap(), "Alpha", true, true).unwrap();
            let body = std::fs::read_to_string(&md).unwrap();
            assert_eq!(written, md.to_string_lossy());
            assert!(body.contains("# Alpha\n"), "{body}");
            assert!(body.contains("Share-safe"), "{body}");
            assert!(body.contains("## You\n\nhello"), "{body}");
            assert!(body.contains("## Muse\n\nhi there"), "{body}");
            assert!(!body.contains("cipher-blob"), "{body}");
        }

        // Relaunch: grants reload from the persisted blob; live session
        // bindings do not survive a restart.
        let restored = parse_grants(&render_grants(&state.grants.lock().unwrap()).unwrap());
        let relaunched = AppState::new();
        relaunched.grants.lock().unwrap().extend(restored);
        assert!(grant_root(&relaunched, &grant.grant_id).is_ok());
        assert!(require_session(&relaunched, "s-1").is_err());

        // Bridge crash: the next request respawns the stub and succeeds.
        {
            let mut guard = state.bridge.lock().unwrap();
            let bridge = guard.as_mut().unwrap();
            let _ = bridge.child.kill();
            let _ = bridge.child.wait();
        }
        call("r9", "ping", json!({})).unwrap();
        assert!(wait_until(|| response_for(&lines, "r9").and_then(|v| v.get("result").and_then(|r| r.get("pong")).cloned()) == Some(json!(true)), E2E_WAIT_MS), "ping after respawn never returned");

        // Teardown: stop the bridge, drop the test keychain entry, scratch dirs.
        if let Some(bridge) = state.bridge.lock().unwrap().as_mut() {
            let _ = bridge.child.kill();
            let _ = bridge.child.wait();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = keyring::Entry::new(credentials::SERVICE, &grants_account).map(|e| e.delete_credential());
        }
        let _ = std::fs::remove_dir_all(&scratch);
    }

    #[test]
    fn read_workspace_file_is_bounded_and_confined_to_the_grant() {
        let (_state, _grant, dir) = fixture_repo("viewer");
        let root = dir.canonicalize().expect("canon");
        std::fs::create_dir_all(root.join("src")).expect("fixture");
        std::fs::write(root.join("src/app.ts"), "export const a = 1;\n").expect("fixture");
        std::fs::write(root.join("blob.bin"), [0u8, 159, 146, 150]).expect("fixture");
        std::fs::write(root.join("big.txt"), "é".repeat(FILE_VIEW_LIMIT as usize)).expect("fixture");
        let outside = root.parent().expect("parent").join(format!("muse-viewer-secret-{}", uuid::Uuid::new_v4().simple()));
        std::fs::write(&outside, "secret\n").expect("fixture");

        let file = read_workspace_file_at(&root, "src/app.ts").expect("read");
        assert_eq!(file.content.as_deref(), Some("export const a = 1;\n"));
        assert!(!file.truncated && file.skipped.is_none() && file.size == 20);

        let binary = read_workspace_file_at(&root, "blob.bin").expect("read");
        assert!(binary.content.is_none() && binary.skipped.as_deref() == Some("binary"));

        let big = read_workspace_file_at(&root, "big.txt").expect("read");
        let shown = big.content.expect("text");
        assert!(big.truncated && shown.len() <= FILE_VIEW_LIMIT as usize && shown.chars().all(|ch| ch == 'é'), "a cut never leaves a broken character");

        for path in ["", "../x", "/etc/passwd", "src/../../x", ".git/config", "src/.GIT/config", "src", "missing.txt", "a\0b"] {
            assert!(read_workspace_file_at(&root, path).is_err(), "{path:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link.txt")).expect("symlink");
            std::os::unix::fs::symlink(root.join(".git"), root.join("meta")).expect("symlink");
            assert!(read_workspace_file_at(&root, "link.txt").unwrap_err().contains("limited to the current workspace"));
            assert!(read_workspace_file_at(&root, "meta/config").is_err(), "a symlink cannot reach git metadata");
        }
        let _ = std::fs::remove_file(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_branches_list_and_switch_with_validated_names() {
        let (_state, _grant, dir) = fixture_repo("branches");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "base");
        let first = run_git(&dir, &["symbolic-ref", "--short", "HEAD"]).expect("head").trim().to_string();
        git_switch_at(&dir, "feature/login", true).expect("create");
        let listed = git_branches_at(&dir).expect("list");
        assert_eq!(listed.iter().find(|branch| branch.current).map(|branch| branch.name.as_str()), Some("feature/login"));
        assert!(listed.iter().any(|branch| branch.name == first && !branch.current));

        // Uncommitted work comes along when it does not conflict.
        std::fs::write(dir.join("draft.txt"), "wip\n").expect("edit");
        git_switch_at(&dir, &first, false).expect("switch back");
        assert_eq!(std::fs::read_to_string(dir.join("draft.txt")).expect("kept"), "wip\n");

        assert!(git_switch_at(&dir, "feature/login", true).unwrap_err().contains("already exists"));
        assert!(git_switch_at(&dir, "nope", false).unwrap_err().contains("no local branch"));
        for name in ["", "-b", "--orphan", "a b", "a..b", "x\ny", "refs/heads/@{-1}", "HEAD~1"] {
            assert!(git_switch_at(&dir, name, true).is_err(), "{name:?}");
            assert!(git_switch_at(&dir, name, false).is_err(), "{name:?}");
        }

        // A conflicting uncommitted edit blocks the switch and is left intact.
        git_switch_at(&dir, "feature/login", false).expect("switch");
        std::fs::write(dir.join("a.txt"), "feature\n").expect("edit");
        commit_all(&dir, "feature edit");
        git_switch_at(&dir, &first, false).expect("switch");
        std::fs::write(dir.join("a.txt"), "local edit\n").expect("edit");
        assert!(git_switch_at(&dir, "feature/login", false).unwrap_err().contains("would be overwritten"));
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).expect("kept"), "local edit\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_push_publishes_a_new_branch_and_reports_what_blocks_it() {
        let (_state, _grant, dir) = fixture_repo("push");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "base");
        assert!(git_push_at(&dir).unwrap_err().contains("no remote"));
        let remote = std::env::temp_dir().join(format!("muse-push-remote-{}.git", uuid::Uuid::new_v4().simple()));
        run_git(&dir, &["init", "-q", "--bare", &remote.to_string_lossy()]).expect("bare");
        run_git(&dir, &["remote", "add", "origin", &remote.to_string_lossy()]).expect("remote");
        let branch = run_git(&dir, &["symbolic-ref", "--short", "HEAD"]).expect("head").trim().to_string();
        let pushed = git_push_at(&dir).expect("push");
        assert_eq!((pushed.branch.as_str(), pushed.remote.as_str()), (branch.as_str(), "origin"));
        assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).expect("head"), run_git(&remote, &["rev-parse", &branch]).expect("remote head"));
        // A second push follows the upstream the first one set.
        std::fs::write(dir.join("a.txt"), "two\n").expect("edit");
        commit_all(&dir, "more");
        git_push_at(&dir).expect("push again");
        assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).expect("head"), run_git(&remote, &["rev-parse", &branch]).expect("remote head"));
        run_git(&dir, &["checkout", "-q", "--detach"]).expect("detach");
        assert!(git_push_at(&dir).unwrap_err().contains("detached"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[test]
    fn git_pull_fast_forwards_and_refuses_anything_else() {
        let (_state, _grant, dir) = fixture_repo("pull");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "base");
        let branch = run_git(&dir, &["symbolic-ref", "--short", "HEAD"]).expect("head").trim().to_string();
        assert!(git_pull_at(&dir).unwrap_err().contains("no upstream"));
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let remote = std::env::temp_dir().join(format!("muse-pull-remote-{unique}.git"));
        let other = std::env::temp_dir().join(format!("muse-pull-other-{unique}"));
        run_git(&dir, &["init", "-q", "--bare", &remote.to_string_lossy()]).expect("bare");
        run_git(&dir, &["remote", "add", "origin", &remote.to_string_lossy()]).expect("remote");
        git_push_at(&dir).expect("push");
        // Someone else pushes a commit.
        run_git(&dir, &["clone", "-q", "--branch", &branch, &remote.to_string_lossy(), &other.to_string_lossy()]).expect("clone");
        for (key, value) in [("user.email", "other@example.com"), ("user.name", "Other"), ("commit.gpgsign", "false")] {
            run_git(&other, &["config", key, value]).expect("config");
        }
        std::fs::write(other.join("b.txt"), "theirs\n").expect("edit");
        commit_all(&other, "theirs");
        run_git(&other, &["push", "-q"]).expect("push");

        std::fs::write(dir.join("local.txt"), "untracked work\n").expect("edit");
        git_pull_at(&dir).expect("fast-forward");
        assert_eq!(std::fs::read_to_string(dir.join("b.txt")).expect("pulled"), "theirs\n");
        assert_eq!(std::fs::read_to_string(dir.join("local.txt")).expect("kept"), "untracked work\n");

        // Diverged history is left for the user to merge or rebase.
        std::fs::write(other.join("b.txt"), "theirs again\n").expect("edit");
        commit_all(&other, "theirs again");
        run_git(&other, &["push", "-q"]).expect("push");
        std::fs::write(dir.join("a.txt"), "mine\n").expect("edit");
        run_git(&dir, &["commit", "-qam", "mine"]).expect("commit");
        let head = run_git(&dir, &["rev-parse", "HEAD"]).expect("head");
        assert!(git_pull_at(&dir).unwrap_err().contains("diverged"));
        assert_eq!(run_git(&dir, &["rev-parse", "HEAD"]).expect("head"), head, "nothing was merged");
        run_git(&dir, &["checkout", "-q", "--detach"]).expect("detach");
        assert!(git_pull_at(&dir).unwrap_err().contains("detached"));
        for path in [&dir, &remote, &other] {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn pull_request_checks_fold_into_one_word() {
        assert_eq!(checks_summary(&json!(null)), "none");
        assert_eq!(checks_summary(&json!([])), "none");
        assert_eq!(checks_summary(&json!([{ "status": "COMPLETED", "conclusion": "SUCCESS" }, { "state": "SUCCESS" }])), "passing");
        assert_eq!(checks_summary(&json!([{ "status": "COMPLETED", "conclusion": "SUCCESS" }, { "status": "IN_PROGRESS", "conclusion": "" }])), "pending");
        assert_eq!(checks_summary(&json!([{ "status": "IN_PROGRESS" }, { "status": "COMPLETED", "conclusion": "FAILURE" }])), "failing");
        assert_eq!(checks_summary(&json!([{ "state": "ERROR" }])), "failing");
        let pr = parse_pull_request(r#"{"url":"https://github.com/o/r/pull/7","number":7,"state":"OPEN","statusCheckRollup":[{"status":"QUEUED"}]}"#).expect("parse");
        assert_eq!(
            pr,
            PullRequest {
                unavailable: None,
                url: Some("https://github.com/o/r/pull/7".into()),
                number: Some(7),
                state: Some("OPEN".into()),
                checks: Some("pending".into())
            }
        );
        // A link that is not http(s) is never handed to the renderer to open.
        assert!(parse_pull_request(r#"{"url":"file:///etc/passwd","number":1}"#).expect("parse").url.is_none());
        assert!(parse_pull_request("not json").is_err());
    }

    fn worktree_fixture(tag: &str) -> (AppState, String, PathBuf, PathBuf) {
        let (state, grant, dir) = fixture_repo(tag);
        std::fs::write(dir.join("app.txt"), "base\n").expect("fixture");
        commit_all(&dir, "base");
        let store = std::env::temp_dir().join(format!("muse-worktrees-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&store).expect("store");
        (state, grant, dir, store.canonicalize().expect("canon"))
    }

    #[test]
    fn git_worktree_gives_a_thread_its_own_tree_and_grant() {
        let (state, grant, dir, store) = worktree_fixture("isolated");
        let made = git_worktree_create_inner(&state, &store, &grant, None).expect("create");
        let root = PathBuf::from(&made.path);
        assert!(root.starts_with(&store) && valid_grant_id(&made.grant_id) && made.grant_id != grant);
        assert!(made.branch.starts_with("glitter/"));
        assert_eq!(grant_root(&state, &made.grant_id).expect("derived grant"), root);
        assert_eq!(std::fs::read_to_string(root.join("app.txt")).expect("checked out"), "base\n");

        // Edits on either side stay on that side.
        std::fs::write(root.join("app.txt"), "worktree\n").expect("edit");
        std::fs::write(dir.join("local.txt"), "local\n").expect("edit");
        let theirs = git_snapshot_for(&root).expect("snapshot");
        let ours = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert_eq!(theirs.branch, made.branch);
        assert_eq!(theirs.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), ["app.txt"]);
        assert_eq!(ours.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), ["local.txt"]);

        // Removal discards the worktree, revokes its grant and drops the unused branch.
        state.sessions.lock().unwrap().insert("s-wt".into(), made.grant_id.clone());
        let gone = git_worktree_remove_inner(&state, &store, &made.grant_id).expect("remove");
        assert_eq!(gone.branch.as_deref(), Some(made.branch.as_str()));
        assert!(!gone.branch_kept && !root.exists());
        assert!(grant_root(&state, &made.grant_id).is_err() && state.sessions.lock().unwrap().is_empty());
        assert!(run_git(&dir, &["rev-parse", "--verify", &format!("refs/heads/{}", made.branch)]).is_err());
        assert_eq!(std::fs::read_to_string(dir.join("local.txt")).expect("local kept"), "local\n");
        assert!(grant_root(&state, &grant).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn git_worktree_handoff_applies_everything_or_nothing() {
        let (state, grant, dir, store) = worktree_fixture("handoff");
        let made = git_worktree_create_inner(&state, &store, &grant, None).expect("create");
        let root = PathBuf::from(&made.path);
        assert_eq!(git_worktree_handoff_inner(&state, &store, &made.grant_id).expect("empty").files, 0);

        // A commit, an unstaged edit, a new file and a deletion all travel.
        std::fs::write(root.join("committed.txt"), "committed\n").expect("edit");
        commit_all(&root, "work");
        std::fs::write(root.join("app.txt"), "base\nedited in worktree\n").expect("edit");
        std::fs::write(root.join("new.txt"), "new\n").expect("edit");
        std::fs::write(root.join("latin1.txt"), [b'c', b'a', b'f', 0xE9, b'\n']).expect("edit");
        let index = std::fs::read(root.join(".git")).expect("gitfile");
        std::fs::write(dir.join("local.txt"), "local work\n").expect("edit");

        let handed = git_worktree_handoff_inner(&state, &store, &made.grant_id).expect("handoff");
        assert_eq!(handed.files, 4);
        assert_eq!(std::fs::read(dir.join("latin1.txt")).expect("applied"), [b'c', b'a', b'f', 0xE9, b'\n'], "bytes that are not UTF-8 arrive unchanged");
        assert_eq!(std::fs::read_to_string(dir.join("app.txt")).expect("applied"), "base\nedited in worktree\n");
        assert_eq!(std::fs::read_to_string(dir.join("committed.txt")).expect("applied"), "committed\n");
        assert_eq!(std::fs::read_to_string(dir.join("new.txt")).expect("applied"), "new\n");
        assert_eq!(std::fs::read_to_string(dir.join("local.txt")).expect("kept"), "local work\n");
        assert!(run_git(&dir, &["diff", "--cached", "--quiet"]).is_ok(), "nothing is staged or committed in the workspace");
        assert!(handed.snapshot.files.iter().any(|file| file.path == "new.txt"));
        // The worktree is untouched: same files, nothing newly staged.
        assert_eq!(std::fs::read(root.join(".git")).expect("gitfile"), index);
        assert_eq!(run_git(&root, &["status", "--porcelain"]).expect("status").lines().count(), 3);

        // Applying the same changes again cannot land, and changes nothing.
        std::fs::write(root.join("app.txt"), "base\nedited in worktree\nmore\n").expect("edit");
        std::fs::write(dir.join("app.txt"), "something else entirely\n").expect("edit");
        let before = std::fs::read_to_string(dir.join("new.txt")).expect("read");
        assert!(git_worktree_handoff_inner(&state, &store, &made.grant_id).unwrap_err().contains("Nothing was changed"));
        assert_eq!(std::fs::read_to_string(dir.join("app.txt")).expect("kept"), "something else entirely\n");
        assert_eq!(std::fs::read_to_string(dir.join("new.txt")).expect("kept"), before);

        // Only a worktree grant qualifies, and only while its workspace is open.
        assert!(git_worktree_handoff_inner(&state, &store, &grant).unwrap_err().contains("not a worktree"));
        state.grants.lock().unwrap().remove(&grant);
        assert!(git_worktree_handoff_inner(&state, &store, &made.grant_id).unwrap_err().contains("not open"));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn git_worktree_removal_keeps_a_branch_with_its_own_commits() {
        let (state, grant, dir, store) = worktree_fixture("commits");
        run_git(&dir, &["branch", "release"]).expect("branch");
        let made = git_worktree_create_inner(&state, &store, &grant, Some("release")).expect("create");
        assert_eq!(made.base, "release");
        let root = PathBuf::from(&made.path);
        std::fs::write(root.join("work.txt"), "work\n").expect("edit");
        commit_all(&root, "work");
        let gone = git_worktree_remove_inner(&state, &store, &made.grant_id).expect("remove");
        assert!(gone.branch_kept && !root.exists());
        assert!(run_git(&dir, &["rev-parse", "--verify", &format!("refs/heads/{}", made.branch)]).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn git_worktree_create_refuses_what_it_cannot_isolate() {
        let (state, grant, dir, store) = worktree_fixture("refuse");
        for base in ["--detach", "missing-branch", "a\nb"] {
            assert!(git_worktree_create_inner(&state, &store, &grant, Some(base)).is_err(), "{base:?}");
        }
        // A grant on a subfolder must not become a checkout of the whole repository.
        std::fs::create_dir_all(dir.join("pkg")).expect("fixture");
        let nested = mint_grant_id();
        state.grants.lock().unwrap().insert(nested.clone(), dir.join("pkg").canonicalize().expect("canon"));
        assert!(git_worktree_create_inner(&state, &store, &nested, None).unwrap_err().contains("repository root"));
        // Worktrees do not nest, and unknown grants fail closed.
        let made = git_worktree_create_inner(&state, &store, &grant, None).expect("create");
        assert!(git_worktree_create_inner(&state, &store, &made.grant_id, None).is_err());
        assert!(git_worktree_create_inner(&state, &store, "wg-00000000000000000000000000000000", None).is_err());
        assert_eq!(std::fs::read_dir(worktrees::repo_store(&store, &dir.canonicalize().expect("canon"))).expect("store").count(), 1, "refusals leave nothing behind");

        let (plain_state, plain, plain_dir) = fixture_plain_dir("worktree-plain");
        assert!(git_worktree_create_inner(&plain_state, &store, &plain, None).unwrap_err().contains("Git repository"));
        let (unborn_state, unborn, unborn_dir) = fixture_repo("worktree-unborn");
        assert!(git_worktree_create_inner(&unborn_state, &store, &unborn, None).unwrap_err().contains("Commit at least once"));
        for path in [&dir, &store, &plain_dir, &unborn_dir] {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn git_worktree_remove_never_deletes_an_opened_folder() {
        let (state, grant, dir, store) = worktree_fixture("opened");
        assert!(git_worktree_remove_inner(&state, &store, &grant).unwrap_err().contains("not a worktree"));
        // A folder merely inside the store, but not at a worktree's depth, does not qualify either.
        let loose = mint_grant_id();
        state.grants.lock().unwrap().insert(loose.clone(), store.clone());
        assert!(git_worktree_remove_inner(&state, &store, &loose).is_err());
        assert!(git_worktree_remove_inner(&state, &store, "../../etc").is_err());
        assert!(dir.join("app.txt").exists() && store.exists() && grant_root(&state, &grant).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&store);
    }

    #[test]
    fn revoking_a_workspace_revokes_its_worktrees_and_keeps_unsaved_work() {
        let (state, grant, dir, store) = worktree_fixture("revoke");
        let clean = git_worktree_create_inner(&state, &store, &grant, None).expect("create");
        let dirty = git_worktree_create_inner(&state, &store, &grant, None).expect("create");
        std::fs::write(Path::new(&dirty.path).join("draft.txt"), "unsaved\n").expect("edit");
        let (other_state, other, other_dir, _) = worktree_fixture("revoke-other");
        drop(other_state);
        state.grants.lock().unwrap().insert(other.clone(), other_dir.canonicalize().expect("canon"));
        let kept = git_worktree_create_inner(&state, &store, &other, None).expect("create");

        let mut revoked = revoke_grant(&state, std::slice::from_ref(&store), &grant).expect("revoke");
        revoked.sort();
        let mut expected = vec![grant.clone(), clean.grant_id.clone(), dirty.grant_id.clone()];
        expected.sort();
        assert_eq!(revoked, expected);
        assert!(!Path::new(&clean.path).exists(), "a clean worktree is removed");
        assert_eq!(std::fs::read_to_string(Path::new(&dirty.path).join("draft.txt")).expect("kept"), "unsaved\n");
        // Another repository's worktree and grant are untouched.
        assert!(grant_root(&state, &kept.grant_id).is_ok() && grant_root(&state, &other).is_ok());
        assert!(grant_root(&state, &dirty.grant_id).is_err() && dir.join("app.txt").exists());
        for path in [&dir, &store, &other_dir] {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    #[test]
    fn worktrees_left_in_the_muse_code_store_keep_working() {
        let (state, grant, dir, store) = worktree_fixture("legacy");
        let old_data = std::env::temp_dir().join(format!("glitter-legacy-data-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(old_data.join("worktrees")).expect("store");
        let legacy = old_data.join("worktrees").canonicalize().expect("canon");
        // Made before the rename: it lives in the old app's data folder.
        let old = git_worktree_create_inner(&state, &legacy, &grant, None).expect("create");
        let older = git_worktree_create_inner(&state, &legacy, &grant, None).expect("create");
        let new = git_worktree_create_inner(&state, &store, &grant, None).expect("create");

        assert_eq!(git_worktree_handoff_inner(&state, &legacy, &old.grant_id).expect("handoff").files, 0);
        assert!(git_worktree_create_inner(&state, &legacy, &old.grant_id, None).is_err(), "a legacy worktree is not a workspace");
        git_worktree_remove_inner(&state, &legacy, &old.grant_id).expect("remove");
        assert!(!Path::new(&old.path).exists());

        // Revoking the workspace reaches its worktrees in both stores.
        let mut revoked = revoke_grant(&state, &[store.clone(), legacy.clone()], &grant).expect("revoke");
        revoked.sort();
        let mut expected = vec![grant.clone(), older.grant_id.clone(), new.grant_id.clone()];
        expected.sort();
        assert_eq!(revoked, expected);
        legacy::prune_worktree_store(&legacy);
        assert!(!old_data.exists(), "the emptied legacy store and its data folder are removed");
        for path in [&dir, &store] {
            let _ = std::fs::remove_dir_all(path);
        }
    }

    /// A granted folder that is not a repository (for non-repo snapshots and
    /// `git init` coverage).
    fn fixture_plain_dir(tag: &str) -> (AppState, String, PathBuf) {
        let dir = std::env::temp_dir().join(format!("muse-review-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        let state = AppState::new();
        let id = mint_grant_id();
        state.grants.lock().unwrap().insert(id.clone(), dir.canonicalize().expect("canon"));
        (state, id, dir)
    }

    #[test]
    fn git_review_plain_folder_is_a_non_repo_not_an_error() {
        let (_state, _grant, dir) = fixture_plain_dir("nonrepo");
        std::fs::write(dir.join("notes.txt"), "hello\n").expect("fixture");
        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");
        assert!(!snap.repository, "a plain folder is reviewable, not an error");
        assert!(snap.branch.is_empty());
        assert!(!snap.dirty);
        assert!(snap.files.is_empty());
        assert!(snap.diff.is_empty());
        assert!(!snap.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_init_creates_a_repo_without_touching_files() {
        let (state, grant, dir) = fixture_plain_dir("init");
        std::fs::write(dir.join("notes.txt"), "precious\n").expect("fixture");

        let snap = git_init_inner(&state, &grant).expect("init");

        assert!(snap.repository);
        assert_eq!(std::fs::read_to_string(dir.join("notes.txt")).expect("read"), "precious\n");
        // `git init` alone: an unborn HEAD, no commits, and the existing file
        // is simply untracked rather than staged or committed.
        assert!(run_git(&dir, &["rev-parse", "--verify", "HEAD"]).is_err());
        let loose = snap.files.iter().find(|file| file.path == "notes.txt").expect("file listed");
        assert_eq!(loose.status, "??");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_init_rejects_unknown_grants() {
        let state = AppState::new();
        assert!(git_init_inner(&state, "wg-00000000000000000000000000000000").is_err());
        assert!(git_init_inner(&state, "../../etc").is_err());
    }

    #[test]
    fn git_review_untracked_files_get_bounded_synthetic_diffs() {
        let (_state, _grant, dir) = fixture_repo("previews");
        std::fs::write(dir.join("tracked.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::create_dir_all(dir.join("docs")).expect("fixture");
        std::fs::write(dir.join("docs/note.md"), "# Notes\ncafé\n").expect("fixture");
        std::fs::write(dir.join("spaced name.txt"), "with space\n").expect("fixture");
        std::fs::write(dir.join("caf\u{e9}.md"), "accent\n").expect("fixture");
        std::fs::write(dir.join("nonewline.txt"), "no newline").expect("fixture");
        std::fs::write(dir.join("empty.txt"), "").expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        for path in ["docs/note.md", "spaced name.txt", "caf\u{e9}.md", "nonewline.txt", "empty.txt"] {
            let file = snap.files.iter().find(|file| file.path == path).unwrap_or_else(|| panic!("{path} listed"));
            assert_eq!(file.status, "??", "{path}");
            assert_eq!(file.preview_skipped, None, "{path} previews");
        }
        assert!(snap.diff.contains("+++ b/docs/note.md"), "nested path: {}", snap.diff);
        assert!(snap.diff.contains("+++ b/spaced name.txt"), "spaces survive unquoted");
        // Non-ASCII quotes like core.quotePath: octal-escaped inside quotes.
        assert!(snap.diff.contains("\"b/caf\\303\\251.md\""), "non-ASCII path quoted: {}", snap.diff);
        assert!(snap.diff.contains("caf\u{e9}\n"), "multibyte content intact");
        assert!(snap.diff.contains("\\ No newline at end of file"), "no-final-newline marker");
        // An empty file produces a header-only patch: no hunk at all.
        let empty_patch = snap.diff.split("+++ b/empty.txt").nth(1).expect("empty patch");
        assert!(!empty_patch.lines().next().unwrap_or_default().starts_with("@@"), "empty file has no hunk");
        // Whole-file counts are real, not faked.
        let nested = snap.files.iter().find(|file| file.path == "docs/note.md").expect("row");
        assert_eq!((nested.added, nested.removed), (2, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_ignored_files_never_appear() {
        let (_state, _grant, dir) = fixture_repo("ignored");
        std::fs::write(dir.join(".gitignore"), "ignored.log\n").expect("fixture");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("ignored.log"), "secret\n").expect("fixture");
        std::fs::write(dir.join("seen.txt"), "shown\n").expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert!(snap.files.iter().any(|file| file.path == "seen.txt"));
        assert!(!snap.files.iter().any(|file| file.path == "ignored.log"), "ignored files excluded: {:?}", snap.files);
        assert!(!snap.diff.contains("secret"), "ignored content is never read into the diff");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_unpreviewable_files_are_flagged_honestly() {
        let (_state, _grant, dir) = fixture_repo("skipped");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 159, 146, 150]).expect("fixture");
        std::fs::write(dir.join("huge.txt"), "x".repeat(UNTRACKED_PREVIEW_BYTES + 16)).expect("fixture");
        #[cfg(unix)]
        {
            let outside = std::env::temp_dir().join(format!("muse-review-outside-{}", std::process::id()));
            std::fs::write(&outside, "sibling-secret\n").expect("fixture");
            std::os::unix::fs::symlink(&outside, dir.join("link")).expect("symlink");
        }

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        let binary = snap.files.iter().find(|file| file.path == "blob.bin").expect("binary listed");
        assert_eq!(binary.preview_skipped.as_deref(), Some("binary"));
        let huge = snap.files.iter().find(|file| file.path == "huge.txt").expect("large listed");
        assert_eq!(huge.preview_skipped.as_deref(), Some("tooLarge"));
        assert_eq!(huge.added, 0, "a partial read never fakes a whole-file count");
        #[cfg(unix)]
        {
            let link = snap.files.iter().find(|file| file.path == "link").expect("symlink listed");
            assert_eq!(link.preview_skipped.as_deref(), Some("unsupported"), "symlinks are skipped, not followed");
            assert!(!snap.diff.contains("sibling-secret"), "the target is never read");
            let _ = std::fs::remove_file(std::env::temp_dir().join(format!("muse-review-outside-{}", std::process::id())));
        }
        assert!(!snap.diff.contains("\u{0}"), "binary content never reaches the diff");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_preview_count_and_budget_are_capped() {
        let (_state, _grant, dir) = fixture_repo("capped");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        for index in 0..UNTRACKED_PREVIEW_COUNT + 5 {
            std::fs::write(dir.join(format!("f{index:03}.txt")), "line\n").expect("fixture");
        }

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        let previewed = snap.files.iter().filter(|file| file.preview_skipped.is_none() && file.status == "??").count();
        let capped = snap.files.iter().filter(|file| file.preview_skipped.as_deref() == Some("limit")).count();
        assert_eq!(previewed, UNTRACKED_PREVIEW_COUNT, "at most the preview cap produces diffs");
        assert_eq!(capped, 5, "the overflow is honestly flagged");
        assert!(snap.diff.len() <= DIFF_LIMIT + 64, "the total diff stays bounded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_status_columns_keep_the_stage_side() {
        let (_state, _grant, dir) = fixture_repo("columns");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        std::fs::write(dir.join("c.txt"), "staged\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("fixture");
        std::fs::write(dir.join("c.txt"), "re-staged\n").expect("fixture");
        run_git(&dir, &["add", "c.txt"]).expect("stage");
        std::fs::write(dir.join("b.txt"), "new staged\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert_eq!(snap.files.iter().find(|file| file.path == "a.txt").map(|file| file.status.as_str()), Some(" M"), "unstaged edits stay unstaged");
        assert_eq!(snap.files.iter().find(|file| file.path == "c.txt").map(|file| file.status.as_str()), Some("M "), "staged edits read as staged");
        assert_eq!(snap.files.iter().find(|file| file.path == "b.txt").map(|file| file.status.as_str()), Some("A "), "staged-new reads as added");
        // Direct parse coverage so a regression is caught even without git.
        let parsed = parse_porcelain_z(" M a.txt\0M  c.txt\0?? d.txt\0");
        assert_eq!(parsed, vec![("a.txt".to_string(), " M".to_string()), ("c.txt".to_string(), "M ".to_string()), ("d.txt".to_string(), "??".to_string())]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_snapshot_never_touches_the_index() {
        let (_state, _grant, dir) = fixture_repo("readonly");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("a.txt"), "edited\n").expect("fixture");
        std::fs::write(dir.join("b.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "b.txt"]).expect("stage");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");
        let index = dir.join(".git/index");
        let before = std::fs::read(&index).expect("index bytes");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert_eq!(std::fs::read(&index).expect("index bytes"), before, "a read must never write the index");
        assert!(!dir.join(".git/index.lock").exists(), "no lock may be left behind");
        assert!(snap.dirty);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_nested_grant_cannot_reveal_siblings() {
        let dir = std::env::temp_dir().join(format!("muse-review-nested-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("granted/inner")).expect("fixture");
        run_git(&dir, &["init", "-q"]).expect("init");
        run_git(&dir, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&dir, &["config", "user.name", "Test"]).expect("config");
        run_git(&dir, &["config", "commit.gpgsign", "false"]).expect("config");
        std::fs::write(dir.join("granted/inner/mine.txt"), "one\n").expect("fixture");
        std::fs::write(dir.join("sibling.txt"), "sibling one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("granted/inner/mine.txt"), "edited\n").expect("fixture");
        std::fs::write(dir.join("sibling.txt"), "sibling edited\n").expect("fixture");
        std::fs::write(dir.join("sibling-new.txt"), "sibling new\n").expect("fixture");
        std::fs::write(dir.join("granted/inner/child.txt"), "child\n").expect("fixture");
        std::fs::write(dir.join("granted/top.txt"), "top\n").expect("fixture");
        let granted = dir.join("granted/inner").canonicalize().expect("canon");

        let snap = git_snapshot_for(&granted).expect("snapshot");

        assert!(snap.repository);
        let paths: Vec<&str> = snap.files.iter().map(|file| file.path.as_str()).collect();
        assert!(paths.contains(&"mine.txt"), "own changed file: {paths:?}");
        assert!(paths.contains(&"child.txt"), "own untracked file: {paths:?}");
        assert!(!paths.contains(&"top.txt"), "granted scope is the inner dir only: {paths:?}");
        assert!(!paths.iter().any(|path| path.contains("sibling") || path.starts_with("..") || path.contains("granted/")), "no sibling or root paths leak: {paths:?}");
        assert!(snap.diff.contains("b/mine.txt"), "diff paths are cwd-relative: {}", snap.diff);
        assert!(!snap.diff.contains("sibling"), "sibling diffs are never read");
        assert!(snap.diff.contains("+++ b/child.txt"), "untracked preview is scoped too");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_unborn_head_still_reviews_everything() {
        let (_state, _grant, dir) = fixture_repo("unborn");
        std::fs::write(dir.join("staged.txt"), "staged\n").expect("fixture");
        run_git(&dir, &["add", "staged.txt"]).expect("stage");
        std::fs::write(dir.join("loose.txt"), "untracked\n").expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        let staged = snap.files.iter().find(|file| file.path == "staged.txt").expect("staged listed");
        assert_eq!(staged.status, "A ");
        let loose = snap.files.iter().find(|file| file.path == "loose.txt").expect("loose listed");
        assert_eq!(loose.status, "??");
        assert_eq!(loose.preview_skipped, None);
        assert!(snap.diff.contains("+++ b/staged.txt"), "staged-new diff: {}", snap.diff);
        assert!(snap.diff.contains("+++ b/loose.txt"), "untracked preview diff");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_preview_cap_counts_attempts_not_successes() {
        let (_state, _grant, dir) = fixture_repo("attempts");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        // More binary files than the cap, then a text file that could preview:
        // attempts are spent before it is reached.
        for index in 0..UNTRACKED_PREVIEW_COUNT + 5 {
            std::fs::write(dir.join(format!("b{index:03}.bin")), [0u8, 1, 159]).expect("fixture");
        }
        std::fs::write(dir.join("z-text.txt"), "could preview\n").expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        let binaries = snap.files.iter().filter(|file| file.preview_skipped.as_deref() == Some("binary")).count();
        let capped = snap.files.iter().filter(|file| file.preview_skipped.as_deref() == Some("limit")).count();
        assert_eq!(binaries, UNTRACKED_PREVIEW_COUNT, "attempts are capped even when every one is skipped");
        assert_eq!(capped, 6, "the overflow — including a previewable text file — is honestly limited");
        assert_eq!(snap.files.iter().find(|file| file.path == "z-text.txt").map(|file| file.preview_skipped.as_deref()), Some(Some("limit")));
        assert!(snap.truncated);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_preview_marks_executable_and_unusual_names() {
        let (_state, _grant, dir) = fixture_repo("modes");
        std::fs::write(dir.join("a.txt"), "one\n").expect("fixture");
        commit_all(&dir, "one");
        // Invalid UTF-8 without any NUL byte.
        std::fs::write(dir.join("latin.txt"), [0xe9u8, 0x20, 0x62]).expect("fixture");
        // A name that needs quoting.
        std::fs::write(dir.join("say\"hi.txt"), "quoted\n").expect("fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.join("run.sh");
            std::fs::write(&script, "#!/bin/sh\necho hi\n").expect("fixture");
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert_eq!(snap.files.iter().find(|file| file.path == "latin.txt").map(|file| file.preview_skipped.as_deref()), Some(Some("binary")));
        let quoted = snap.files.iter().find(|file| file.path == "say\"hi.txt").expect("quoted file listed");
        assert_eq!(quoted.preview_skipped, None);
        assert!(snap.diff.contains("\"b/say\\\"hi.txt\""), "the name is quoted like git: {}", snap.diff);
        #[cfg(unix)]
        assert!(snap.diff.contains("new file mode 100755"), "executable mode preserved: {}", snap.diff);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_previews_stop_when_the_diff_budget_is_spent() {
        let (_state, _grant, dir) = fixture_repo("budget");
        // A tracked change that eats nearly the whole snapshot budget leaves
        // nothing for untracked previews, which must flag rather than overrun.
        std::fs::write(dir.join("big.txt"), "x".repeat(DIFF_LIMIT - 2048) + "\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("big.txt"), "y".repeat(DIFF_LIMIT - 2048) + "\n").expect("fixture");
        std::fs::write(dir.join("tiny.txt"), "tiny\n").expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert!(snap.truncated);
        assert!(snap.diff.len() <= DIFF_LIMIT + 64);
        assert_eq!(snap.files.iter().find(|file| file.path == "tiny.txt").map(|file| file.preview_skipped.as_deref()), Some(Some("limit")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_diff_ignores_user_color_and_context_config() {
        let dir = std::env::temp_dir().join(format!("muse-review-decor-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture");
        run_git(&dir, &["init", "-q"]).expect("init");
        run_git(&dir, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&dir, &["config", "user.name", "Test"]).expect("config");
        run_git(&dir, &["config", "commit.gpgsign", "false"]).expect("config");
        // A user's decoration and context preferences must not reach the dock:
        // color codes would render as junk and a widened context would merge
        // two hunks the hunk-discard indices count separately.
        run_git(&dir, &["config", "color.ui", "always"]).expect("config");
        run_git(&dir, &["config", "diff.context", "99"]).expect("config");
        run_git(&dir, &["config", "diff.noprefix", "true"]).expect("config");
        let mut text = String::new();
        for line in 1..=30 {
            text.push_str(&format!("line {line}\n"));
        }
        std::fs::write(dir.join("a.txt"), &text).expect("fixture");
        commit_all(&dir, "one");
        let changed = text.replace("line 3\n", "line 3x\n").replace("line 28\n", "line 28x\n");
        std::fs::write(dir.join("a.txt"), &changed).expect("fixture");

        let snap = git_snapshot_for(&dir.canonicalize().expect("canon")).expect("snapshot");

        assert!(!snap.diff.contains('\u{1b}'), "no terminal color may reach the diff");
        assert_eq!(snap.diff.matches("@@ -").count(), 2, "-U3 keeps the two hunks separate despite diff.context=99");
        assert!(snap.diff.contains("--- a/a.txt") && snap.diff.contains("+++ b/a.txt"), "diff.noprefix must not strip a/ b/ markers");
        // The same hunk patch a discard would apply must reverse cleanly in
        // the fixture: only the second hunk reverts, the first stays edited.
        let second = single_hunk_patch(&snap.diff, 1).expect("second hunk patch");
        run_git_stdin(&dir, &["apply", "-R", "--"], &second).expect("apply reverse");
        let contents = std::fs::read_to_string(dir.join("a.txt")).expect("read");
        assert!(contents.contains("line 3x\n"), "first hunk stays edited");
        assert!(contents.contains("line 28\n"), "second hunk reverted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_review_nested_grant_discard_leaves_siblings_untouched() {
        let dir = std::env::temp_dir().join(format!("muse-review-ndiscard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("granted/inner")).expect("fixture");
        run_git(&dir, &["init", "-q"]).expect("init");
        run_git(&dir, &["config", "user.email", "test@example.com"]).expect("config");
        run_git(&dir, &["config", "user.name", "Test"]).expect("config");
        run_git(&dir, &["config", "commit.gpgsign", "false"]).expect("config");
        std::fs::write(dir.join("granted/inner/mine.txt"), "one\n").expect("fixture");
        std::fs::write(dir.join("sibling.txt"), "sibling one\n").expect("fixture");
        commit_all(&dir, "one");
        std::fs::write(dir.join("granted/inner/mine.txt"), "edited\n").expect("fixture");
        std::fs::write(dir.join("sibling.txt"), "sibling edited\n").expect("fixture");
        std::fs::write(dir.join("sibling-new.txt"), "sibling new\n").expect("fixture");
        std::fs::write(dir.join("granted/inner/child.txt"), "child\n").expect("fixture");
        let granted = dir.join("granted/inner").canonicalize().expect("canon");

        // Discard the grant's own tracked edit and its new file.
        let snap = git_discard_files_at(&granted, "wg-test", vec!["mine.txt".to_string(), "child.txt".to_string()]).expect("discard");

        assert!(snap.files.is_empty(), "grant's own discards applied: {:?}", snap.files);
        assert_eq!(std::fs::read_to_string(dir.join("granted/inner/mine.txt")).expect("read"), "one\n");
        assert!(!dir.join("granted/inner/child.txt").exists(), "the untracked child was cleaned");
        // Siblings outside the grant are byte-for-byte untouched.
        assert_eq!(std::fs::read_to_string(dir.join("sibling.txt")).expect("read"), "sibling edited\n");
        assert_eq!(std::fs::read_to_string(dir.join("sibling-new.txt")).expect("read"), "sibling new\n");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
