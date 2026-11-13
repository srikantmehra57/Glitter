//! Executable identity for the SEC-02 trust boundary.
//!
//! Every binary the app spawns — the bundled Node runtime and Chromium —
//! resolves here: the path is canonicalized (symlinks resolved, so a non-temp
//! symlink to a temp executable cannot bypass the temp check), required to be
//! a regular executable file outside temporary directories, and pinned by
//! SHA-256 digest. A same-path replacement or retarget between spawns fails
//! closed; a first sighting records its digest and proceeds.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("glitter-exec-test-{}", std::process::id()));
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
        let dir = std::env::current_dir().expect("cwd").join("target").join(format!("glitter-exec-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    fn glitter_node_name(name: &str) -> bool {
        name == "glitter-node"
    }

    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).expect("symlink");
    }

    #[test]
    fn temp_symlink_cannot_smuggle_a_binary() {
        // The SEC-02 bypass: the link lives outside temp and carries the
        // expected name, but its canonical target is a temp executable.
        let work = workdir("link");
        let target = std::env::temp_dir().join(format!("glitter-smuggled-{}", std::process::id()));
        write_exec(&target, b"#!/bin/sh\necho hi\n");
        let link = work.join("glitter-node");
        symlink(&target, &link);
        assert!(validate_exec(&link.to_string_lossy(), &glitter_node_name, "The runtime").is_err());
        // A directly named temp binary is rejected too.
        assert!(validate_exec(&target.to_string_lossy(), &glitter_node_name, "The runtime").is_err());
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&work);
    }

    #[test]
    fn canonical_target_decides_the_name_check() {
        let work = workdir("name");
        // Misnamed canonical target behind an innocent link name: rejected.
        let evil = work.join("evil.sh");
        write_exec(&evil, b"#!/bin/sh\necho hi\n");
        let link = work.join("runtime-link");
        symlink(&evil, &link);
        assert!(link.read_link().is_ok());
        assert!(validate_exec(&link.to_string_lossy(), &glitter_node_name, "The runtime").is_err());
        // Well-named canonical target behind any link name: accepted.
        let real = work.join("glitter-node");
        write_exec(&real, b"#!/bin/sh\necho hi\n");
        let alias = work.join("totally-not-the-runtime");
        symlink(&real, &alias);
        assert!(validate_exec(&alias.to_string_lossy(), &glitter_node_name, "The runtime").is_ok());
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
}
