//! Plugins and marketplaces from GitHub.
//!
//! The user names a repository (`owner/repo`, a github.com URL, or a `tree/…`
//! link into one). The native side builds the clone URL itself, fetches one
//! commit into a staging folder with git, and reads what is there:
//!
//! - a Claude Code plugin (`.claude-plugin/plugin.json`) or a Codex plugin
//!   (`.codex-plugin/plugin.json`): skills, commands, MCP servers, and the
//!   parts the built-in agent cannot run (agents, hooks, LSP servers);
//! - a marketplace (`.claude-plugin/marketplace.json` or
//!   `.agents/plugins/marketplace.json`) listing plugins in this or other
//!   repositories;
//! - a plain collection of Agent Skills (folders holding `SKILL.md`), or a
//!   bare `.mcp.json`.
//!
//! Inspecting returns a preview and a token naming the staging folder. Install
//! reads that same folder again, so what is installed is what the user saw;
//! the renderer never supplies file content or a path. An installed plugin
//! keeps its files under `~/.glitter/plugins/<id>/source`, copies its skills
//! into `~/.agents/skills` with an ownership marker (commands become skills
//! there too), and merges its servers into `~/.glitter/mcp.json`, recording
//! each exact entry so removal never touches one the user changed.
use crate::catalog::{config_path, document_servers_mut, read_config, safe_relative, skills_root, valid_id, write_config, MARKER};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PLUGINS_DIR: [&str; 2] = [".glitter", "plugins"];
const MARKETPLACES_DIR: [&str; 2] = [".glitter", "marketplaces"];
const STAGING_DIR: [&str; 3] = [".glitter", "cache", "github"];
const RECORD: &str = "plugin.json";
const META: &str = "meta.json";
const MAX_FILES: usize = 4000;
const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ICON_BYTES: u64 = 512 * 1024;
const MAX_SKILLS: usize = 300;
const MAX_MARKETPLACE_PLUGINS: usize = 2000;
const MAX_SOURCE_CHARS: usize = 512;
const STAGING_TTL: Duration = Duration::from_secs(60 * 60);
const ICON_NAMES: [&str; 6] = ["assets/icon.png", "assets/logo.png", "assets/icon.svg", "assets/logo.svg", "icon.png", "logo.png"];

/// One install, enable, disable or removal at a time: they all rewrite the
/// same `mcp.json` and skill folders.
static MUTATION: Mutex<()> = Mutex::new(());

/// Runs `git` with the given arguments in a folder. The caller supplies the
/// hardened invocation (no prompts, https only, no symlinks, a timeout).
pub type Git<'a> = &'a dyn Fn(&Path, &[String]) -> Result<String, String>;
/// Fetches a GitHub owner's avatar into a file. Best effort: a failure only
/// means the thumbnail falls back to the generated tile.
pub type Avatar<'a> = &'a dyn Fn(&str, &Path);

// ---------------------------------------------------------------------------
// Sources

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSource {
    pub owner: String,
    pub repo: String,
    /// A branch, tag or commit; `None` is the default branch.
    #[serde(rename = "ref", default)]
    pub reference: Option<String>,
    /// A folder inside the repository, `""` for its root.
    #[serde(default)]
    pub path: String,
}

impl GithubSource {
    fn clone_url(&self) -> String {
        format!("https://github.com/{}/{}.git", self.owner, self.repo)
    }

    fn web_url(&self, commit: Option<&str>) -> String {
        let base = format!("https://github.com/{}/{}", self.owner, self.repo);
        if self.path.is_empty() && self.reference.is_none() && commit.is_none() {
            return base;
        }
        let at = commit.or(self.reference.as_deref()).unwrap_or("HEAD");
        if self.path.is_empty() {
            format!("{base}/tree/{at}")
        } else {
            format!("{base}/tree/{at}/{}", self.path)
        }
    }

    /// What the user would type to get this source again.
    fn spec(&self) -> String {
        let mut out = format!("{}/{}", self.owner, self.repo);
        if let Some(reference) = &self.reference {
            out.push('@');
            out.push_str(reference);
        }
        if !self.path.is_empty() {
            out.push(':');
            out.push_str(&self.path);
        }
        out
    }
}

/// A parsed request before a `tree/<ref>/<path>` link has been split: a branch
/// name may contain slashes, so the split waits for the remote's ref list.
#[derive(Debug, PartialEq, Eq)]
pub struct SourceRequest {
    pub owner: String,
    pub repo: String,
    pub reference: Option<String>,
    pub path: String,
    pub tree: Vec<String>,
}

fn valid_owner(owner: &str) -> bool {
    !owner.is_empty()
        && owner.len() <= 39
        && owner.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        && !owner.starts_with('-')
}

fn valid_repo(repo: &str) -> bool {
    !repo.is_empty()
        && repo.len() <= 100
        && repo != "."
        && repo != ".."
        && repo.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_reference(reference: &str) -> bool {
    !reference.is_empty()
        && reference.len() <= 200
        && !reference.starts_with('-')
        && !reference.starts_with('/')
        && !reference.ends_with('/')
        && !reference.contains("..")
        && !reference.contains("//")
        && !reference.ends_with(".lock")
        && reference.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
}

fn is_commit(reference: &str) -> bool {
    reference.len() == 40 && reference.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn clean_path(path: &str) -> Result<String, String> {
    let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty() && *part != ".").collect();
    if parts.is_empty() {
        return Ok(String::new());
    }
    let joined = parts.join("/");
    if parts.contains(&"..") || safe_relative(&joined).is_none() {
        return Err(format!("{path} is not a folder inside the repository."));
    }
    Ok(joined)
}

/// Read what the user typed: `owner/repo`, `owner/repo@ref`, `owner/repo@ref:path`,
/// `github.com/owner/repo`, an https or ssh clone URL, or a `tree/`/`blob/` link.
pub fn parse_source(input: &str) -> Result<SourceRequest, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Paste a GitHub repository link, such as github.com/owner/repo.".into());
    }
    if text.len() > MAX_SOURCE_CHARS || text.chars().any(char::is_whitespace) {
        return Err("That does not look like a GitHub repository link.".into());
    }
    let without_fragment = text.split(['#', '?']).next().unwrap_or(text);
    let rest = if let Some(rest) = without_fragment.strip_prefix("git@github.com:") {
        rest
    } else if let Some(rest) = without_fragment.strip_prefix("github:") {
        rest
    } else {
        let (had_scheme, after) = match without_fragment.find("://") {
            Some(index) => {
                let scheme = without_fragment[..index].to_ascii_lowercase();
                if !matches!(scheme.as_str(), "https" | "http" | "ssh" | "git") {
                    return Err("Only github.com repositories can be added.".into());
                }
                (true, &without_fragment[index + 3..])
            }
            None => (false, without_fragment),
        };
        let after = after.strip_prefix("git@").unwrap_or(after);
        let lowered = after.to_ascii_lowercase();
        if let Some(host) = ["www.github.com/", "github.com/"].iter().find(|host| lowered.starts_with(*host)) {
            &after[host.len()..]
        } else if had_scheme || after.split('/').next().is_some_and(|first| first.contains('.') || first.contains(':')) {
            // An owner never contains a dot, so `gitlab.com/o/r` is a host.
            return Err("Only github.com repositories can be added.".into());
        } else {
            after
        }
    };
    let (rest, inline_path) = match rest.split_once(':') {
        Some((head, path)) => (head, Some(path)),
        None => (rest, None),
    };
    let (rest, inline_ref) = match rest.split_once('@') {
        Some((head, reference)) => (head, Some(reference)),
        None => (rest, None),
    };
    let mut segments: Vec<&str> = rest.split('/').filter(|segment| !segment.is_empty()).collect();
    if segments.len() < 2 {
        return Err("Name the repository as owner/repo.".into());
    }
    let owner = segments.remove(0).to_string();
    let repo = segments.remove(0).trim_end_matches(".git").to_string();
    if !valid_owner(&owner) || !valid_repo(&repo) {
        return Err(format!("{owner}/{repo} is not a valid GitHub repository name."));
    }
    let mut tree = Vec::new();
    if !segments.is_empty() {
        match segments[0] {
            "tree" | "blob" if segments.len() > 1 => {
                tree = segments[1..].iter().map(|segment| segment.to_string()).collect();
                // A `blob/` link points at a file; its folder is what holds the plugin.
                if segments[0] == "blob" && tree.len() > 1 {
                    tree.pop();
                }
            }
            _ => return Err("Paste the repository's address, or a tree/ link into one of its folders.".into()),
        }
    }
    let reference = match inline_ref {
        Some(reference) if valid_reference(reference) => Some(reference.to_string()),
        Some(_) => return Err("That branch, tag or commit name is not valid.".into()),
        None => None,
    };
    if reference.is_some() && !tree.is_empty() {
        return Err("Name the branch either with @ or in the tree/ link, not both.".into());
    }
    for segment in &tree {
        if segment == ".." || segment == "." || segment.contains('\\') {
            return Err("That link leaves the repository.".into());
        }
    }
    let path = clean_path(inline_path.unwrap_or(""))?;
    Ok(SourceRequest { owner, repo, reference, path, tree })
}

/// Split `tree/<segments>` into a ref and a folder: the longest leading run of
/// segments that names a branch or tag wins, then a full commit id, then the
/// first segment.
pub fn split_tree(tree: &[String], refs: &[String]) -> Result<(Option<String>, String), String> {
    if tree.is_empty() {
        return Ok((None, String::new()));
    }
    for take in (1..=tree.len()).rev() {
        let candidate = tree[..take].join("/");
        if refs.iter().any(|name| name == &candidate) {
            return Ok((Some(candidate), clean_path(&tree[take..].join("/"))?));
        }
    }
    let first = &tree[0];
    if !valid_reference(first) {
        return Err("That branch, tag or commit name is not valid.".into());
    }
    Ok((Some(first.clone()), clean_path(&tree[1..].join("/"))?))
}

fn parse_ls_remote(output: &str) -> Vec<(String, String)> {
    output
        .lines()
        .filter_map(|line| {
            let (sha, name) = line.split_once('\t')?;
            let short = name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/tags/")).unwrap_or(name);
            let short = short.strip_suffix("^{}").unwrap_or(short);
            Some((sha.trim().to_string(), short.to_string()))
        })
        .collect()
}

fn fetch_commit(dir: &Path, source: &GithubSource, git: Git<'_>) -> Result<String, String> {
    fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    let reference = source.reference.clone().unwrap_or_else(|| "HEAD".into());
    git(dir, &["init".into(), "-q".into()])?;
    git(dir, &["fetch".into(), "--depth".into(), "1".into(), "--no-tags".into(), "--no-recurse-submodules".into(), "-q".into(), source.clone_url(), reference])
        .map_err(|error| fetch_problem(source, &error))?;
    git(dir, &["-c".into(), "advice.detachedHead=false".into(), "checkout".into(), "-q".into(), "--detach".into(), "FETCH_HEAD".into()])?;
    let commit = git(dir, &["rev-parse".into(), "HEAD".into()])?.trim().to_string();
    if !is_commit(&commit) {
        return Err("git did not report the fetched commit.".into());
    }
    Ok(commit)
}

fn fetch_problem(source: &GithubSource, error: &str) -> String {
    let lowered = error.to_ascii_lowercase();
    let name = format!("{}/{}", source.owner, source.repo);
    if lowered.contains("not found") || lowered.contains("could not read username") || lowered.contains("authentication") || lowered.contains("403") {
        format!("Could not reach {name} on GitHub. Check the name; a private repository needs git credentials for github.com on this Mac.")
    } else if lowered.contains("couldn't find remote ref") || lowered.contains("not our ref") {
        format!("{name} has no branch, tag or commit called {}.", source.reference.as_deref().unwrap_or("HEAD"))
    } else if lowered.contains("timed out") || lowered.contains("could not resolve host") || lowered.contains("unable to access") {
        format!("Could not download {name}. Check your internet connection and try again.")
    } else {
        format!("Could not download {name}: {error}")
    }
}

// ---------------------------------------------------------------------------
// Reading what a repository holds

/// The `key: value` pairs between `---` lines at the top of a Markdown file,
/// and the byte offset where its body starts. Folded and literal block values
/// are joined from their indented lines.
pub fn frontmatter(text: &str) -> (Map<String, Value>, usize) {
    let source = text.strip_prefix('\u{feff}').unwrap_or(text);
    let offset = text.len() - source.len();
    let mut fields = Map::new();
    let Some(first_break) = source.find('\n') else { return (fields, 0) };
    if source[..first_break].trim_end() != "---" {
        return (fields, 0);
    }
    let mut position = first_break + 1;
    let mut lines: Vec<&str> = Vec::new();
    let mut closed = None;
    while position <= source.len() {
        let end = source[position..].find('\n').map(|index| position + index).unwrap_or(source.len());
        let line = source[position..end].trim_end_matches('\r');
        if line.trim_end() == "---" {
            closed = Some((end + 1).min(source.len()));
            break;
        }
        lines.push(line);
        if end == source.len() {
            break;
        }
        position = end + 1;
    }
    let Some(body) = closed else { return (Map::new(), 0) };
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.starts_with([' ', '\t']) || line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
            continue;
        }
        let value = value.trim();
        let text = if matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+") {
            let mut parts = Vec::new();
            while index < lines.len() && (lines[index].starts_with([' ', '\t']) || lines[index].trim().is_empty()) {
                parts.push(lines[index].trim());
                index += 1;
            }
            let joiner = if value.starts_with('>') { " " } else { "\n" };
            parts.join(joiner).trim().to_string()
        } else {
            unquote(value)
        };
        fields.insert(key.to_string(), Value::String(text));
    }
    (fields, offset + body)
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.len() >= 2 && ((trimmed.starts_with('"') && trimmed.ends_with('"')) || (trimmed.starts_with('\'') && trimmed.ends_with('\''))) {
        trimmed[1..trimmed.len() - 1].to_string()
    } else {
        trimmed.to_string()
    }
}

fn read_text(path: &Path, limit: u64) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > limit {
        return None;
    }
    fs::read_to_string(path).ok()
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let Ok(metadata) = fs::symlink_metadata(path) else { return Ok(None) };
    if !metadata.is_file() {
        return Ok(None);
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(format!("{} is too large to read.", display_name(path)));
    }
    let raw = fs::read_to_string(path).map_err(|error| format!("Could not read {}: {error}", display_name(path)))?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| format!("{} is not valid JSON: {error}", display_name(path)))?;
    Ok(Some(value))
}

fn display_name(path: &Path) -> String {
    let parts: Vec<String> = path.components().rev().take(2).map(|part| part.as_os_str().to_string_lossy().into_owned()).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(|text| clip(text, 2000))
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn author_name(value: &Value) -> Option<String> {
    match value.get("author") {
        Some(Value::String(name)) => Some(clip(name.trim(), 120)).filter(|name| !name.is_empty()),
        Some(object @ Value::Object(_)) => text_field(object, "name").map(|name| clip(&name, 120)),
        _ => None,
    }
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(text)) => vec![text.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

/// Inside `root`, refusing anything that resolves outside it.
fn inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let cleaned = clean_path(relative).ok()?;
    let candidate = if cleaned.is_empty() { root.to_path_buf() } else { root.join(&cleaned) };
    let real_root = fs::canonicalize(root).ok()?;
    let real = fs::canonicalize(&candidate).ok()?;
    real.starts_with(&real_root).then_some(candidate)
}

fn is_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|metadata| metadata.is_dir()).unwrap_or(false)
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|metadata| metadata.is_file()).unwrap_or(false)
}

fn sorted_children(dir: &Path) -> Vec<PathBuf> {
    let mut children: Vec<PathBuf> = fs::read_dir(dir).map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect()).unwrap_or_default();
    children.sort();
    children
}

fn valid_name(name: &str) -> bool {
    valid_id(name)
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    /// Relative to the plugin's root.
    pub folder: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    pub name: String,
    pub description: String,
    /// The Markdown file, relative to the plugin's root.
    pub file: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub transport: String,
    /// The command line or URL, as it will run.
    pub display: String,
    /// Variables the configuration expects but cannot be given at install.
    pub needs_env: Vec<String>,
    #[serde(skip)]
    pub value: Value,
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginAnalysis {
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub long_description: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub category: Option<String>,
    pub keywords: Vec<String>,
    pub brand_color: Option<String>,
    /// Claude Code, Codex, Agent Skills, MCP.
    pub formats: Vec<String>,
    pub skills: Vec<SkillInfo>,
    pub commands: Vec<CommandInfo>,
    pub servers: Vec<ServerInfo>,
    pub agents: Vec<String>,
    pub hooks: bool,
    pub lsp: bool,
    pub notes: Vec<String>,
    #[serde(skip)]
    pub icon: Option<PathBuf>,
}

impl PluginAnalysis {
    fn usable(&self) -> bool {
        !self.skills.is_empty() || !self.commands.is_empty() || !self.servers.is_empty()
    }
}

fn skill_at(root: &Path, folder: &Path) -> Option<SkillInfo> {
    let file = folder.join("SKILL.md");
    let text = read_text(&file, 512 * 1024)?;
    let (fields, _) = frontmatter(&text);
    let folder_name = folder.file_name()?.to_string_lossy().into_owned();
    let name = fields.get("name").and_then(Value::as_str).map(str::trim).filter(|name| !name.is_empty()).unwrap_or(&folder_name).to_string();
    let description = fields.get("description").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let relative = folder.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    Some(SkillInfo { name, description: clip(&description, 1024), folder: relative })
}

/// Skill folders under `dir`: `dir` itself when it holds a `SKILL.md`, else
/// its descendants, at most `depth` levels down, without entering a skill.
fn find_skills(root: &Path, dir: &Path, depth: usize, out: &mut Vec<SkillInfo>, notes: &mut Vec<String>) {
    if out.len() >= MAX_SKILLS || !is_plain_dir(dir) {
        return;
    }
    if is_plain_file(&dir.join("SKILL.md")) {
        match skill_at(root, dir) {
            Some(skill) if !valid_name(&skill.name) => notes.push(format!("Skipped the skill in {}: “{}” is not a usable skill name.", skill.folder, skill.name)),
            Some(skill) if skill.description.is_empty() => notes.push(format!("Skipped {}: its SKILL.md has no description.", skill.name)),
            Some(skill) => {
                if !out.iter().any(|existing| existing.name.eq_ignore_ascii_case(&skill.name)) {
                    out.push(skill);
                }
            }
            None => {}
        }
        return;
    }
    if depth == 0 {
        return;
    }
    for child in sorted_children(dir) {
        let name = child.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if matches!(name.as_str(), ".git" | "node_modules" | ".github") {
            continue;
        }
        find_skills(root, &child, depth - 1, out, notes);
    }
}

fn find_commands(root: &Path, dir: &Path, prefix: &str, depth: usize, out: &mut Vec<CommandInfo>) {
    for child in sorted_children(dir) {
        let file_name = child.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        if is_plain_dir(&child) && depth > 0 {
            let nested = if prefix.is_empty() { file_name.clone() } else { format!("{prefix}-{file_name}") };
            find_commands(root, &child, &nested, depth - 1, out);
            continue;
        }
        let Some(stem) = file_name.strip_suffix(".md") else { continue };
        if !is_plain_file(&child) {
            continue;
        }
        let name = if prefix.is_empty() { stem.to_string() } else { format!("{prefix}-{stem}") };
        if !valid_name(&name) || out.iter().any(|existing| existing.name == name) {
            continue;
        }
        let Some(text) = read_text(&child, 256 * 1024) else { continue };
        let (fields, body) = frontmatter(&text);
        let description = fields
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| text[body..].lines().map(|line| line.trim().trim_start_matches('#').trim()).find(|line| !line.is_empty()).map(str::to_string))
            .unwrap_or_else(|| format!("The /{name} command."));
        let relative = child.strip_prefix(root).map(|path| path.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        out.push(CommandInfo { name, description: clip(&description, 400), file: relative });
    }
}

/// `${CLAUDE_PLUGIN_ROOT}` and its kin become the installed folder; `${VAR:-x}`
/// becomes `x`; any other `${VAR}` is kept and reported.
fn expand(text: &str, plugin_root: &str, needs: &mut Vec<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let (name, default) = match inner.split_once(":-") {
            Some((name, default)) => (name, Some(default)),
            None => (inner, None),
        };
        if matches!(name, "CLAUDE_PLUGIN_ROOT" | "PLUGIN_ROOT" | "CODEX_PLUGIN_ROOT" | "GLITTER_PLUGIN_ROOT") {
            out.push_str(plugin_root);
        } else if let Some(default) = default {
            out.push_str(default);
        } else {
            if !needs.iter().any(|known| known == name) {
                needs.push(name.to_string());
            }
            out.push_str(&rest[start..start + 2 + end + 1]);
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn convert_server(name: &str, raw: &Value, plugin_root: &str) -> Result<ServerInfo, String> {
    if !valid_name(name) {
        return Err(format!("“{name}” is not a usable MCP server name."));
    }
    let object = raw.as_object().ok_or_else(|| format!("The {name} server is not an object."))?;
    let declared = object.get("type").or_else(|| object.get("transport")).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let url = object.get("url").and_then(Value::as_str);
    let mut needs = Vec::new();
    let mut value = Map::new();
    let display;
    let transport;
    if declared == "sse" {
        return Err(format!("{name} uses the SSE transport, which the built-in agent does not support."));
    }
    if matches!(declared.as_str(), "http" | "streamable-http" | "streamablehttp") || (declared.is_empty() && url.is_some()) {
        let url = url.ok_or_else(|| format!("The {name} server has no url."))?;
        let url = expand(url, plugin_root, &mut needs);
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err(format!("The {name} server's url must be http or https."));
        }
        transport = "http";
        value.insert("transport".into(), json!("http"));
        value.insert("url".into(), json!(url));
        if let Some(headers) = object.get("headers").and_then(Value::as_object) {
            let headers: Map<String, Value> = headers.iter().filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), json!(expand(text, plugin_root, &mut needs))))).collect();
            if !headers.is_empty() {
                value.insert("headers".into(), Value::Object(headers));
            }
        }
        display = url;
    } else {
        let command = object.get("command").and_then(Value::as_str).map(str::trim).filter(|command| !command.is_empty()).ok_or_else(|| format!("The {name} server has no command."))?;
        let command = expand(command, plugin_root, &mut needs);
        let args: Vec<String> = object.get("args").and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(|arg| expand(arg, plugin_root, &mut needs)).collect()).unwrap_or_default();
        if args.len() > 64 {
            return Err(format!("The {name} server has more than 64 arguments."));
        }
        transport = "stdio";
        value.insert("transport".into(), json!("stdio"));
        value.insert("command".into(), json!(command));
        value.insert("args".into(), json!(args));
        if let Some(env) = object.get("env").and_then(Value::as_object) {
            let env: Map<String, Value> = env
                .iter()
                .filter(|(key, _)| key.as_str() != "NODE_OPTIONS")
                .filter_map(|(key, value)| value.as_str().map(|text| (key.clone(), json!(expand(text, plugin_root, &mut needs)))))
                .collect();
            if !env.is_empty() {
                value.insert("env".into(), Value::Object(env));
            }
        }
        display = std::iter::once(command).chain(args).collect::<Vec<_>>().join(" ");
    }
    Ok(ServerInfo { name: name.to_string(), transport: transport.into(), display, needs_env: needs, value: Value::Object(value) })
}

fn servers_from(document: &Value, plugin_root: &str, out: &mut Vec<ServerInfo>, notes: &mut Vec<String>) {
    let Some(object) = document.as_object() else { return };
    let block = object.get("mcpServers").and_then(Value::as_object).unwrap_or(object);
    for (name, raw) in block {
        if out.iter().any(|server| &server.name == name) {
            continue;
        }
        match convert_server(name, raw, plugin_root) {
            Ok(server) => out.push(server),
            Err(problem) => notes.push(problem),
        }
    }
}

fn read_manifest(root: &Path) -> Result<(Option<Value>, Option<Value>), String> {
    Ok((read_json(&root.join(".claude-plugin/plugin.json"))?, read_json(&root.join(".codex-plugin/plugin.json"))?))
}

fn has_plugin_manifest(root: &Path) -> bool {
    is_plain_file(&root.join(".claude-plugin/plugin.json")) || is_plain_file(&root.join(".codex-plugin/plugin.json"))
}

fn icon_in(root: &Path, relative: &str) -> Option<PathBuf> {
    let path = inside(root, relative)?;
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "svg" | "webp" | "gif") {
        return None;
    }
    let metadata = fs::symlink_metadata(&path).ok()?;
    (metadata.is_file() && metadata.len() <= MAX_ICON_BYTES).then_some(path)
}

/// Read one plugin folder. `entry` is its marketplace listing when it came
/// from one: a `strict: false` listing names the components itself.
/// `install_root` is the path its servers will see as the plugin root.
pub fn analyze_plugin(root: &Path, entry: Option<&Value>, fallback_name: &str, install_root: &str) -> Result<PluginAnalysis, String> {
    if !is_plain_dir(root) {
        return Err("That folder is not in the repository.".into());
    }
    let (claude, codex) = read_manifest(root)?;
    let empty = Value::Null;
    let interface = codex.as_ref().and_then(|value| value.get("interface")).unwrap_or(&empty);
    let sources: Vec<&Value> = [entry, claude.as_ref(), codex.as_ref()].into_iter().flatten().collect();
    let first = |key: &str| sources.iter().find_map(|value| text_field(value, key));
    let mut analysis = PluginAnalysis::default();
    let raw_name = first("name").unwrap_or_else(|| fallback_name.to_string());
    analysis.name = clip(&raw_name, 80);
    analysis.display_name = text_field(interface, "displayName").or_else(|| entry.and_then(|value| text_field(value, "displayName")));
    analysis.description = text_field(interface, "shortDescription").or_else(|| first("description"));
    analysis.long_description = text_field(interface, "longDescription");
    analysis.version = first("version").map(|version| clip(&version, 40));
    analysis.author = sources.iter().find_map(|value| author_name(value)).or_else(|| text_field(interface, "developerName"));
    analysis.homepage = first("homepage").or_else(|| text_field(interface, "websiteURL")).filter(|url| url.starts_with("https://") || url.starts_with("http://"));
    analysis.license = first("license").map(|license| clip(&license, 60));
    analysis.category = first("category").or_else(|| text_field(interface, "category")).map(|category| clip(&category, 40));
    analysis.keywords = sources.iter().flat_map(|value| string_list(value.get("keywords")).into_iter().chain(string_list(value.get("tags")))).fold(Vec::new(), |mut all, word| {
        let word = clip(word.trim(), 32);
        if !word.is_empty() && all.len() < 12 && !all.iter().any(|known: &String| known.eq_ignore_ascii_case(&word)) {
            all.push(word);
        }
        all
    });
    analysis.brand_color = text_field(interface, "brandColor").filter(|color| color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    if claude.is_some() {
        analysis.formats.push("Claude Code".into());
    }
    if codex.is_some() {
        analysis.formats.push("Codex".into());
    }
    let manifest_present = claude.is_some() || codex.is_some() || entry.is_some();

    // Skills: the listing's or manifest's paths, else the conventional folder,
    // else (for a repository with no manifest) anywhere a few levels down.
    let mut skill_paths: Vec<String> = Vec::new();
    for value in &sources {
        skill_paths.extend(string_list(value.get("skills")));
    }
    let mut notes = Vec::new();
    let mut skills = Vec::new();
    if !skill_paths.is_empty() {
        for path in &skill_paths {
            match inside(root, path) {
                Some(dir) => find_skills(root, &dir, 3, &mut skills, &mut notes),
                None => notes.push(format!("Skipped {path}: it is not a folder in the plugin.")),
            }
        }
    } else if is_plain_dir(&root.join("skills")) {
        find_skills(root, &root.join("skills"), 3, &mut skills, &mut notes);
    } else if !manifest_present {
        find_skills(root, root, 3, &mut skills, &mut notes);
    }
    if skills.len() >= MAX_SKILLS {
        notes.push(format!("Only the first {MAX_SKILLS} skills are offered."));
    }
    if !skills.is_empty() {
        analysis.formats.push("Agent Skills".into());
    }
    analysis.skills = skills;

    // Commands become skills the user can call with /name.
    let mut command_paths: Vec<String> = Vec::new();
    for value in &sources {
        command_paths.extend(string_list(value.get("commands")));
    }
    if command_paths.is_empty() && manifest_present {
        command_paths.push("commands".into());
    }
    let mut commands = Vec::new();
    for path in &command_paths {
        let Some(location) = inside(root, path) else { continue };
        if is_plain_dir(&location) {
            find_commands(root, &location, "", 1, &mut commands);
        } else if is_plain_file(&location) {
            if let Some(parent) = location.parent() {
                let mut single = Vec::new();
                find_commands(root, parent, "", 0, &mut single);
                commands.extend(single.into_iter().filter(|command| location.ends_with(&command.file)));
            }
        }
    }
    commands.retain(|command| !analysis.skills.iter().any(|skill| skill.name.eq_ignore_ascii_case(&command.name)));
    analysis.commands = commands;

    // MCP servers: inline in a manifest, a path from it, or `.mcp.json`.
    let mut servers = Vec::new();
    let mut declared_mcp = false;
    for value in &sources {
        match value.get("mcpServers") {
            Some(inline @ Value::Object(_)) => {
                declared_mcp = true;
                servers_from(inline, install_root, &mut servers, &mut notes);
            }
            Some(other) => {
                for path in string_list(Some(other)) {
                    declared_mcp = true;
                    if let Some(file) = inside(root, &path) {
                        if let Some(document) = read_json(&file)? {
                            servers_from(&document, install_root, &mut servers, &mut notes);
                        }
                    }
                }
            }
            None => {}
        }
    }
    if !declared_mcp {
        if let Some(document) = read_json(&root.join(".mcp.json"))? {
            servers_from(&document, install_root, &mut servers, &mut notes);
        }
    }
    for server in &servers {
        if !server.needs_env.is_empty() {
            notes.push(format!(
                "{} expects {} from the environment. Add {} to its entry in ~/.glitter/mcp.json after installing.",
                server.name,
                server.needs_env.join(", "),
                if server.needs_env.len() == 1 { "it" } else { "them" }
            ));
        }
    }
    if !servers.is_empty() {
        analysis.formats.push("MCP".into());
    }
    analysis.servers = servers;

    // What the built-in agent cannot run, reported rather than dropped.
    let mut agents = Vec::new();
    let mut agent_paths: Vec<String> = sources.iter().flat_map(|value| string_list(value.get("agents"))).collect();
    if agent_paths.is_empty() {
        agent_paths.push("agents".into());
    }
    for path in agent_paths {
        if let Some(dir) = inside(root, &path).filter(|dir| is_plain_dir(dir)) {
            for child in sorted_children(&dir) {
                if let Some(stem) = child.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_suffix(".md")) {
                    agents.push(stem.to_string());
                }
            }
        }
    }
    analysis.agents = agents;
    analysis.hooks = is_plain_file(&root.join("hooks/hooks.json"))
        || sources.iter().any(|value| match value.get("hooks") {
            Some(Value::Object(map)) => !map.is_empty(),
            Some(Value::String(_)) | Some(Value::Array(_)) => true,
            _ => false,
        });
    analysis.lsp = is_plain_file(&root.join(".lsp.json")) || sources.iter().any(|value| value.get("lspServers").is_some());
    analysis.icon = [text_field(interface, "logo"), text_field(interface, "composerIcon")]
        .into_iter()
        .flatten()
        .chain(ICON_NAMES.iter().map(|name| name.to_string()))
        .find_map(|relative| icon_in(root, &relative));
    analysis.notes = notes;
    Ok(analysis)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
    pub name: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub category: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub keywords: Vec<String>,
    /// Where its files live: this repository, or `owner/repo`.
    pub location: String,
    /// False for a source this app cannot fetch (another host, a package).
    pub supported: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceAnalysis {
    pub name: String,
    pub description: Option<String>,
    pub owner: Option<String>,
    pub plugins: Vec<MarketplacePlugin>,
}

fn marketplace_document(root: &Path) -> Result<Option<Value>, String> {
    if let Some(document) = read_json(&root.join(".claude-plugin/marketplace.json"))? {
        return Ok(Some(document));
    }
    read_json(&root.join(".agents/plugins/marketplace.json"))
}

enum EntrySource {
    Local(String),
    Github(GithubSource),
    Unsupported(String),
}

fn github_from_url(url: &str) -> Option<SourceRequest> {
    parse_source(url).ok()
}

fn entry_source(entry: &Value) -> EntrySource {
    let pinned = |object: &Value| -> Option<String> {
        object.get("sha").and_then(Value::as_str).filter(|sha| is_commit(sha)).or_else(|| object.get("ref").and_then(Value::as_str).filter(|reference| valid_reference(reference))).map(str::to_string)
    };
    match entry.get("source") {
        None => EntrySource::Local(String::new()),
        Some(Value::String(text)) => {
            if text.starts_with("./") || text == "." || text.starts_with("../") || !text.contains('/') && !text.contains(':') {
                EntrySource::Local(text.clone())
            } else {
                match github_from_url(text) {
                    Some(request) if request.tree.is_empty() => EntrySource::Github(GithubSource { owner: request.owner, repo: request.repo, reference: request.reference, path: request.path }),
                    _ => EntrySource::Unsupported(text.clone()),
                }
            }
        }
        Some(object @ Value::Object(_)) => {
            let kind = object.get("source").and_then(Value::as_str).unwrap_or("");
            let path = object.get("path").and_then(Value::as_str).unwrap_or("");
            let reference = pinned(object);
            let target = match kind {
                "github" => object.get("repo").and_then(Value::as_str).map(str::to_string),
                "url" | "git" | "git-subdir" => object.get("url").and_then(Value::as_str).map(str::to_string),
                _ => None,
            };
            let Some(target) = target else {
                return EntrySource::Unsupported(kind.to_string());
            };
            if target.starts_with("./") || target == "." {
                return EntrySource::Local(format!("{}/{}", target.trim_end_matches('/'), path));
            }
            match github_from_url(&target) {
                Some(request) if request.tree.is_empty() => match clean_path(path) {
                    Ok(path) => EntrySource::Github(GithubSource { owner: request.owner, repo: request.repo, reference: reference.or(request.reference), path }),
                    Err(_) => EntrySource::Unsupported(target),
                },
                _ => EntrySource::Unsupported(target),
            }
        }
        Some(_) => EntrySource::Unsupported("unknown".into()),
    }
}

pub fn analyze_marketplace(root: &Path) -> Result<Option<MarketplaceAnalysis>, String> {
    let Some(document) = marketplace_document(root)? else { return Ok(None) };
    let plugins = document.get("plugins").and_then(Value::as_array).ok_or("The marketplace lists no plugins.")?;
    let mut rows = Vec::new();
    for entry in plugins.iter().take(MAX_MARKETPLACE_PLUGINS) {
        let Some(name) = text_field(entry, "name").filter(|name| valid_name(name)) else { continue };
        if rows.iter().any(|row: &MarketplacePlugin| row.name == name) {
            continue;
        }
        let (location, supported) = match entry_source(entry) {
            EntrySource::Local(_) => ("This repository".to_string(), true),
            EntrySource::Github(source) => (format!("{}/{}", source.owner, source.repo), true),
            EntrySource::Unsupported(_) => ("Not on GitHub".to_string(), false),
        };
        rows.push(MarketplacePlugin {
            name,
            description: text_field(entry, "description").map(|text| clip(&text, 600)),
            version: text_field(entry, "version").map(|text| clip(&text, 40)),
            category: text_field(entry, "category").map(|text| clip(&text, 40)),
            author: author_name(entry),
            homepage: text_field(entry, "homepage").filter(|url| url.starts_with("https://")),
            keywords: string_list(entry.get("keywords")).into_iter().chain(string_list(entry.get("tags"))).take(8).collect(),
            location,
            supported,
        });
    }
    let owner = document.get("owner").and_then(|owner| owner.get("name")).and_then(Value::as_str).map(|name| clip(name, 120));
    let description = text_field(&document, "description").or_else(|| document.get("metadata").and_then(|meta| text_field(meta, "description")));
    let name = text_field(&document, "name").or_else(|| document.get("interface").and_then(|meta| text_field(meta, "displayName"))).unwrap_or_else(|| "marketplace".into());
    Ok(Some(MarketplaceAnalysis { name: clip(&name, 80), description, owner, plugins: rows }))
}

// ---------------------------------------------------------------------------
// Inspect: fetch, read, stage

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// What was asked for: the repository, ref and folder.
    pub source: GithubSource,
    /// The commit that was fetched.
    pub commit: String,
    /// The plugin's name in that repository's marketplace, when it came from one.
    #[serde(default)]
    pub plugin: Option<String>,
    /// Where the plugin's own files came from, when not `source` itself.
    #[serde(default)]
    pub files: Option<GithubSource>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OriginView {
    pub owner: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub path: String,
    pub commit: String,
    pub plugin: Option<String>,
    /// What to inspect again to update: `owner/repo[@ref][:path]`.
    pub spec: String,
    pub url: String,
}

impl Origin {
    fn view(&self) -> OriginView {
        let files = self.files.as_ref().unwrap_or(&self.source);
        OriginView {
            owner: self.source.owner.clone(),
            repo: self.source.repo.clone(),
            reference: self.source.reference.clone(),
            path: self.source.path.clone(),
            commit: self.commit.clone(),
            plugin: self.plugin.clone(),
            spec: self.source.spec(),
            url: files.web_url(if self.files.is_some() { None } else { Some(&self.commit) }),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StageMeta {
    origin: Origin,
    kind: String,
    /// The plugin's folder, relative to the staging folder.
    plugin_root: String,
    entry: Option<Value>,
    fallback_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    pub kind: String,
    pub origin: OriginView,
    pub plugin: Option<PluginAnalysis>,
    pub marketplace: Option<MarketplaceAnalysis>,
    /// A data URL for the plugin's own logo.
    pub icon: Option<String>,
    /// A data URL for the repository owner's avatar.
    pub avatar: Option<String>,
    /// The id it will be installed as, and whether that is already installed.
    pub plugin_id: Option<String>,
    pub installed: bool,
    /// Skills and servers with the same names that something else already owns.
    pub conflicts: Vec<String>,
}

fn join(home: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(home.to_path_buf(), |path, part| path.join(part))
}

fn plugins_root(home: &Path) -> PathBuf {
    join(home, &PLUGINS_DIR)
}

fn marketplaces_root(home: &Path) -> PathBuf {
    join(home, &MARKETPLACES_DIR)
}

fn staging_root(home: &Path) -> PathBuf {
    join(home, &STAGING_DIR)
}

/// A folder name for a plugin or marketplace: lowercase, safe, stable.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for char in name.chars().flat_map(char::to_lowercase) {
        if char.is_ascii_alphanumeric() || matches!(char, '.' | '_' | '-') {
            out.push(char);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches(|char: char| !char.is_ascii_alphanumeric());
    let mut slug: String = trimmed.chars().take(64).collect();
    while slug.ends_with(|char: char| !char.is_ascii_alphanumeric()) {
        slug.pop();
    }
    if slug.is_empty() {
        "plugin".into()
    } else {
        slug
    }
}

fn data_url(path: &Path) -> Option<String> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_ICON_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    // Sniff the bytes: GitHub serves JPEG avatars at a `.png` address.
    let svg = path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("svg"));
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if svg && String::from_utf8_lossy(&bytes[..bytes.len().min(2048)]).contains("<svg") {
        "image/svg+xml"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

fn clear_stale_staging(home: &Path) {
    let root = staging_root(home);
    let now = SystemTime::now();
    for child in sorted_children(&root) {
        let old = fs::metadata(&child).and_then(|metadata| metadata.modified()).ok().and_then(|modified| now.duration_since(modified).ok()).is_some_and(|age| age > STAGING_TTL);
        if old {
            let _ = fs::remove_dir_all(&child);
        }
    }
}

fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn staged(home: &Path, token: &str) -> Result<(PathBuf, StageMeta), String> {
    if !valid_token(token) {
        return Err("That preview is not valid. Inspect the repository again.".into());
    }
    let dir = staging_root(home).join(token);
    let meta: StageMeta = match read_json(&dir.join(META))? {
        Some(value) => serde_json::from_value(value).map_err(|_| "That preview is damaged. Inspect the repository again.".to_string())?,
        None => return Err("That preview has expired. Inspect the repository again.".into()),
    };
    Ok((dir, meta))
}

fn resolve_request(request: SourceRequest, dir: &Path, git: Git<'_>) -> Result<GithubSource, String> {
    let SourceRequest { owner, repo, reference, path, tree } = request;
    if tree.is_empty() {
        return Ok(GithubSource { owner, repo, reference, path });
    }
    let probe = GithubSource { owner: owner.clone(), repo: repo.clone(), reference: None, path: String::new() };
    fs::create_dir_all(dir).map_err(|error| format!("Could not create {}: {error}", dir.display()))?;
    let listed = git(dir, &["ls-remote".into(), "--heads".into(), "--tags".into(), probe.clone_url()]).map_err(|error| fetch_problem(&probe, &error))?;
    let refs: Vec<String> = parse_ls_remote(&listed).into_iter().map(|(_, name)| name).collect();
    let (reference, tree_path) = split_tree(&tree, &refs)?;
    let path = if path.is_empty() { tree_path } else { clean_path(&format!("{tree_path}/{path}"))? };
    Ok(GithubSource { owner, repo, reference, path })
}

/// Fetch a repository and read it. With `plugin`, read that plugin from the
/// repository's marketplace, fetching its own repository when it lives elsewhere.
pub fn inspect(home: &Path, input: &str, plugin: Option<&str>, git: Git<'_>, avatar: Avatar<'_>) -> Result<Preview, String> {
    let request = parse_source(input)?;
    if let Some(name) = plugin {
        if !valid_name(name) {
            return Err("That plugin name is not valid.".into());
        }
    }
    clear_stale_staging(home);
    let token = uuid::Uuid::new_v4().simple().to_string();
    let dir = staging_root(home).join(&token);
    let result = inspect_into(home, &dir, &token, request, plugin, git, avatar);
    if result.is_err() {
        let _ = fs::remove_dir_all(&dir);
    }
    result
}

fn inspect_into(home: &Path, dir: &Path, token: &str, request: SourceRequest, plugin: Option<&str>, git: Git<'_>, avatar: Avatar<'_>) -> Result<Preview, String> {
    let source = resolve_request(request, &dir.join("refs"), git)?;
    let repo_dir = dir.join("repo");
    let commit = fetch_commit(&repo_dir, &source, git)?;
    let root = inside(&repo_dir, &source.path).filter(|root| is_plain_dir(root)).ok_or_else(|| format!("{} has no folder called {}.", source.spec(), source.path))?;
    let mut origin = Origin { source: source.clone(), commit, plugin: plugin.map(str::to_string), files: None };
    avatar(&source.owner, &dir.join("avatar.png"));

    let (kind, plugin_root, entry, fallback) = if let Some(name) = plugin {
        let document = marketplace_document(&root)?.ok_or_else(|| format!("{} has no marketplace.", source.spec()))?;
        let entry = document
            .get("plugins")
            .and_then(Value::as_array)
            .and_then(|plugins| plugins.iter().find(|entry| entry.get("name").and_then(Value::as_str) == Some(name)))
            .cloned()
            .ok_or_else(|| format!("The marketplace has no plugin called {name}."))?;
        match entry_source(&entry) {
            EntrySource::Local(relative) => {
                let folder = inside(&root, &relative).filter(|folder| is_plain_dir(folder)).ok_or_else(|| format!("The marketplace points {name} at a folder that is not there."))?;
                let relative = folder.strip_prefix(dir).map_err(|_| "The plugin folder is outside the download.".to_string())?.to_string_lossy().into_owned();
                let in_repo = folder.strip_prefix(&repo_dir).map(|path| path.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                origin.files = Some(GithubSource { owner: source.owner.clone(), repo: source.repo.clone(), reference: Some(origin.commit.clone()), path: in_repo });
                ("plugin", relative, Some(entry), name.to_string())
            }
            EntrySource::Github(files) => {
                let files_dir = dir.join("files");
                let files_commit = fetch_commit(&files_dir, &files, git)?;
                let folder = inside(&files_dir, &files.path).filter(|folder| is_plain_dir(folder)).ok_or_else(|| format!("{} has no folder called {}.", files.spec(), files.path))?;
                let relative = folder.strip_prefix(dir).map_err(|_| "The plugin folder is outside the download.".to_string())?.to_string_lossy().into_owned();
                origin.files = Some(GithubSource { reference: Some(files_commit), ..files });
                ("plugin", relative, Some(entry), name.to_string())
            }
            EntrySource::Unsupported(what) => return Err(format!("{name} is not hosted on GitHub ({what}), so it cannot be installed from here.")),
        }
    } else if has_plugin_manifest(&root) {
        ("plugin", root.strip_prefix(dir).unwrap_or(&root).to_string_lossy().into_owned(), None, source.repo.clone())
    } else if marketplace_document(&root)?.is_some() {
        ("marketplace", root.strip_prefix(dir).unwrap_or(&root).to_string_lossy().into_owned(), None, source.repo.clone())
    } else {
        let fallback = match source.path.rsplit('/').next().filter(|last| !last.is_empty()) {
            None => source.repo.clone(),
            // A hidden folder such as `.curated` reads better with its repository's name.
            Some(last) if last.starts_with('.') => format!("{}-{}", source.repo, last.trim_start_matches('.')),
            Some(last) => last.to_string(),
        };
        ("plugin", root.strip_prefix(dir).unwrap_or(&root).to_string_lossy().into_owned(), None, fallback)
    };

    let meta = StageMeta { origin: origin.clone(), kind: kind.into(), plugin_root: plugin_root.clone(), entry: entry.clone(), fallback_name: fallback.clone() };
    fs::write(dir.join(META), serde_json::to_vec_pretty(&meta).map_err(|error| error.to_string())?).map_err(|error| format!("Could not save the preview: {error}"))?;

    let avatar_url = data_url(&dir.join("avatar.png"));
    if kind == "marketplace" {
        let marketplace = analyze_marketplace(&dir.join(&plugin_root))?.ok_or("The marketplace could not be read.")?;
        return Ok(Preview { token: token.into(), kind: kind.into(), origin: origin.view(), plugin: None, marketplace: Some(marketplace), icon: None, avatar: avatar_url, plugin_id: None, installed: false, conflicts: Vec::new() });
    }
    let folder = dir.join(&plugin_root);
    let id = slug(&analyze_plugin(&folder, entry.as_ref(), &fallback, "")?.name);
    let install_root = plugins_root(home).join(&id).join("source");
    let analysis = analyze_plugin(&folder, entry.as_ref(), &fallback, &install_root.to_string_lossy())?;
    if !analysis.usable() {
        let mut parts = Vec::new();
        if !analysis.agents.is_empty() {
            parts.push(format!("{} agent{}", analysis.agents.len(), if analysis.agents.len() == 1 { "" } else { "s" }));
        }
        if analysis.hooks {
            parts.push("hooks".into());
        }
        if analysis.lsp {
            parts.push("language servers".into());
        }
        return Err(if parts.is_empty() {
            format!("No plugin, marketplace, skills or MCP servers were found in {}.", source.spec())
        } else {
            format!("{} only has {}, which the built-in agent cannot run.", analysis.name, parts.join(" and "))
        });
    }
    let record = read_record(home, &id).ok().flatten();
    let conflicts = conflicts_for(home, &id, &analysis);
    let icon = analysis.icon.as_deref().and_then(data_url);
    Ok(Preview {
        token: token.into(),
        kind: kind.into(),
        origin: origin.view(),
        installed: record.is_some(),
        plugin_id: Some(id),
        plugin: Some(analysis),
        marketplace: None,
        icon,
        avatar: avatar_url,
        conflicts,
    })
}

// ---------------------------------------------------------------------------
// Installed plugins

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledServer {
    name: String,
    value: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginRecord {
    id: String,
    name: String,
    origin: Origin,
    #[serde(default)]
    entry: Option<Value>,
    fallback_name: String,
    enabled: bool,
    /// The skills the user chose; `None` is all of them.
    #[serde(default)]
    selected: Option<Vec<String>>,
    installed_at: u64,
    updated_at: u64,
    #[serde(default)]
    skills: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    servers: Vec<InstalledServer>,
    #[serde(default)]
    icon: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub id: String,
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub servers: Vec<String>,
    pub problems: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub long_description: Option<String>,
    pub version: Option<String>,
    pub author: Option<String>,
    pub homepage: Option<String>,
    pub license: Option<String>,
    pub category: Option<String>,
    pub keywords: Vec<String>,
    pub brand_color: Option<String>,
    pub formats: Vec<String>,
    pub icon: Option<String>,
    pub avatar: Option<String>,
    pub origin: OriginView,
    pub enabled: bool,
    pub installed_at: u64,
    pub updated_at: u64,
    /// Skills it can offer, and which of them are installed now.
    pub available_skills: Vec<SkillInfo>,
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub servers: Vec<String>,
    pub server_details: Vec<ServerInfo>,
    pub agents: Vec<String>,
    pub hooks: bool,
    pub lsp: bool,
    pub notes: Vec<String>,
    pub folder: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceRecord {
    id: String,
    name: String,
    description: Option<String>,
    owner: Option<String>,
    origin: Origin,
    added_at: u64,
    refreshed_at: u64,
    plugins: Vec<MarketplacePlugin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub owner: Option<String>,
    pub origin: OriginView,
    pub added_at: u64,
    pub refreshed_at: u64,
    pub avatar: Option<String>,
    pub plugins: Vec<MarketplacePlugin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub plugins: Vec<InstalledPlugin>,
    pub marketplaces: Vec<MarketplaceView>,
    pub plugins_root: String,
    pub problems: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: String,
    pub kind: String,
    pub commit: String,
    pub latest: String,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0)
}

fn read_record(home: &Path, id: &str) -> Result<Option<PluginRecord>, String> {
    if !valid_id(id) {
        return Err("That plugin id is not valid.".into());
    }
    match read_json(&plugins_root(home).join(id).join(RECORD))? {
        Some(value) => serde_json::from_value(value).map(Some).map_err(|error| format!("The record for {id} is damaged: {error}")),
        None => Ok(None),
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&temp, body).map_err(|error| format!("Could not write {}: {error}", temp.display()))?;
    fs::rename(&temp, path).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Could not write {}: {error}", path.display())
    })
}

/// Copy regular files only: no symlinks, no `.git`, bounded in count and size.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    copy_dir(from, to, &mut files, &mut bytes)
}

fn copy_dir(from: &Path, to: &Path, files: &mut usize, bytes: &mut u64) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("Could not create {}: {error}", to.display()))?;
    for child in sorted_children(from) {
        let name = child.file_name().map(|name| name.to_os_string()).unwrap_or_default();
        if name == ".git" {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(&child) else { continue };
        if metadata.is_dir() {
            copy_dir(&child, &to.join(&name), files, bytes)?;
        } else if metadata.is_file() {
            if metadata.len() > MAX_FILE_BYTES {
                continue;
            }
            *files += 1;
            *bytes += metadata.len();
            if *files > MAX_FILES || *bytes > MAX_TOTAL_BYTES {
                return Err(format!("The plugin is larger than {MAX_FILES} files or {} MB.", MAX_TOTAL_BYTES / 1024 / 1024));
            }
            fs::copy(&child, to.join(&name)).map_err(|error| format!("Could not copy {}: {error}", display_name(&child)))?;
        }
    }
    Ok(())
}

fn skill_marker(home: &Path, name: &str) -> Option<Value> {
    let text = read_text(&skills_root(home).join(name).join(MARKER), 64 * 1024)?;
    serde_json::from_str(&text).ok()
}

fn owned_by(home: &Path, name: &str, id: &str) -> bool {
    skill_marker(home, name).is_some_and(|marker| marker.get("plugin").and_then(Value::as_str) == Some(id))
}

fn configured_server(home: &Path, name: &str) -> Option<Value> {
    let document = read_config(&config_path(home)).ok()?;
    let servers = document.get("mcpServers").and_then(Value::as_object).or_else(|| document.as_object())?;
    servers.get(name).cloned()
}

fn conflicts_for(home: &Path, id: &str, analysis: &PluginAnalysis) -> Vec<String> {
    let mut conflicts = Vec::new();
    let names = analysis.skills.iter().map(|skill| &skill.name).chain(analysis.commands.iter().map(|command| &command.name));
    for name in names {
        let folder = skills_root(home).join(name);
        if folder.exists() && !owned_by(home, name, id) {
            conflicts.push(format!("A skill called {name} is already in ~/.agents/skills; this plugin's copy is skipped."));
        }
    }
    let previous = read_record(home, id).ok().flatten();
    for server in &analysis.servers {
        if let Some(existing) = configured_server(home, &server.name) {
            let ours = previous.as_ref().is_some_and(|record| record.servers.iter().any(|known| known.name == server.name && known.value == existing));
            if !ours && existing != server.value {
                conflicts.push(format!("An MCP server called {} is already configured; this plugin's server is skipped.", server.name));
            }
        }
    }
    conflicts
}

fn write_skill_folder(home: &Path, id: &str, commit: &str, name: &str, fill: impl FnOnce(&Path) -> Result<(), String>) -> Result<bool, String> {
    let folder = skills_root(home).join(name);
    if folder.exists() {
        if !owned_by(home, name, id) {
            return Err(format!("{name} was skipped: a skill with that name is already in {}.", skills_root(home).display()));
        }
        fs::remove_dir_all(&folder).map_err(|error| format!("Could not replace {}: {error}", folder.display()))?;
    }
    let staging = skills_root(home).join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4().simple()));
    let result = (|| {
        fill(&staging)?;
        let marker = json!({ "id": name, "plugin": id, "commit": commit });
        fs::write(staging.join(MARKER), serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?).map_err(|error| format!("Could not write the install marker: {error}"))?;
        fs::rename(&staging, &folder).map_err(|error| format!("Could not install {name}: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|_| true)
}

/// A command file as a skill: its frontmatter is replaced with the name and
/// description the skill catalog needs; the body is kept as written.
fn command_skill(command: &CommandInfo, text: &str) -> String {
    let (_, body) = frontmatter(text);
    let description = command.description.replace(['\n', '\r'], " ").replace('"', "'");
    format!("---\nname: {}\ndescription: \"{}\"\n---\n\n{}", command.name, description, text[body..].trim_start())
}

/// Install a plugin's skills, commands and servers from its installed folder.
fn apply(home: &Path, record: &mut PluginRecord, analysis: &PluginAnalysis, source: &Path) -> InstallOutcome {
    let mut outcome = InstallOutcome { id: record.id.clone(), ..Default::default() };
    record.skills.clear();
    record.commands.clear();
    record.servers.clear();
    let selected = record.selected.clone();
    let wanted = |name: &str| selected.as_ref().is_none_or(|selected| selected.iter().any(|item| item == name));
    for skill in &analysis.skills {
        if !wanted(&skill.name) {
            continue;
        }
        let Some(from) = inside(source, &skill.folder) else {
            outcome.problems.push(format!("{} was skipped: its folder is missing.", skill.name));
            continue;
        };
        match write_skill_folder(home, &record.id, &record.origin.commit, &skill.name, |to| copy_tree(&from, to)) {
            Ok(_) => {
                record.skills.push(skill.name.clone());
                outcome.skills.push(skill.name.clone());
            }
            Err(problem) => outcome.problems.push(problem),
        }
    }
    for command in &analysis.commands {
        if !wanted(&command.name) {
            continue;
        }
        let Some(text) = inside(source, &command.file).and_then(|file| read_text(&file, 256 * 1024)) else {
            outcome.problems.push(format!("/{} was skipped: its file is missing.", command.name));
            continue;
        };
        let content = command_skill(command, &text);
        match write_skill_folder(home, &record.id, &record.origin.commit, &command.name, |to| {
            fs::create_dir_all(to).map_err(|error| error.to_string())?;
            fs::write(to.join("SKILL.md"), content).map_err(|error| format!("Could not write {}: {error}", command.name))
        }) {
            Ok(_) => {
                record.commands.push(command.name.clone());
                outcome.commands.push(command.name.clone());
            }
            Err(problem) => outcome.problems.push(problem),
        }
    }
    if !analysis.servers.is_empty() {
        let file = config_path(home);
        match read_config(&file) {
            Ok(mut document) => {
                let mut changed = false;
                match document_servers_mut(&mut document, &file) {
                    Ok(servers) => {
                        for server in &analysis.servers {
                            if !wanted(&server.name) {
                                continue;
                            }
                            match servers.get(&server.name) {
                                Some(existing) if existing == &server.value => {}
                                Some(_) => {
                                    outcome.problems.push(format!("{} was skipped: an MCP server with that name is already configured.", server.name));
                                    continue;
                                }
                                None => {
                                    servers.insert(server.name.clone(), server.value.clone());
                                    changed = true;
                                }
                            }
                            record.servers.push(InstalledServer { name: server.name.clone(), value: server.value.clone() });
                            outcome.servers.push(server.name.clone());
                        }
                    }
                    Err(problem) => outcome.problems.push(problem),
                }
                if changed {
                    if let Err(problem) = write_config(&file, &document) {
                        outcome.problems.push(problem);
                        record.servers.clear();
                        outcome.servers.clear();
                    }
                }
            }
            Err(problem) => outcome.problems.push(problem),
        }
    }
    outcome
}

/// Take back what `apply` installed: owned skill folders and server entries
/// that still hold exactly what was written.
fn withdraw(home: &Path, record: &mut PluginRecord) -> Vec<String> {
    let mut problems = Vec::new();
    for name in record.skills.iter().chain(record.commands.iter()) {
        let folder = skills_root(home).join(name);
        if folder.exists() && owned_by(home, name, &record.id) {
            if let Err(error) = fs::remove_dir_all(&folder) {
                problems.push(format!("Could not remove {}: {error}", folder.display()));
            }
        }
    }
    if !record.servers.is_empty() {
        let file = config_path(home);
        match read_config(&file) {
            Ok(mut document) => {
                let mut changed = false;
                if let Some(servers) = document.get_mut("mcpServers").and_then(Value::as_object_mut) {
                    for server in &record.servers {
                        match servers.get(&server.name) {
                            Some(existing) if existing == &server.value => {
                                servers.remove(&server.name);
                                changed = true;
                            }
                            Some(_) => problems.push(format!("{} in {} was changed after installing, so it was kept.", server.name, file.display())),
                            None => {}
                        }
                    }
                }
                if changed {
                    if let Err(problem) = write_config(&file, &document) {
                        problems.push(problem);
                    }
                }
            }
            Err(problem) => problems.push(problem),
        }
    }
    record.skills.clear();
    record.commands.clear();
    record.servers.clear();
    problems
}

fn analyze_installed(home: &Path, record: &PluginRecord) -> Result<PluginAnalysis, String> {
    let source = plugins_root(home).join(&record.id).join("source");
    analyze_plugin(&source, record.entry.as_ref(), &record.fallback_name, &source.to_string_lossy())
}

/// Install what a preview showed. `selected` limits which skills, commands and
/// servers are installed; `None` installs all of them.
pub fn install(home: &Path, token: &str, selected: Option<Vec<String>>) -> Result<InstallOutcome, String> {
    let _guard = MUTATION.lock().map_err(|_| "Another install is still finishing.".to_string())?;
    let (dir, meta) = staged(home, token)?;
    if meta.kind != "plugin" {
        return Err("That preview is a marketplace. Add it as a source instead.".into());
    }
    let folder = safe_relative(&meta.plugin_root).map(|relative| dir.join(relative)).ok_or("That preview is damaged. Inspect the repository again.")?;
    let first = analyze_plugin(&folder, meta.entry.as_ref(), &meta.fallback_name, "")?;
    let id = slug(&first.name);
    if !valid_id(&id) {
        return Err("The plugin's name cannot be used as a folder name.".into());
    }
    let plugin_dir = plugins_root(home).join(&id);
    let previous = read_record(home, &id)?;
    if let Some(previous) = &previous {
        let same = previous.origin.source.owner.eq_ignore_ascii_case(&meta.origin.source.owner) && previous.origin.source.repo.eq_ignore_ascii_case(&meta.origin.source.repo);
        if !same {
            return Err(format!("A plugin called {} from {}/{} is already installed. Remove it first.", previous.name, previous.origin.source.owner, previous.origin.source.repo));
        }
    } else if plugin_dir.exists() {
        return Err(format!("{} already exists and was not installed by Glitter.", plugin_dir.display()));
    }

    // Copy the files beside the old ones, then swap, so a failed copy leaves
    // an installed plugin as it was.
    let fresh = plugins_root(home).join(format!(".{id}.{}.tmp", uuid::Uuid::new_v4().simple()));
    if let Err(error) = copy_tree(&folder, &fresh.join("source")) {
        let _ = fs::remove_dir_all(&fresh);
        return Err(error);
    }
    if let Some(icon) = &first.icon {
        if let Some(ext) = icon.extension() {
            let _ = fs::copy(icon, fresh.join(format!("icon.{}", ext.to_string_lossy())));
        }
    }
    let _ = fs::copy(dir.join("avatar.png"), fresh.join("avatar.png"));

    let mut record = match previous {
        Some(mut previous) => {
            let problems = withdraw(home, &mut previous);
            if !problems.is_empty() {
                let _ = fs::remove_dir_all(&fresh);
                return Err(problems.join(" "));
            }
            write_json(&plugin_dir.join(RECORD), &previous)?;
            previous.origin = meta.origin.clone();
            previous.entry = meta.entry.clone();
            previous.fallback_name = meta.fallback_name.clone();
            previous.updated_at = now();
            previous
        }
        None => PluginRecord {
            id: id.clone(),
            name: first.name.clone(),
            origin: meta.origin.clone(),
            entry: meta.entry.clone(),
            fallback_name: meta.fallback_name.clone(),
            enabled: true,
            selected: None,
            installed_at: now(),
            updated_at: now(),
            skills: Vec::new(),
            commands: Vec::new(),
            servers: Vec::new(),
            icon: None,
        },
    };
    record.name = first.name.clone();
    record.enabled = true;
    record.selected = selected.filter(|names| !names.is_empty());
    record.icon = first.icon.as_ref().and_then(|icon| icon.extension()).map(|ext| format!("icon.{}", ext.to_string_lossy()));

    if plugin_dir.exists() {
        let old = plugins_root(home).join(format!(".{id}.{}.old", uuid::Uuid::new_v4().simple()));
        fs::rename(&plugin_dir, &old).map_err(|error| format!("Could not replace {}: {error}", plugin_dir.display()))?;
        if let Err(error) = fs::rename(&fresh, &plugin_dir) {
            let _ = fs::rename(&old, &plugin_dir);
            return Err(format!("Could not install {}: {error}", record.name));
        }
        let _ = fs::remove_dir_all(&old);
    } else {
        fs::create_dir_all(plugins_root(home)).map_err(|error| error.to_string())?;
        fs::rename(&fresh, &plugin_dir).map_err(|error| format!("Could not install {}: {error}", record.name))?;
    }
    let analysis = analyze_installed(home, &record)?;
    let outcome = apply(home, &mut record, &analysis, &plugin_dir.join("source"));
    write_json(&plugin_dir.join(RECORD), &record)?;
    let _ = fs::remove_dir_all(&dir);
    Ok(outcome)
}

pub fn set_enabled(home: &Path, id: &str, enabled: bool) -> Result<InstallOutcome, String> {
    let _guard = MUTATION.lock().map_err(|_| "Another install is still finishing.".to_string())?;
    let mut record = read_record(home, id)?.ok_or("That plugin is not installed.")?;
    let plugin_dir = plugins_root(home).join(id);
    let outcome = if enabled {
        let problems = withdraw(home, &mut record);
        let analysis = analyze_installed(home, &record)?;
        let mut outcome = apply(home, &mut record, &analysis, &plugin_dir.join("source"));
        outcome.problems.splice(0..0, problems);
        outcome
    } else {
        InstallOutcome { id: id.into(), problems: withdraw(home, &mut record), ..Default::default() }
    };
    record.enabled = enabled;
    write_json(&plugin_dir.join(RECORD), &record)?;
    Ok(outcome)
}

pub fn remove(home: &Path, id: &str) -> Result<Vec<String>, String> {
    let _guard = MUTATION.lock().map_err(|_| "Another install is still finishing.".to_string())?;
    let mut record = read_record(home, id)?.ok_or("That plugin is not installed.")?;
    let problems = withdraw(home, &mut record);
    let plugin_dir = plugins_root(home).join(id);
    fs::remove_dir_all(&plugin_dir).map_err(|error| format!("Could not remove {}: {error}", plugin_dir.display()))?;
    Ok(problems)
}

fn installed_view(home: &Path, record: &PluginRecord) -> InstalledPlugin {
    let folder = plugins_root(home).join(&record.id);
    let analysis = analyze_installed(home, record);
    let mut notes = Vec::new();
    let analysis = analysis.unwrap_or_else(|problem| {
        notes.push(problem);
        PluginAnalysis { name: record.name.clone(), ..Default::default() }
    });
    notes.extend(analysis.notes.iter().cloned());
    if record.enabled {
        for name in record.skills.iter().chain(record.commands.iter()) {
            if !owned_by(home, name, &record.id) {
                notes.push(format!("{name} is no longer in ~/.agents/skills. Turn the plugin off and on to restore it."));
            }
        }
    }
    let mut available = analysis.skills.clone();
    available.extend(analysis.commands.iter().map(|command| SkillInfo { name: command.name.clone(), description: command.description.clone(), folder: command.file.clone() }));
    InstalledPlugin {
        id: record.id.clone(),
        name: analysis.name.clone(),
        display_name: analysis.display_name.clone(),
        description: analysis.description.clone(),
        long_description: analysis.long_description.clone(),
        version: analysis.version.clone(),
        author: analysis.author.clone(),
        homepage: analysis.homepage.clone(),
        license: analysis.license.clone(),
        category: analysis.category.clone(),
        keywords: analysis.keywords.clone(),
        brand_color: analysis.brand_color.clone(),
        formats: analysis.formats.clone(),
        icon: record.icon.as_ref().and_then(|name| data_url(&folder.join(name))),
        avatar: data_url(&folder.join("avatar.png")),
        origin: record.origin.view(),
        enabled: record.enabled,
        installed_at: record.installed_at,
        updated_at: record.updated_at,
        available_skills: available,
        skills: record.skills.clone(),
        commands: record.commands.clone(),
        servers: record.servers.iter().map(|server| server.name.clone()).collect(),
        server_details: analysis.servers.clone(),
        agents: analysis.agents.clone(),
        hooks: analysis.hooks,
        lsp: analysis.lsp,
        notes,
        folder: folder.to_string_lossy().into_owned(),
    }
}

fn marketplace_view(home: &Path, record: &MarketplaceRecord) -> MarketplaceView {
    MarketplaceView {
        id: record.id.clone(),
        name: record.name.clone(),
        description: record.description.clone(),
        owner: record.owner.clone(),
        origin: record.origin.view(),
        added_at: record.added_at,
        refreshed_at: record.refreshed_at,
        avatar: data_url(&marketplaces_root(home).join(format!("{}.png", record.id))),
        plugins: record.plugins.clone(),
    }
}

pub fn library(home: &Path) -> Library {
    let mut problems = Vec::new();
    let mut plugins = Vec::new();
    for child in sorted_children(&plugins_root(home)) {
        let Some(id) = child.file_name().and_then(|name| name.to_str()).map(str::to_string) else { continue };
        if id.starts_with('.') || !is_plain_dir(&child) {
            continue;
        }
        match read_record(home, &id) {
            Ok(Some(record)) => plugins.push(installed_view(home, &record)),
            Ok(None) => {}
            Err(problem) => problems.push(problem),
        }
    }
    let mut marketplaces = Vec::new();
    for child in sorted_children(&marketplaces_root(home)) {
        if child.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match read_json(&child).and_then(|value| value.map(serde_json::from_value::<MarketplaceRecord>).transpose().map_err(|error| error.to_string())) {
            Ok(Some(record)) => marketplaces.push(marketplace_view(home, &record)),
            Ok(None) => {}
            Err(problem) => problems.push(format!("{}: {problem}", display_name(&child))),
        }
    }
    Library { plugins, marketplaces, plugins_root: plugins_root(home).to_string_lossy().into_owned(), problems }
}

// ---------------------------------------------------------------------------
// Marketplaces

pub fn add_marketplace(home: &Path, token: &str) -> Result<MarketplaceView, String> {
    let _guard = MUTATION.lock().map_err(|_| "Another install is still finishing.".to_string())?;
    let (dir, meta) = staged(home, token)?;
    if meta.kind != "marketplace" {
        return Err("That preview is a plugin. Install it instead.".into());
    }
    let folder = safe_relative(&meta.plugin_root).map(|relative| dir.join(relative)).ok_or("That preview is damaged. Inspect the repository again.")?;
    let analysis = analyze_marketplace(&folder)?.ok_or("The marketplace could not be read.")?;
    let id = slug(&analysis.name);
    let file = marketplaces_root(home).join(format!("{id}.json"));
    let previous: Option<MarketplaceRecord> = read_json(&file)?.and_then(|value| serde_json::from_value(value).ok());
    if let Some(previous) = &previous {
        let same = previous.origin.source.owner.eq_ignore_ascii_case(&meta.origin.source.owner) && previous.origin.source.repo.eq_ignore_ascii_case(&meta.origin.source.repo);
        if !same {
            return Err(format!("A source called {} from {}/{} is already added. Remove it first.", previous.name, previous.origin.source.owner, previous.origin.source.repo));
        }
    }
    let record = MarketplaceRecord {
        id: id.clone(),
        name: analysis.name,
        description: analysis.description,
        owner: analysis.owner,
        origin: meta.origin,
        added_at: previous.as_ref().map(|previous| previous.added_at).unwrap_or_else(now),
        refreshed_at: now(),
        plugins: analysis.plugins,
    };
    write_json(&file, &record)?;
    let avatar = dir.join("avatar.png");
    if avatar.is_file() {
        let _ = fs::copy(&avatar, marketplaces_root(home).join(format!("{id}.png")));
    }
    let _ = fs::remove_dir_all(&dir);
    Ok(marketplace_view(home, &record))
}

pub fn refresh_marketplace(home: &Path, id: &str, git: Git<'_>, avatar: Avatar<'_>) -> Result<MarketplaceView, String> {
    if !valid_id(id) {
        return Err("That source id is not valid.".into());
    }
    let file = marketplaces_root(home).join(format!("{id}.json"));
    let record: MarketplaceRecord = read_json(&file)?.and_then(|value| serde_json::from_value(value).ok()).ok_or("That source is not added.")?;
    let preview = inspect(home, &record.origin.source.spec(), None, git, avatar)?;
    if preview.kind != "marketplace" {
        let _ = fs::remove_dir_all(staging_root(home).join(&preview.token));
        return Err(format!("{} no longer has a marketplace.", record.origin.source.spec()));
    }
    add_marketplace(home, &preview.token)
}

pub fn remove_marketplace(home: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("That source id is not valid.".into());
    }
    let root = marketplaces_root(home);
    let file = root.join(format!("{id}.json"));
    if !file.is_file() {
        return Err("That source is not added.".into());
    }
    fs::remove_file(&file).map_err(|error| format!("Could not remove {}: {error}", file.display()))?;
    let _ = fs::remove_file(root.join(format!("{id}.png")));
    Ok(())
}

/// Compare each installed plugin and source with its branch on GitHub. A
/// plugin installed at a fixed commit has nothing to compare and is skipped.
pub fn check_updates(home: &Path, git: Git<'_>) -> Vec<UpdateInfo> {
    let probe_dir = staging_root(home).join("updates");
    if fs::create_dir_all(&probe_dir).is_err() {
        return Vec::new();
    }
    let library = library(home);
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut latest = |source: &GithubSource| -> Option<String> {
        let reference = source.reference.clone().unwrap_or_else(|| "HEAD".into());
        if is_commit(&reference) {
            return None;
        }
        let key = format!("{}/{}@{reference}", source.owner, source.repo);
        if let Some((_, sha)) = seen.iter().find(|(known, _)| known == &key) {
            return Some(sha.clone());
        }
        let listed = git(&probe_dir, &["ls-remote".into(), source.clone_url(), reference.clone()]).ok()?;
        let sha = parse_ls_remote(&listed).into_iter().map(|(sha, _)| sha).find(|sha| is_commit(sha))?;
        seen.push((key, sha.clone()));
        Some(sha)
    };
    let mut updates = Vec::new();
    for plugin in &library.plugins {
        let source = GithubSource { owner: plugin.origin.owner.clone(), repo: plugin.origin.repo.clone(), reference: plugin.origin.reference.clone(), path: plugin.origin.path.clone() };
        if let Some(sha) = latest(&source) {
            if sha != plugin.origin.commit {
                updates.push(UpdateInfo { id: plugin.id.clone(), kind: "plugin".into(), commit: plugin.origin.commit.clone(), latest: sha });
            }
        }
    }
    for marketplace in &library.marketplaces {
        let source = GithubSource { owner: marketplace.origin.owner.clone(), repo: marketplace.origin.repo.clone(), reference: marketplace.origin.reference.clone(), path: marketplace.origin.path.clone() };
        if let Some(sha) = latest(&source) {
            if sha != marketplace.origin.commit {
                updates.push(UpdateInfo { id: marketplace.id.clone(), kind: "marketplace".into(), commit: marketplace.origin.commit.clone(), latest: sha });
            }
        }
    }
    let _ = fs::remove_dir_all(&probe_dir);
    updates
}

/// Remove a preview the user closed without installing.
pub fn discard(home: &Path, token: &str) {
    if valid_token(token) {
        let _ = fs::remove_dir_all(staging_root(home).join(token));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("glitter-plugins-{}-{tag}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(root: &Path, relative: &str, content: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    /// A fake `git` that "fetches" by copying a fixture folder per repository.
    fn fake_git(fixtures: PathBuf) -> impl Fn(&Path, &[String]) -> Result<String, String> {
        move |dir: &Path, args: &[String]| -> Result<String, String> {
            match args.first().map(String::as_str) {
                Some("init") => Ok(String::new()),
                Some("fetch") => {
                    let url = args.iter().find(|arg| arg.starts_with("https://")).unwrap();
                    let name = url.trim_start_matches("https://github.com/").trim_end_matches(".git").replace('/', "_");
                    let fixture = fixtures.join(&name);
                    if !fixture.is_dir() {
                        return Err("fatal: repository not found".into());
                    }
                    copy_tree(&fixture, dir).map(|_| String::new())
                }
                Some("-c") | Some("checkout") => Ok(String::new()),
                Some("rev-parse") => Ok(format!("{SHA}\n")),
                Some("ls-remote") => Ok(format!("{SHA}\trefs/heads/main\n{SHA}\trefs/heads/feature/x\n")),
                _ => Err(format!("unexpected git {args:?}")),
            }
        }
    }

    fn no_avatar(_: &str, _: &Path) {}

    fn claude_plugin(root: &Path) {
        write(root, ".claude-plugin/plugin.json", r#"{"name":"Review Kit","version":"1.2.0","description":"Reviews","author":{"name":"Ada"},"keywords":["review"]}"#);
        write(root, "skills/review/SKILL.md", "---\nname: review\ndescription: Review a diff\n---\nBody");
        write(root, "skills/review/checklist.md", "- one");
        write(root, "skills/nodesc/SKILL.md", "---\nname: nodesc\n---\nBody");
        write(root, "commands/ship.md", "---\ndescription: Ship it\nallowed-tools: Bash\n---\nRun the release.");
        write(root, "agents/helper.md", "---\nname: helper\n---\n");
        write(root, "hooks/hooks.json", "{}");
        write(root, ".mcp.json", r#"{"mcpServers":{"docs":{"command":"${CLAUDE_PLUGIN_ROOT}/bin/docs","args":["--token","${DOCS_TOKEN}","--port","${PORT:-8080}"]},"remote":{"type":"http","url":"https://example.com/mcp"},"old":{"type":"sse","url":"https://example.com/sse"}}}"#);
    }

    #[test]
    fn sources_parse_from_every_common_spelling() {
        let plain = parse_source("anthropics/skills").unwrap();
        assert_eq!((plain.owner.as_str(), plain.repo.as_str(), plain.reference.clone(), plain.path.as_str()), ("anthropics", "skills", None, ""));
        assert_eq!(parse_source("https://github.com/obra/superpowers.git").unwrap().repo, "superpowers");
        assert_eq!(parse_source("github.com/obra/superpowers/").unwrap().owner, "obra");
        assert_eq!(parse_source("git@github.com:obra/superpowers.git").unwrap().repo, "superpowers");
        let pinned = parse_source("owner/repo@v1.2:plugins/x").unwrap();
        assert_eq!(pinned.reference.as_deref(), Some("v1.2"));
        assert_eq!(pinned.path, "plugins/x");
        let tree = parse_source("https://github.com/o/r/tree/feature/x/plugins/kit").unwrap();
        assert_eq!(tree.tree, vec!["feature", "x", "plugins", "kit"]);
        let blob = parse_source("https://github.com/o/r/blob/main/skills/a/SKILL.md").unwrap();
        assert_eq!(blob.tree, vec!["main", "skills", "a"]);
        for bad in ["", "repo", "https://gitlab.com/o/r", "o/r/issues/1", "-o/r", "o/r@--upload-pack=x", "o/r:../../etc", "o/r@a..b", "https://evil.example/o/r", "file:///tmp/o/r"] {
            assert!(parse_source(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn a_tree_link_splits_on_the_longest_known_ref() {
        let refs = vec!["main".to_string(), "feature/x".to_string()];
        let tree: Vec<String> = ["feature", "x", "plugins", "kit"].iter().map(|part| part.to_string()).collect();
        assert_eq!(split_tree(&tree, &refs).unwrap(), (Some("feature/x".into()), "plugins/kit".into()));
        let unknown: Vec<String> = ["v9", "a"].iter().map(|part| part.to_string()).collect();
        assert_eq!(split_tree(&unknown, &refs).unwrap(), (Some("v9".into()), "a".into()));
    }

    #[test]
    fn frontmatter_reads_quoted_and_folded_values() {
        let (fields, body) = frontmatter("---\nname: \"x\"\ndescription: >\n  one\n  two\n---\nBody");
        assert_eq!(fields["name"], "x");
        assert_eq!(fields["description"], "one two");
        assert_eq!(&"---\nname: \"x\"\ndescription: >\n  one\n  two\n---\nBody"[body..], "Body");
        assert!(frontmatter("no frontmatter").0.is_empty());
    }

    #[test]
    fn a_claude_code_plugin_is_read_with_its_unsupported_parts_named() {
        let root = TempDir::new("analyze");
        claude_plugin(&root.0);
        let analysis = analyze_plugin(&root.0, None, "fallback", "/installed").unwrap();
        assert_eq!(analysis.name, "Review Kit");
        assert_eq!(analysis.author.as_deref(), Some("Ada"));
        assert_eq!(analysis.skills.iter().map(|skill| skill.name.as_str()).collect::<Vec<_>>(), vec!["review"]);
        assert!(analysis.notes.iter().any(|note| note.contains("nodesc")));
        assert_eq!(analysis.commands[0].name, "ship");
        assert_eq!(analysis.commands[0].description, "Ship it");
        let docs = analysis.servers.iter().find(|server| server.name == "docs").unwrap();
        assert_eq!(docs.value["command"], "/installed/bin/docs");
        assert_eq!(docs.value["args"], json!(["--token", "${DOCS_TOKEN}", "--port", "8080"]));
        assert_eq!(docs.needs_env, vec!["DOCS_TOKEN"]);
        assert_eq!(analysis.servers.iter().find(|server| server.name == "remote").unwrap().value["transport"], "http");
        assert!(analysis.servers.iter().all(|server| server.name != "old"), "SSE is reported, not installed");
        assert!(analysis.notes.iter().any(|note| note.contains("SSE")));
        assert_eq!(analysis.agents, vec!["helper"]);
        assert!(analysis.hooks);
        assert!(analysis.formats.contains(&"Claude Code".to_string()));
    }

    #[test]
    fn a_repository_of_skills_is_found_a_few_levels_down() {
        let root = TempDir::new("skills");
        write(&root.0, "skills/.curated/pdf/SKILL.md", "---\nname: pdf\ndescription: PDFs\n---\n");
        write(&root.0, "skills/.system/creator/SKILL.md", "---\nname: creator\ndescription: Make skills\n---\n");
        write(&root.0, "README.md", "hi");
        let analysis = analyze_plugin(&root.0, None, "skills", "").unwrap();
        let mut names: Vec<_> = analysis.skills.iter().map(|skill| skill.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["creator", "pdf"]);
        assert_eq!(analysis.name, "skills");
    }

    #[test]
    fn marketplace_sources_resolve_local_github_and_unsupported() {
        let root = TempDir::new("market");
        write(&root.0, ".claude-plugin/marketplace.json", r#"{"name":"Team Tools","owner":{"name":"Team"},"plugins":[
            {"name":"local-kit","source":"./plugins/local","description":"Local"},
            {"name":"remote-kit","source":{"source":"git-subdir","url":"https://github.com/acme/tools.git","path":"plugins/r","sha":"0123456789abcdef0123456789abcdef01234567"}},
            {"name":"gh-kit","source":{"source":"github","repo":"acme/gh"}},
            {"name":"npm-kit","source":{"source":"npm","package":"x"}},
            {"name":"bad name!","source":"./x"}
        ]}"#);
        let market = analyze_marketplace(&root.0).unwrap().unwrap();
        assert_eq!(market.name, "Team Tools");
        assert_eq!(market.owner.as_deref(), Some("Team"));
        let rows: Vec<_> = market.plugins.iter().map(|row| (row.name.as_str(), row.location.as_str(), row.supported)).collect();
        assert_eq!(rows, vec![("local-kit", "This repository", true), ("remote-kit", "acme/tools", true), ("gh-kit", "acme/gh", true), ("npm-kit", "Not on GitHub", false)]);
    }

    #[test]
    fn install_disable_enable_and_remove_keep_ownership() {
        let home = TempDir::new("home");
        let fixtures = TempDir::new("fixtures");
        claude_plugin(&fixtures.0.join("ada_review-kit"));
        // Something the user already has with the same name as one of the plugin's skills.
        write(&home.0, ".agents/skills/ship/SKILL.md", "---\nname: ship\ndescription: mine\n---\n");
        write(&home.0, ".glitter/mcp.json", r#"{"mcpServers":{"mine":{"transport":"stdio","command":"x"}}}"#);
        let git = fake_git(fixtures.0.clone());

        let preview = inspect(&home.0, "ada/review-kit", None, &git, &no_avatar).unwrap();
        assert_eq!(preview.kind, "plugin");
        assert_eq!(preview.plugin_id.as_deref(), Some("review-kit"));
        assert!(!preview.installed);
        assert!(preview.conflicts.iter().any(|conflict| conflict.contains("ship")));

        let outcome = install(&home.0, &preview.token, None).unwrap();
        assert_eq!(outcome.skills, vec!["review"]);
        assert!(outcome.commands.is_empty(), "the user's own ship skill is kept");
        assert!(outcome.problems.iter().any(|problem| problem.contains("ship")));
        assert_eq!(outcome.servers, vec!["docs", "remote"]);
        let skill = home.0.join(".agents/skills/review");
        assert!(skill.join("SKILL.md").is_file() && skill.join("checklist.md").is_file());
        assert_eq!(fs::read_to_string(home.0.join(".agents/skills/ship/SKILL.md")).unwrap(), "---\nname: ship\ndescription: mine\n---\n");
        let config: Value = serde_json::from_str(&fs::read_to_string(home.0.join(".glitter/mcp.json")).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["mine"]["command"], "x");
        let installed_root = home.0.join(".glitter/plugins/review-kit/source");
        assert_eq!(config["mcpServers"]["docs"]["command"], format!("{}/bin/docs", installed_root.display()));
        assert!(!staging_root(&home.0).join(&preview.token).exists(), "the preview is cleared after install");

        let listed = library(&home.0);
        assert_eq!(listed.plugins.len(), 1);
        assert_eq!(listed.plugins[0].origin.commit, SHA);
        assert_eq!(listed.plugins[0].agents, vec!["helper"]);

        set_enabled(&home.0, "review-kit", false).unwrap();
        assert!(!skill.exists());
        let config: Value = serde_json::from_str(&fs::read_to_string(home.0.join(".glitter/mcp.json")).unwrap()).unwrap();
        assert!(config["mcpServers"].get("docs").is_none());
        assert_eq!(config["mcpServers"]["mine"]["command"], "x");
        assert!(!library(&home.0).plugins[0].enabled);

        let back = set_enabled(&home.0, "review-kit", true).unwrap();
        assert_eq!(back.skills, vec!["review"]);
        assert!(skill.join("SKILL.md").is_file());

        // A server the user edited after install is kept on removal.
        let mut config: Value = serde_json::from_str(&fs::read_to_string(home.0.join(".glitter/mcp.json")).unwrap()).unwrap();
        config["mcpServers"]["remote"]["url"] = json!("https://changed.example/mcp");
        fs::write(home.0.join(".glitter/mcp.json"), serde_json::to_string(&config).unwrap()).unwrap();
        let problems = remove(&home.0, "review-kit").unwrap();
        assert!(problems.iter().any(|problem| problem.contains("remote")));
        assert!(!skill.exists());
        assert!(!home.0.join(".glitter/plugins/review-kit").exists());
        let config: Value = serde_json::from_str(&fs::read_to_string(home.0.join(".glitter/mcp.json")).unwrap()).unwrap();
        assert!(config["mcpServers"].get("docs").is_none());
        assert_eq!(config["mcpServers"]["remote"]["url"], "https://changed.example/mcp");
        assert!(home.0.join(".agents/skills/ship/SKILL.md").is_file());
    }

    #[test]
    fn a_selection_installs_only_the_chosen_skills() {
        let home = TempDir::new("select-home");
        let fixtures = TempDir::new("select-fixtures");
        write(&fixtures.0.join("o_many"), "skills/a/SKILL.md", "---\nname: a\ndescription: A\n---\n");
        write(&fixtures.0.join("o_many"), "skills/b/SKILL.md", "---\nname: b\ndescription: B\n---\n");
        let git = fake_git(fixtures.0.clone());
        let preview = inspect(&home.0, "o/many", None, &git, &no_avatar).unwrap();
        let outcome = install(&home.0, &preview.token, Some(vec!["b".into()])).unwrap();
        assert_eq!(outcome.skills, vec!["b"]);
        assert!(!home.0.join(".agents/skills/a").exists());
    }

    #[test]
    fn marketplaces_are_added_and_their_plugins_installed_from_their_own_repository() {
        let home = TempDir::new("mkt-home");
        let fixtures = TempDir::new("mkt-fixtures");
        let market = fixtures.0.join("team_market");
        write(&market, ".claude-plugin/marketplace.json", r#"{"name":"Team Tools","plugins":[
            {"name":"local-kit","source":"./plugins/local","description":"Local"},
            {"name":"docs-kit","description":"Doc skills","source":"./","strict":false,"skills":["./skills/docx"]},
            {"name":"remote-kit","source":{"source":"git-subdir","url":"https://github.com/acme/tools.git","path":"plugins/r"}}
        ]}"#);
        write(&market, "plugins/local/.claude-plugin/plugin.json", r#"{"name":"local-kit"}"#);
        write(&market, "plugins/local/skills/lint/SKILL.md", "---\nname: lint\ndescription: Lint\n---\n");
        write(&market, "skills/docx/SKILL.md", "---\nname: docx\ndescription: Word\n---\n");
        write(&market, "skills/xlsx/SKILL.md", "---\nname: xlsx\ndescription: Excel\n---\n");
        write(&fixtures.0.join("acme_tools"), "plugins/r/skills/remote/SKILL.md", "---\nname: remote\ndescription: Remote\n---\n");
        let git = fake_git(fixtures.0.clone());

        let preview = inspect(&home.0, "team/market", None, &git, &no_avatar).unwrap();
        assert_eq!(preview.kind, "marketplace");
        assert!(install(&home.0, &preview.token, None).is_err(), "a marketplace is added, not installed");
        let added = add_marketplace(&home.0, &preview.token).unwrap();
        assert_eq!(added.id, "team-tools");
        assert_eq!(added.plugins.len(), 3);
        assert_eq!(library(&home.0).marketplaces.len(), 1);

        let local = inspect(&home.0, "team/market", Some("local-kit"), &git, &no_avatar).unwrap();
        assert_eq!(local.plugin.as_ref().unwrap().skills[0].name, "lint");
        install(&home.0, &local.token, None).unwrap();

        let strict = inspect(&home.0, "team/market", Some("docs-kit"), &git, &no_avatar).unwrap();
        let names: Vec<_> = strict.plugin.as_ref().unwrap().skills.iter().map(|skill| skill.name.clone()).collect();
        assert_eq!(names, vec!["docx"], "a strict:false listing names its own skills");

        let remote = inspect(&home.0, "team/market", Some("remote-kit"), &git, &no_avatar).unwrap();
        assert_eq!(remote.plugin.as_ref().unwrap().skills[0].name, "remote");
        let outcome = install(&home.0, &remote.token, None).unwrap();
        assert_eq!(outcome.skills, vec!["remote"]);
        let listed = library(&home.0);
        let remote_row = listed.plugins.iter().find(|plugin| plugin.id == "remote-kit").unwrap();
        assert_eq!(remote_row.origin.plugin.as_deref(), Some("remote-kit"));
        assert!(remote_row.origin.url.contains("acme/tools"));

        remove_marketplace(&home.0, "team-tools").unwrap();
        assert!(library(&home.0).marketplaces.is_empty());
    }

    #[test]
    fn a_plugin_from_another_repository_with_the_same_name_is_refused() {
        let home = TempDir::new("clash-home");
        let fixtures = TempDir::new("clash-fixtures");
        write(&fixtures.0.join("a_kit"), "skills/x/SKILL.md", "---\nname: x\ndescription: X\n---\n");
        write(&fixtures.0.join("b_kit"), "skills/y/SKILL.md", "---\nname: y\ndescription: Y\n---\n");
        let git = fake_git(fixtures.0.clone());
        let first = inspect(&home.0, "a/kit", None, &git, &no_avatar).unwrap();
        install(&home.0, &first.token, None).unwrap();
        let second = inspect(&home.0, "b/kit", None, &git, &no_avatar).unwrap();
        assert!(install(&home.0, &second.token, None).unwrap_err().contains("already installed"));
        // Reinstalling from the same repository is an update.
        let again = inspect(&home.0, "a/kit", None, &git, &no_avatar).unwrap();
        assert!(again.installed);
        assert_eq!(install(&home.0, &again.token, None).unwrap().skills, vec!["x"]);
    }

    #[test]
    fn a_missing_repository_and_an_empty_one_explain_themselves() {
        let home = TempDir::new("missing-home");
        let fixtures = TempDir::new("missing-fixtures");
        write(&fixtures.0.join("o_empty"), "README.md", "nothing");
        let git = fake_git(fixtures.0.clone());
        assert!(inspect(&home.0, "o/nope", None, &git, &no_avatar).unwrap_err().contains("Could not reach o/nope"));
        assert!(inspect(&home.0, "o/empty", None, &git, &no_avatar).unwrap_err().contains("No plugin"));
        assert!(sorted_children(&staging_root(&home.0)).is_empty(), "failed previews leave nothing behind");
    }

    #[test]
    fn store_markers_never_claim_a_plugin_skill() {
        let home = TempDir::new("marker");
        write(&home.0, ".agents/skills/code-review/SKILL.md", "---\nname: code-review\ndescription: x\n---\n");
        write(&home.0, &format!(".agents/skills/code-review/{MARKER}"), r#"{"id":"code-review","plugin":"kit"}"#);
        let result = crate::catalog::remove(&home.0, None, "code-review").unwrap();
        assert_eq!(result.errors.len(), 1, "the store refuses to delete a plugin's skill");
        assert!(home.0.join(".agents/skills/code-review/SKILL.md").is_file());
    }

    #[test]
    fn slugs_are_safe_folder_names() {
        assert_eq!(slug("Review Kit"), "review-kit");
        assert_eq!(slug("../../etc"), "etc");
        assert_eq!(slug("!!!"), "plugin");
        assert!(valid_id(&slug(&"x".repeat(200))));
    }
}
