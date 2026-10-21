//! Executable identity for the SEC-02 trust boundary.
//!
//! Every binary the app spawns — the bridge sidecar, `muse`, and ACP agent
//! CLIs — resolves here: the path is canonicalized (symlinks resolved, so a
//! non-temp symlink to a temp executable cannot bypass the temp check),
//! required to be a regular executable file outside temporary directories,
//! and pinned by SHA-256 digest. A same-path replacement or retarget between
//! spawns fails closed; a first sighting records its digest and proceeds.
//!
//! ACP agents additionally pin across restarts in the OS keyring: the app
//! never silently switches to a newly shadowing PATH entry — an identity
//! change fails the call until the user confirms the new binary.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// In-process digest pins: canonical path -> SHA-256 hex. First sighting
/// records; later spawns re-verify and fail on mismatch.
pub struct ExecPins {
    inner: Mutex<HashMap<PathBuf, String>>,
}

impl ExecPins {
    pub fn new() -> Self {
        ExecPins {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// Record the digest on first sighting, or verify it matches. Fails
    /// closed when the file cannot be read or its bytes changed.
    pub fn check(&self, canonical: &Path, what: &str) -> Result<(), String> {
        let digest = digest_of(canonical)?;
        let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
        match pins.get(canonical) {
            Some(pinned) if pinned == &digest => Ok(()),
            Some(_) => Err(format!("{what} was replaced on disk since it was first used. Restart the app to use the new binary.")),
            None => {
                pins.insert(canonical.to_path_buf(), digest);
                Ok(())
            }
        }
    }
}

/// Test-only record of every file actually read for hashing, so tests can tell
/// a cache hit from a re-hash.
#[cfg(test)]
static HASHED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

/// SHA-256 hex digest of a file, streamed so large binaries stay cheap.
pub fn sha256_file(path: &Path) -> Result<String, String> {
    #[cfg(test)]
    HASHED.lock().expect("hash log").push(path.to_path_buf());
    let file = std::fs::File::open(path).map_err(|_| "That executable is not available.".to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut hash = Sha256::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut chunk).map_err(|_| "That executable could not be read.".to_string())?;
        if read == 0 {
            break;
        }
        hash.update(&chunk[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

/// What the OS says a file is, right now. Two reads that agree on every field
/// describe the same bytes: the inode changes on replacement, the size and
/// mtime on a rewrite, and `ctime` on *anything* that touches the inode —
/// including a `utimes` that puts `mtime` back — and it cannot be set from
/// user space. Off Unix there is no equivalent, so nothing is ever trusted.
#[derive(Clone, PartialEq, Eq)]
struct Fingerprint {
    dev: u64,
    ino: u64,
    len: u64,
    mtime: (i64, i64),
    ctime: (i64, i64),
}

fn fingerprint(path: &Path) -> Option<Fingerprint> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    Some(Fingerprint {
        dev: meta.dev(),
        ino: meta.ino(),
        len: meta.len(),
        mtime: (meta.mtime(), meta.mtime_nsec()),
        ctime: (meta.ctime(), meta.ctime_nsec()),
    })
}

/// A file modified within this window of being hashed is "racy": a later write
/// could land on a timestamp equal to the recorded one (coarse filesystem
/// clocks), so its cached digest is never trusted. Same rule git applies to
/// its own stat cache.
const RACY_WINDOW: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct CachedDigest {
    print: Fingerprint,
    digest: String,
}

fn digest_cache() -> &'static Mutex<HashMap<PathBuf, CachedDigest>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedDigest>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn settled(print: &Fingerprint, window: Duration) -> bool {
    let newest = print.mtime.max(print.ctime);
    let Ok(now) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) else {
        return false;
    };
    let Ok(modified) = u64::try_from(newest.0) else {
        return false;
    };
    now.as_secs().saturating_sub(modified) >= window.as_secs()
}

/// SHA-256 of a file's *current* bytes, without re-reading a large executable
/// on every call. The digest is reused only while the file's fingerprint is
/// unchanged and old enough to be trusted; any doubt falls through to a real
/// hash, so a replaced binary is still caught on the very next check.
///
/// Every bridge request that names a third-party agent used to hash that
/// agent's whole binary (100+ MB) twice, on the UI thread.
pub fn digest_of(path: &Path) -> Result<String, String> {
    digest_with_window(path, RACY_WINDOW)
}

fn digest_with_window(path: &Path, window: Duration) -> Result<String, String> {
    let before = fingerprint(path);
    if let Some(print) = &before {
        let hit = digest_cache().lock().ok().and_then(|cache| cache.get(path).cloned());
        if let Some(hit) = hit {
            if &hit.print == print {
                return Ok(hit.digest);
            }
        }
    }
    let digest = sha256_file(path)?;
    // Only remember a digest for a file that neither changed while it was
    // being read nor was modified so recently that a later write could hide.
    if let (Some(before), Some(after)) = (before, fingerprint(path)) {
        if before == after && settled(&before, window) {
            if let Ok(mut cache) = digest_cache().lock() {
                cache.insert(
                    path.to_path_buf(),
                    CachedDigest {
                        print: before,
                        digest: digest.clone(),
                    },
                );
            }
        }
    }
    Ok(digest)
}

fn in_temp_dir(canonical: &Path) -> bool {
    let lowered = canonical.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    lowered.starts_with("/tmp/") || lowered.starts_with("/var/tmp/") || lowered.starts_with("/private/tmp/") || lowered.contains("/appdata/local/temp/") || std::env::temp_dir().canonicalize().is_ok_and(|tmp| canonical.starts_with(tmp))
}

fn has_exec_bit(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
}

/// Canonicalize `raw`, require a regular executable file outside temporary
/// directories whose file name satisfies `allowed_name`, and return the
/// canonical path. All checks run against the canonical target, so a symlink
/// cannot smuggle a temp or misnamed executable past validation.
pub fn validate_exec(raw: &str, allowed_name: &dyn Fn(&str) -> bool, what: &str) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err(format!("{what} is not available."));
    }
    let canonical = PathBuf::from(raw).canonicalize().map_err(|_| format!("{what} is not available."))?;
    if in_temp_dir(&canonical) {
        return Err(format!("{what} must live outside temporary directories."));
    }
    let name = canonical.file_name().and_then(|name| name.to_str()).unwrap_or("");
    if !allowed_name(name) {
        return Err(format!("{what} has an unexpected file name."));
    }
    let meta = std::fs::symlink_metadata(&canonical).map_err(|_| format!("{what} is not available."))?;
    if !meta.is_file() || !has_exec_bit(&canonical) {
        return Err(format!("{what} is not an executable file."));
    }
    Ok(canonical)
}

pub fn muse_name_allowed(name: &str) -> bool {
    name == "muse" || name.starts_with("muse-bin-")
}

/// Agent binaries from `agents.ts`, mirrored natively so resolution never
/// trusts the bridge's PATH walk: (agent id, display name, binary names,
/// extra install dirs under $HOME).
pub struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub bins: &'static [&'static str],
    pub dirs: &'static [&'static str],
}

pub const AGENTS: &[AgentSpec] = &[
    AgentSpec {
        id: "muse",
        name: "Muse",
        bins: &["muse"],
        dirs: &[],
    },
    AgentSpec {
        id: "opencode",
        name: "OpenCode",
        bins: &["opencode"],
        dirs: &[".opencode/bin"],
    },
    AgentSpec {
        id: "grok",
        name: "Grok",
        bins: &["grok"],
        dirs: &[".grok/bin"],
    },
    AgentSpec {
        id: "gemini",
        name: "Gemini CLI",
        bins: &["gemini"],
        dirs: &[],
    },
    AgentSpec {
        id: "qwen",
        name: "Qwen Code",
        bins: &["qwen"],
        dirs: &[],
    },
    AgentSpec {
        id: "goose",
        name: "Goose",
        bins: &["goose"],
        dirs: &[],
    },
    AgentSpec {
        id: "cline",
        name: "Cline CLI",
        bins: &["cline"],
        dirs: &[],
    },
];

pub fn agent_spec(id: &str) -> Option<&'static AgentSpec> {
    AGENTS.iter().find(|spec| spec.id == id)
}

fn agent_search_dirs(spec: &AgentSpec) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for extra in spec.dirs {
            dirs.push(home.join(extra));
        }
        for common in [".local/bin", ".bun/bin", ".npm-global/bin", ".volta/bin", ".asdf/shims", ".nvm/current/bin"] {
            dirs.push(home.join(common));
        }
    }
    for well_known in ["/opt/homebrew/bin", "/usr/local/bin"] {
        dirs.push(PathBuf::from(well_known));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs
}

/// Canonical names a resolved agent binary may carry. Vendor installers keep
/// versioned downloads behind a stable symlink (`grok` -> `downloads/
/// grok-1.0.40-macos-aarch64`), so a `-`-suffixed variant of a launch name is
/// still the agent — but `grokhelper` or a foreign target stays rejected.
fn agent_name_allowed<'a>(names: &'a [String]) -> impl Fn(&str) -> bool + 'a {
    move |file| names.iter().any(|allowed| file.strip_prefix(allowed.as_str()).is_some_and(|rest| rest.is_empty() || rest.starts_with('-')))
}

/// Resolve an ACP agent binary exactly like the bridge does (extra dirs, then
/// well-known dirs, then PATH), and validate the winner. Returns the canonical
/// path; shadowing entries never surface without going through identity check.
pub fn resolve_agent_bin(spec: &AgentSpec) -> Result<PathBuf, String> {
    let names: Vec<String> = spec.bins.iter().map(|bin| bin.to_string()).collect();
    for dir in agent_search_dirs(spec) {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                let what = format!("The {} CLI", spec.name);
                let is_bin = agent_name_allowed(&names);
                return validate_exec(&candidate.to_string_lossy(), &is_bin, &what);
            }
        }
    }
    Err(format!("{} is not installed. Install it, then choose Rescan.", spec.name))
}

/// Run `bin --version` with a bounded wait and a minimal environment; a hung
/// binary is killed and reports no version instead of hanging the caller. The
/// probe runs before an agent's identity pin is confirmed, so the unverified
/// binary must never see the ambient desktop environment (SEC-03).
pub fn probe_version(bin: &Path) -> Option<String> {
    let mut cmd = std::process::Command::new(bin);
    crate::process::apply_minimal_env(&mut cmd);
    let mut child = cmd.arg("--version").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().ok()?;
    let mut waited = 0;
    let output = loop {
        match child.try_wait() {
            Ok(Some(_)) => break child.wait_with_output().ok()?,
            Ok(None) => {
                waited += 1;
                if waited >= 30 {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return None,
        }
    };
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(160).collect())
}

/// How long a failed (or timed-out) `--version` probe is remembered. A binary
/// that answered once keeps its answer for as long as its bytes are unchanged.
const FAILED_PROBE_TTL: Duration = Duration::from_secs(60);

struct ProbedVersion {
    digest: String,
    version: Option<String>,
    probed_at: Instant,
}

fn version_cache() -> &'static Mutex<HashMap<PathBuf, ProbedVersion>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, ProbedVersion>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `probe_version`, remembered per binary identity. The probe *spawns the
/// agent* and polls its exit in 100 ms steps, so repeating it for every bridge
/// request cost at least a tenth of a second each time; a binary whose digest
/// has not changed cannot report a different version.
pub fn probe_version_cached(bin: &Path) -> Option<String> {
    let digest = digest_of(bin).ok()?;
    if let Ok(cache) = version_cache().lock() {
        if let Some(hit) = cache.get(bin) {
            if hit.digest == digest && (hit.version.is_some() || hit.probed_at.elapsed() < FAILED_PROBE_TTL) {
                return hit.version.clone();
            }
        }
    }
    let version = probe_version(bin);
    if let Ok(mut cache) = version_cache().lock() {
        cache.insert(
            bin.to_path_buf(),
            ProbedVersion {
                digest,
                version: version.clone(),
                probed_at: Instant::now(),
            },
        );
    }
    version
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPin {
    pub path: String,
    pub version: Option<String>,
    pub sha256: String,
    /// Developer team whose valid code signature the pinned binary carries
    /// (macOS). A later binary signed by the same team is the vendor's own
    /// update and is re-pinned without asking; see `AgentPins::check`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
}

/// What `AgentPins::check` did with a resolved binary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinCheck {
    /// Same path and bytes as the pin; nothing to persist.
    Same,
    /// First sighting, a refreshed display version, or a newly learned team.
    Recorded,
    /// The vendor updated the agent: path or bytes changed, and both the old
    /// and the new binary carry a valid signature from the same team.
    VendorUpdate { from: String, team: String },
}

impl PinCheck {
    /// Whether the stored pins changed and should be persisted.
    pub fn changed(&self) -> bool {
        !matches!(self, PinCheck::Same)
    }
}

/// The developer team of a binary whose code signature verifies, or `None`
/// for an unsigned, ad-hoc or broken signature. Agent CLIs update themselves
/// into a new versioned path (Grok's `downloads/grok-<version>`, a Homebrew
/// `Cellar/<formula>/<version>`), so a path-and-digest pin alone broke on
/// every vendor update. Only the system `codesign` is run, with a bounded wait.
#[cfg(target_os = "macos")]
pub fn signing_team(path: &Path) -> Option<String> {
    let run = |args: &[&str]| -> Option<std::process::Output> {
        let mut child = std::process::Command::new("/usr/bin/codesign")
            .args(args)
            .arg(path)
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .ok()?;
        for _ in 0..100 {
            match child.try_wait() {
                Ok(Some(_)) => return child.wait_with_output().ok(),
                Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                Err(_) => return None,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        None
    };
    // `--verify --strict` fails for any modification after signing.
    if !run(&["--verify", "--strict"])?.status.success() {
        return None;
    }
    let details = run(&["-dv", "--verbose=2"])?;
    let text = String::from_utf8_lossy(&details.stderr);
    let team = text.lines().find_map(|line| line.strip_prefix("TeamIdentifier="))?.trim();
    // Ad-hoc signatures report "not set"; a real team id is ten alphanumerics.
    (team.len() == 10 && team.chars().all(|ch| ch.is_ascii_alphanumeric())).then(|| team.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn signing_team(_path: &Path) -> Option<String> {
    None
}

/// The Apple developer team that publishes each verified agent. A pin recorded
/// before teams were stored has nothing to compare against once the vendor's
/// updater deletes the old binary (Grok keeps only the last two versions); the
/// publisher's own team stands in for it then.
pub fn vendor_team(agent_id: &str) -> Option<&'static str> {
    match agent_id {
        "grok" => Some("5Y6N3AJ54S"),
        "opencode" => Some("5NZ4Q7NXJ4"),
        _ => None,
    }
}

struct CachedTeam {
    print: Fingerprint,
    team: Option<String>,
}

fn team_cache() -> &'static Mutex<HashMap<PathBuf, CachedTeam>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedTeam>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `signing_team`, remembered while the file's fingerprint is unchanged and
/// settled, like `digest_of`: the check runs on every request naming an agent.
pub fn signing_team_cached(path: &Path) -> Option<String> {
    let print = fingerprint(path);
    if let Some(print) = &print {
        if let Some(hit) = team_cache().lock().ok().and_then(|cache| cache.get(path).map(|hit| (hit.print == *print, hit.team.clone()))) {
            if hit.0 {
                return hit.1;
            }
        }
    }
    let team = signing_team(path);
    if let (Some(before), Some(after)) = (print, fingerprint(path)) {
        if before == after && settled(&before, RACY_WINDOW) {
            if let Ok(mut cache) = team_cache().lock() {
                cache.insert(path.to_path_buf(), CachedTeam { print: before, team: team.clone() });
            }
        }
    }
    team
}

/// Cross-restart ACP identity pins, persisted in the OS keyring next to the
/// workspace grants (renderer-readable, never renderer-writable).
pub struct AgentPins {
    inner: Mutex<HashMap<String, AgentPin>>,
}

impl AgentPins {
    pub fn new(pins: HashMap<String, AgentPin>) -> Self {
        AgentPins {
            inner: Mutex::new(pins),
        }
    }

    pub fn snapshot(&self) -> HashMap<String, AgentPin> {
        self.inner.lock().map(|pins| pins.clone()).unwrap_or_default()
    }

    /// Bulk-load persisted pins at startup.
    pub fn replace(&self, pins: HashMap<String, AgentPin>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = pins;
        }
    }

    /// Check a freshly resolved binary against its pin. First sighting
    /// records and proceeds. A path or digest change is accepted as a vendor
    /// update when the new binary and the pinned one carry valid signatures
    /// from the same developer team; any other change fails until confirmed.
    /// The result says whether the stored pins changed, so callers persist
    /// only when there is something new.
    pub fn check(&self, agent_id: &str, canonical: &Path, version: Option<String>) -> Result<PinCheck, String> {
        self.check_with(agent_id, canonical, version, &signing_team_cached)
    }

    /// `check`, with the signature lookup supplied (tests use fixtures).
    pub fn check_with(&self, agent_id: &str, canonical: &Path, version: Option<String>, team_of: &dyn Fn(&Path) -> Option<String>) -> Result<PinCheck, String> {
        let digest = digest_of(canonical)?;
        let path = canonical.to_string_lossy().into_owned();
        // Read the pin, then release the lock: the signature lookup spawns
        // `codesign` and must not block other checks while it runs.
        let pinned = self.get(agent_id);
        let outcome = match &pinned {
            None => PinCheck::Recorded,
            Some(pin) if pin.path == path && pin.sha256 == digest => {
                if pin.version != version || (pin.team.is_none() && team_of(canonical).is_some()) {
                    PinCheck::Recorded
                } else {
                    PinCheck::Same
                }
            }
            Some(pin) => {
                let team = team_of(canonical).ok_or_else(|| identity_changed(agent_id, &pin.path, &path))?;
                // A pin made before teams were recorded still holds the old
                // binary's digest: if that file is untouched, its signature
                // stands in for the missing team.
                let pinned_team = pin.team.clone().or_else(|| {
                    let old = Path::new(&pin.path);
                    (digest_of(old).ok().as_deref() == Some(pin.sha256.as_str())).then(|| team_of(old)).flatten()
                }).or_else(|| vendor_team(agent_id).map(str::to_string));
                if pinned_team.as_deref() != Some(team.as_str()) {
                    return Err(identity_changed(agent_id, &pin.path, &path));
                }
                PinCheck::VendorUpdate { from: pin.path.clone(), team }
            }
        };
        if outcome.changed() {
            let team = match &outcome {
                PinCheck::VendorUpdate { team, .. } => Some(team.clone()),
                _ => team_of(canonical),
            };
            let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
            pins.insert(agent_id.to_string(), AgentPin { path, version, sha256: digest, team });
        }
        Ok(outcome)
    }

    /// Record a user-confirmed binary. The caller must have resolved `path`
    /// itself — the renderer can confirm, never nominate.
    pub fn confirm(&self, agent_id: &str, canonical: &Path, version: Option<String>) -> Result<(), String> {
        let digest = digest_of(canonical)?;
        let team = signing_team_cached(canonical);
        let mut pins = self.inner.lock().map_err(|err| err.to_string())?;
        pins.insert(
            agent_id.to_string(),
            AgentPin {
                path: canonical.to_string_lossy().into_owned(),
                version,
                sha256: digest,
                team,
            },
        );
        Ok(())
    }

    pub fn get(&self, agent_id: &str) -> Option<AgentPin> {
        self.inner.lock().ok()?.get(agent_id).cloned()
    }
}

/// Machine-detectable prefix: the renderer matches `Agent identity changed`
/// to offer the confirm-and-retry flow.
fn identity_changed(agent_id: &str, old: &str, new: &str) -> String {
    let short = |path: &str| {
        let home = dirs::home_dir().map(|home| home.to_string_lossy().into_owned()).unwrap_or_default();
        let rel = if !home.is_empty() {
            path.strip_prefix(&home).map(|rest| format!("~{rest}")).unwrap_or_else(|| path.to_string())
        } else {
            path.to_string()
        };
        rel.chars().take(160).collect::<String>()
    };
    let name = agent_spec(agent_id).map(|spec| spec.name).unwrap_or(agent_id);
    format!("Agent identity changed: {} moved from {} to {}. Confirm the new binary in Settings to continue.", name, short(old), short(new))
}

pub fn parse_agent_pins(raw: &str) -> HashMap<String, AgentPin> {
    serde_json::from_str::<HashMap<String, AgentPin>>(raw).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("muse-exec-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    fn write_exec(path: &Path, body: &[u8]) {
        std::fs::write(path, body).expect("fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }

    /// Non-temp scratch space (unit tests run with the package root as cwd,
    /// so `target/` is writable and outside every temp prefix). Absolute, so
    /// symlinks created inside resolve to real targets.
    fn workdir(tag: &str) -> PathBuf {
        let dir = std::env::current_dir().expect("cwd").join("target").join(format!("muse-exec-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[test]
    fn temp_symlink_cannot_smuggle_a_binary() {
        // The SEC-02 bypass: the link lives outside temp and is named `muse`,
        // but its canonical target is a temp executable.
        let work = workdir("link");
        let target = std::env::temp_dir().join(format!("muse-smuggled-{}", std::process::id()));
        write_exec(&target, b"#!/bin/sh\necho hi\n");
        let link = work.join("muse");
        symlink(&target, &link);
        assert!(validate_exec(&link.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        // A directly named temp binary is rejected too.
        assert!(validate_exec(&target.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn canonical_target_decides_the_name_check() {
        let work = workdir("name");
        // Misnamed canonical target behind an innocent link name: rejected.
        let evil = work.join("evil.sh");
        write_exec(&evil, b"#!/bin/sh\necho hi\n");
        let link = work.join("muse-link");
        symlink(&evil, &link);
        assert!(link.read_link().is_ok());
        assert!(validate_exec(&link.to_string_lossy(), &muse_name_allowed, "Muse").is_err());
        // Well-named canonical target behind any link name: accepted.
        let real = work.join("muse");
        write_exec(&real, b"#!/bin/sh\necho hi\n");
        let alias = work.join("totally-not-muse");
        symlink(&real, &alias);
        assert!(validate_exec(&alias.to_string_lossy(), &muse_name_allowed, "Muse").is_ok());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn agent_links_may_resolve_to_versioned_downloads() {
        // Vendor layout: ~/.grok/bin/grok -> ../downloads/grok-<ver>-<platform>.
        let work = workdir("agent-versioned");
        let names = vec!["grok".to_string()];
        let target = work.join("grok-1.0.40-macos-aarch64");
        write_exec(&target, b"#!/bin/sh\necho hi\n");
        let link = work.join("grok");
        symlink(&target, &link);
        assert!(validate_exec(&link.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_ok());
        // A same-prefix foreign name and a foreign target still fail.
        let helper = work.join("grokhelper");
        write_exec(&helper, b"#!/bin/sh\necho hi\n");
        let alias = work.join("grok-alias");
        symlink(&helper, &alias);
        assert!(validate_exec(&helper.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_err());
        assert!(validate_exec(&alias.to_string_lossy(), &agent_name_allowed(&names), "The Grok CLI").is_err());
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn non_files_and_non_executables_are_rejected() {
        let dir = fixture("somedir");
        let _ = std::fs::create_dir_all(&dir);
        assert!(validate_exec(&dir.to_string_lossy(), &|_| true, "Thing").is_err());
        let plain = fixture("plain.txt");
        std::fs::write(&plain, b"nope").expect("fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).expect("chmod");
            assert!(validate_exec(&plain.to_string_lossy(), &|_| true, "Thing").is_err());
        }
        assert!(validate_exec("", &|_| true, "Thing").is_err());
        assert!(validate_exec("/definitely/not/here-12345", &|_| true, "Thing").is_err());
        let _ = std::fs::remove_file(&plain);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn digest_pins_detect_replacement() {
        let bin = fixture("pinned-bin");
        write_exec(&bin, b"version one");
        let canon = bin.canonicalize().expect("canon");
        let pins = ExecPins::new();
        assert!(pins.check(&canon, "Thing").is_ok());
        assert!(pins.check(&canon, "Thing").is_ok());
        write_exec(&bin, b"version two!!");
        let err = pins.check(&canon, "Thing").unwrap_err();
        assert!(err.contains("replaced"), "{err}");
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn sha256_matches_known_vector() {
        let file = fixture("vector.txt");
        std::fs::write(&file, b"abc").expect("fixture");
        assert_eq!(sha256_file(&file).expect("digest"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn agent_pins_record_first_sighting_and_flag_changes() {
        let one = fixture("agent-one");
        let two = fixture("agent-two");
        write_exec(&one, b"one");
        write_exec(&two, b"two");
        let pins = AgentPins::new(HashMap::new());
        let canon_one = one.canonicalize().expect("canon");
        assert!(pins.check("opencode", &canon_one, Some("1.0".into())).is_ok());
        // Same binary again: fine, version refreshes.
        assert!(pins.check("opencode", &canon_one, Some("1.1".into())).is_ok());
        assert_eq!(pins.get("opencode").and_then(|pin| pin.version), Some("1.1".into()));
        // A newly shadowing entry (different path) fails with the detectable prefix.
        let canon_two = two.canonicalize().expect("canon");
        let err = pins.check("opencode", &canon_two, Some("1.1".into())).unwrap_err();
        assert!(err.starts_with("Agent identity changed"), "{err}");
        // Same path, replaced bytes: also flagged.
        write_exec(&one, b"one!!!");
        let err = pins.check("opencode", &canon_one, Some("1.1".into())).unwrap_err();
        assert!(err.starts_with("Agent identity changed"), "{err}");
        // Confirming the resolver's binary re-pins and proceeds.
        pins.confirm("opencode", &canon_two, Some("2.0".into())).expect("confirm");
        assert!(pins.check("opencode", &canon_two, Some("2.0".into())).is_ok());
        let _ = std::fs::remove_file(&one);
        let _ = std::fs::remove_file(&two);
    }

    fn times_hashed(path: &Path) -> usize {
        HASHED.lock().expect("hash log").iter().filter(|hashed| hashed.as_path() == path).count()
    }

    #[test]
    fn unchanged_files_are_hashed_once_and_replacements_are_still_caught() {
        let bin = fixture("cached-bin");
        write_exec(&bin, b"version one");
        let canon = bin.canonicalize().expect("canon");
        // A zero window trusts a file the moment it is written.
        let first = digest_with_window(&canon, Duration::ZERO).expect("digest");
        let again = digest_with_window(&canon, Duration::ZERO).expect("digest");
        assert_eq!(first, again);
        assert_eq!(
            times_hashed(&canon),
            if cfg!(unix) {
                1
            } else {
                2
            },
            "an unchanged file must not be re-read"
        );
        // Replacement by rename (new inode) and a rewrite (new size) both miss the cache.
        let swap = fixture("cached-bin-next");
        write_exec(&swap, b"version two, replaced");
        std::fs::rename(&swap, &bin).expect("rename over");
        let replaced = digest_with_window(&canon, Duration::ZERO).expect("digest");
        assert_ne!(first, replaced, "a replaced binary must be re-hashed");
        write_exec(&bin, b"v3");
        assert_ne!(replaced, digest_with_window(&canon, Duration::ZERO).expect("digest"), "a rewritten binary must be re-hashed");
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn freshly_written_files_are_never_trusted_from_the_cache() {
        // The default window treats a just-modified file as racy: a later write
        // could hide behind an identical coarse timestamp, so it is always re-read.
        let bin = fixture("racy-bin");
        write_exec(&bin, b"racy one");
        let canon = bin.canonicalize().expect("canon");
        let one = digest_of(&canon).expect("digest");
        assert_eq!(one, digest_of(&canon).expect("digest"));
        assert_eq!(times_hashed(&canon), 2, "a file inside the racy window is re-hashed every time");
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn pinned_binaries_replaced_after_a_cached_check_fail_closed() {
        let bin = fixture("pinned-cached-bin");
        write_exec(&bin, b"first bytes");
        let canon = bin.canonicalize().expect("canon");
        let pins = ExecPins::new();
        assert!(pins.check(&canon, "Thing").is_ok());
        assert!(pins.check(&canon, "Thing").is_ok());
        // Swap in different bytes through a new inode, as an installer would.
        let swap = fixture("pinned-cached-bin-next");
        write_exec(&swap, b"other bytes!!");
        std::fs::rename(&swap, &bin).expect("rename over");
        assert!(pins.check(&canon, "Thing").unwrap_err().contains("replaced"));
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn version_probes_are_remembered_until_the_binary_changes() {
        #[cfg(unix)]
        {
            let work = workdir("version-cache");
            let counter = work.join("probes");
            let bin = work.join("agent");
            let script = |version: &str| format!("#!/bin/sh\necho x >> '{}'\necho 'agent {version}'\n", counter.display());
            write_exec(&bin, script("1.2.3").as_bytes());
            let canon = bin.canonicalize().expect("canon");
            let probes = || std::fs::read_to_string(&counter).map(|text| text.lines().count()).unwrap_or(0);
            assert_eq!(probe_version_cached(&canon).as_deref(), Some("agent 1.2.3"));
            assert_eq!(probe_version_cached(&canon).as_deref(), Some("agent 1.2.3"));
            assert_eq!(probes(), 1, "the agent must not be spawned again for an unchanged binary");
            write_exec(&bin, script("2.0.0").as_bytes());
            assert_eq!(probe_version_cached(&canon).as_deref(), Some("agent 2.0.0"));
            assert_eq!(probes(), 2, "a changed binary is probed afresh");
            let _ = std::fs::remove_dir_all(&work);
        }
    }

    #[test]
    fn agent_pins_report_whether_anything_changed() {
        let bin = fixture("agent-report");
        write_exec(&bin, b"report");
        let canon = bin.canonicalize().expect("canon");
        let pins = AgentPins::new(HashMap::new());
        assert_eq!(pins.check("opencode", &canon, Some("1.0".into())), Ok(PinCheck::Recorded), "first sighting is new");
        assert_eq!(pins.check("opencode", &canon, Some("1.0".into())), Ok(PinCheck::Same), "nothing new to persist");
        assert_eq!(pins.check("opencode", &canon, Some("1.1".into())), Ok(PinCheck::Recorded), "a new display version is a change");
        let _ = std::fs::remove_file(&bin);
    }

    #[test]
    fn a_vendor_update_signed_by_the_same_team_is_re_pinned() {
        let old = fixture("grok-1.0.52");
        let new = fixture("grok-1.0.60");
        let foreign = fixture("grok-foreign");
        let unsigned = fixture("grok-unsigned");
        write_exec(&old, b"v52");
        write_exec(&new, b"v60");
        write_exec(&foreign, b"evil");
        write_exec(&unsigned, b"plain");
        let (old, new, foreign, unsigned) = (old.canonicalize().expect("canon"), new.canonicalize().expect("canon"), foreign.canonicalize().expect("canon"), unsigned.canonicalize().expect("canon"));
        let (old_c, new_c, foreign_c) = (old.clone(), new.clone(), foreign.clone());
        let teams = move |path: &Path| -> Option<String> {
            if path == old_c || path == new_c { Some("5Y6N3AJ54S".into()) } else if path == foreign_c { Some("AAAAAAAAAA".into()) } else { None }
        };
        let pins = AgentPins::new(HashMap::new());
        assert_eq!(pins.check_with("grok", &old, Some("1.0.52".into()), &teams), Ok(PinCheck::Recorded));
        assert_eq!(pins.get("grok").and_then(|pin| pin.team), Some("5Y6N3AJ54S".into()), "the first sighting records the signer");
        // The vendor's own update moves the binary: accepted and re-pinned.
        let updated = pins.check_with("grok", &new, Some("1.0.60".into()), &teams).expect("vendor update");
        assert_eq!(updated, PinCheck::VendorUpdate { from: old.to_string_lossy().into_owned(), team: "5Y6N3AJ54S".into() });
        assert_eq!(pins.get("grok").map(|pin| pin.path), Some(new.to_string_lossy().into_owned()));
        // Another signer, or no signature at all, still needs confirmation.
        assert!(pins.check_with("grok", &foreign, None, &teams).unwrap_err().starts_with("Agent identity changed"));
        assert!(pins.check_with("grok", &unsigned, None, &teams).unwrap_err().starts_with("Agent identity changed"));
        // A pin from before teams were recorded vouches through the untouched old binary.
        let legacy = AgentPins::new(HashMap::from([("grok".to_string(), AgentPin { path: old.to_string_lossy().into_owned(), version: None, sha256: digest_of(&old).expect("digest"), team: None })]));
        assert!(matches!(legacy.check_with("grok", &new, None, &teams), Ok(PinCheck::VendorUpdate { .. })));
        // A tampered old file vouches for nothing; the publisher's own team still
        // lets the genuine vendor build through, and nothing else.
        let tampered = AgentPins::new(HashMap::from([("gemini".to_string(), AgentPin { path: old.to_string_lossy().into_owned(), version: None, sha256: "0".repeat(64), team: None })]));
        assert!(tampered.check_with("gemini", &new, None, &teams).is_err(), "no known publisher, no vouching file: confirm");
        let gone = AgentPins::new(HashMap::from([("grok".to_string(), AgentPin { path: "/gone/grok-1.0.40".into(), version: None, sha256: "0".repeat(64), team: None })]));
        assert!(matches!(gone.check_with("grok", &new, None, &teams), Ok(PinCheck::VendorUpdate { .. })), "a deleted old build: X.AI's own signature is enough");
        let gone = AgentPins::new(HashMap::from([("grok".to_string(), AgentPin { path: "/gone/grok-1.0.40".into(), version: None, sha256: "0".repeat(64), team: None })]));
        assert!(gone.check_with("grok", &foreign, None, &teams).is_err(), "another publisher's build is not Grok");
        for path in [&old, &new, &foreign, &unsigned] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn corrupt_pin_store_loads_empty() {
        assert!(parse_agent_pins("not json").is_empty());
        assert!(parse_agent_pins("{}").is_empty());
    }

    #[test]
    fn version_probe_times_out_on_hung_binaries() {
        #[cfg(unix)]
        {
            let hung = fixture("hung-bin");
            write_exec(&hung, b"#!/bin/sh\nsleep 30\n");
            assert!(probe_version(&hung).is_none());
            let _ = std::fs::remove_file(&hung);
        }
    }
}
