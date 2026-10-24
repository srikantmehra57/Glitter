//! Process-tree supervision and a minimal child environment (SEC-03/04/05).

use std::collections::HashSet;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

const BASE_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LANGUAGE",
    "TERM",
    "COLORTERM",
    "TZ",
    "SHELL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
    "EDITOR",
    "VISUAL",
    "HOMEBREW_PREFIX",
    "HOMEBREW_CELLAR",
    "NODE_NO_WARNINGS",
];

const PROVIDER_PREFIXES: &[&str] = &["OPENCODE_", "ANTHROPIC_", "OPENAI_", "OPENROUTER_", "GROK_", "GEMINI_", "QWEN_", "DASHSCOPE_", "GOOSE_", "MUSE_"];

const PROVIDER_KEYS: &[&str] = &["XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY", "DASHSCOPE_API_KEY", "QWEN_API_KEY"];

fn keep_env_key(key: &str) -> bool {
    if key == "NODE_OPTIONS" || key == "META_API_KEY" {
        return false;
    }
    BASE_ENV.contains(&key) || PROVIDER_KEYS.contains(&key) || PROVIDER_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

/// Version probes run before an agent needs any account credential.
const PROBE_ENV: &[&str] = &["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "LANGUAGE"];

fn keep_probe_env_key(key: &str) -> bool {
    PROBE_ENV.contains(&key)
}

fn apply_env(cmd: &mut Command, keep: fn(&str) -> bool) {
    cmd.env_clear();
    let mut kept = HashSet::new();
    for (key, value) in std::env::vars() {
        if keep(&key) && kept.insert(key.clone()) {
            cmd.env(key, value);
        }
    }
    cmd.env("NODE_NO_WARNINGS", "1");
}

/// Clear inherited secrets, then keep PATH/HOME and known provider keys.
pub fn apply_minimal_env(cmd: &mut Command) {
    apply_env(cmd, keep_env_key);
}

/// Metadata probes never receive provider credentials or agent configuration.
pub fn apply_probe_env(cmd: &mut Command) {
    apply_env(cmd, keep_probe_env_key);
}

pub fn isolate_command(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    apply_minimal_env(cmd);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.process_group(0);
}

/// End a whole process tree by pid. The child must be a process-group leader
/// (spawned with `process_group(0)`), as the bridge and `run_cli` children are.
pub fn kill_tree(pid: u32) {
    signal_group(pid, "-TERM");
}

/// Stop immediately, including descendants that ignored the earlier TERM.
pub fn kill_tree_now(pid: u32) {
    signal_group(pid, "-KILL");
}

/// Give the group a bounded chance to exit, then escalate even if its leader is gone.
pub fn kill_tree_with_grace(pid: u32, grace: Duration) {
    kill_tree(pid);
    std::thread::sleep(grace);
    kill_tree_now(pid);
}

fn signal_group(pid: u32, signal: &str) {
    let _ = Command::new("kill").args([signal, &format!("-{pid}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
}

/// Close stdin (EOF), wait, then end the process tree.
pub fn shutdown_tree(mut child: Child, stdin: ChildStdin, grace: Duration) {
    drop(stdin);
    let pid = child.id();
    let started = Instant::now();
    while started.elapsed() < grace {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    kill_tree(pid);
    let escalate = Instant::now();
    while escalate.elapsed() < Duration::from_millis(800) {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
        }
    }
    signal_group(pid, "-KILL");
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_filter_drops_unrelated_secrets() {
        assert!(!keep_env_key("META_API_KEY"));
        assert!(!keep_env_key("AWS_SECRET_ACCESS_KEY"));
        assert!(!keep_env_key("GITHUB_TOKEN"));
        assert!(!keep_env_key("NODE_OPTIONS"));
        assert!(keep_env_key("PATH"));
        assert!(keep_env_key("HOME"));
        assert!(keep_env_key("XAI_API_KEY"));
        assert!(keep_env_key("OPENCODE_TOKEN"));
    }

    #[test]
    fn version_probe_env_drops_provider_credentials() {
        assert!(keep_probe_env_key("PATH"));
        assert!(keep_probe_env_key("HOME"));
        for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_TOKEN", "GOOGLE_API_KEY", "XAI_API_KEY", "MUSE_API_KEY", "SSH_AUTH_SOCK", "NODE_OPTIONS"] {
            assert!(!keep_probe_env_key(key), "probe kept {key}");
        }
    }
}
