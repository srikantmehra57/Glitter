//! The bundled extension store. Skills and MCP servers ship inside the app so
//! installation needs no network and the renderer never supplies file content.
//! Skills go to `~/.agents/skills/<id>` (the Harness reads `.agents/skills` and
//! `.glitter/skills`); MCP servers are merged into `.glitter/mcp.json` in the
//! workspace or the home folder. A marker file records store ownership, so
//! removing an entry never deletes a folder the user made.
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

const SKILLS_DIR: [&str; 2] = [".agents", "skills"];
const MCP_FILE: [&str; 2] = [".glitter", "mcp.json"];
const MARKER: &str = ".glitter-catalog.json";
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

pub struct CatalogSkill {
    id: &'static str,
    name: &'static str,
    summary: &'static str,
    description: &'static str,
    tags: &'static [&'static str],
    version: u32,
    files: &'static [(&'static str, &'static str)],
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServerScope {
    User,
    Workspace,
}

pub struct CatalogServer {
    id: &'static str,
    name: &'static str,
    summary: &'static str,
    description: &'static str,
    tags: &'static [&'static str],
    scope: ServerScope,
    transport: &'static str,
    command: &'static str,
    args: &'static [&'static str],
    env: &'static [(&'static str, &'static str)],
    url: &'static str,
    version: u32,
}

pub struct CatalogPlugin {
    id: &'static str,
    name: &'static str,
    summary: &'static str,
    description: &'static str,
    tags: &'static [&'static str],
    version: u32,
    skills: &'static [&'static str],
    servers: &'static [&'static str],
}

const SKILLS: &[CatalogSkill] = &[
    CatalogSkill {
        id: "code-review",
        name: "Code review",
        summary: "Review a diff for correctness, security and missing tests.",
        description: "Find the defects that matter, with a file and line, the failure mode, and a concrete fix. Reports only actionable findings and separates blocking issues from nits.",
        tags: &["quality", "git"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/code-review/SKILL.md"))],
    },
    CatalogSkill {
        id: "commit-message",
        name: "Commit message",
        summary: "Write a Conventional Commits message from the staged change.",
        description: "Reads the staged diff, picks the right type, and writes an imperative subject plus a why-focused body when one is needed.",
        tags: &["git", "everyday"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/commit-message/SKILL.md"))],
    },
    CatalogSkill {
        id: "pr-description",
        name: "Pull request description",
        summary: "Turn a branch into a clear PR title, summary and test plan.",
        description: "Explains the change as one reviewable unit: behavior change, approach, risks, verification, and known follow-ups.",
        tags: &["git", "review"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/pr-description/SKILL.md"))],
    },
    CatalogSkill {
        id: "test-first",
        name: "Test first",
        summary: "One failing test, the smallest fix, then cleanup.",
        description: "A disciplined TDD loop for new behavior and bug fixes: reproduce, make it pass, cover the edge cases, refactor with the suite green.",
        tags: &["testing"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/test-first/SKILL.md"))],
    },
    CatalogSkill {
        id: "debug",
        name: "Debug",
        summary: "Find the root cause with evidence before changing code.",
        description: "Reproduce the smallest failing case, trace the path, test one hypothesis at a time, then fix the cause and add a regression test.",
        tags: &["quality", "diagnostics"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/debug/SKILL.md"))],
    },
    CatalogSkill {
        id: "refactor",
        name: "Refactor",
        summary: "Improve structure without changing behavior, in verified steps.",
        description: "Names the behavior the tests pin, makes one move at a time, and keeps refactors separate from behavior changes and reformatting.",
        tags: &["quality"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/refactor/SKILL.md"))],
    },
    CatalogSkill {
        id: "security-review",
        name: "Security review",
        summary: "Check for injection, secret exposure and unsafe input handling.",
        description: "A concrete checklist across trust boundaries: injection, authorization, secrets, SSRF, crypto, file handling and denial of service.",
        tags: &["security", "quality"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/security-review/SKILL.md"))],
    },
    CatalogSkill {
        id: "performance",
        name: "Performance",
        summary: "Find and fix a measured bottleneck instead of guessing.",
        description: "Set a budget, record a baseline, follow the largest cost, change one thing, and re-measure with the same input and environment.",
        tags: &["performance"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/performance/SKILL.md"))],
    },
    CatalogSkill {
        id: "frontend-design",
        name: "Frontend design",
        summary: "Give an interface a deliberate visual direction.",
        description: "Works from real content and the existing design system, then makes intentional choices for type, color, spacing, depth and motion, including empty and error states.",
        tags: &["design", "frontend"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/frontend-design/SKILL.md"))],
    },
    CatalogSkill {
        id: "docs-writer",
        name: "Docs writer",
        summary: "Write README and API docs that match the code.",
        description: "Identifies the reader's job, verifies every command in the environment it describes, and documents configuration, failure modes and recovery.",
        tags: &["docs"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/docs-writer/SKILL.md"))],
    },
    CatalogSkill {
        id: "explain-code",
        name: "Explain code",
        summary: "Explain unfamiliar code from entry point to data flow.",
        description: "Traces the real path, maps boundaries, state and timing, separates what the code does from what it appears intended to do, and ends with where to change it.",
        tags: &["onboarding", "docs"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/explain-code/SKILL.md"))],
    },
    CatalogSkill {
        id: "release-notes",
        name: "Release notes",
        summary: "Turn merged changes into user-facing release notes.",
        description: "Writes outcomes rather than commit subjects, grouped into New, Improved, Fixed and Breaking, with migration steps where they are needed.",
        tags: &["docs", "release"],
        version: 1,
        files: &[("SKILL.md", include_str!("../catalog/skills/release-notes/SKILL.md"))],
    },
];

const SERVERS: &[CatalogServer] = &[
    CatalogServer {
        id: "filesystem",
        name: "Filesystem",
        summary: "Read and write files inside this workspace.",
        description: "The reference filesystem server, configured for this workspace. Tool calls follow the thread's permissions and grants.",
        tags: &["files", "workspace"],
        scope: ServerScope::Workspace,
        transport: "stdio",
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-filesystem", "{workspace}"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "sequential-thinking",
        name: "Sequential thinking",
        summary: "A scratchpad for structured, revisable reasoning.",
        description: "The reference sequential-thinking server: the model can record numbered thoughts, revise them, and branch when a plan changes.",
        tags: &["reasoning"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-sequential-thinking"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "memory",
        name: "Memory",
        summary: "A persistent knowledge graph between threads.",
        description: "The reference memory server, stored in your Glitter data folder rather than inside a repository. Entities and relations survive restarts.",
        tags: &["memory"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "npx",
        args: &["-y", "@modelcontextprotocol/server-memory"],
        env: &[("MEMORY_FILE_PATH", "{home}/.glitter/mcp-memory.json")],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "fetch",
        name: "Fetch",
        summary: "Fetch a URL and convert its content for the model.",
        description: "The reference fetch server. It retrieves a page or document and converts it to Markdown, with robots.txt handling. It is a Python server and runs with uv's uvx.",
        tags: &["web"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "uvx",
        args: &["mcp-server-fetch"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "time",
        name: "Time",
        summary: "Current time and timezone conversions.",
        description: "The reference time server: the model can ask for the current time in a named timezone and convert between zones. It is a Python server and runs with uv's uvx.",
        tags: &["utilities"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "uvx",
        args: &["mcp-server-time"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "playwright",
        name: "Playwright",
        summary: "Drive a real browser: pages, clicks, forms and screenshots.",
        description: "Microsoft's Playwright MCP server. It opens a browser for the agent, with accessibility snapshots and real interactions. The browser downloads on first use.",
        tags: &["browser", "testing"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "npx",
        args: &["-y", "@playwright/mcp@latest"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "context7",
        name: "Context7",
        summary: "Up-to-date documentation for libraries and frameworks.",
        description: "Upstash's Context7 server resolves a library and returns current documentation and examples, so the model does not rely on stale training data.",
        tags: &["docs", "web"],
        scope: ServerScope::User,
        transport: "stdio",
        command: "npx",
        args: &["-y", "@upstash/context7-mcp"],
        env: &[],
        url: "",
        version: 1,
    },
    CatalogServer {
        id: "deepwiki",
        name: "DeepWiki",
        summary: "Ask questions about any public GitHub repository.",
        description: "A free, no-authentication remote server that reads public repositories and answers architecture and usage questions. Nothing is installed locally.",
        tags: &["docs", "remote"],
        scope: ServerScope::User,
        transport: "http",
        command: "",
        args: &[],
        env: &[],
        url: "https://mcp.deepwiki.com/mcp",
        version: 1,
    },
];

const PLUGINS: &[CatalogPlugin] = &[
    CatalogPlugin {
        id: "daily-driver",
        name: "Daily driver",
        summary: "Review, commit and open a PR with one consistent voice.",
        description: "The three skills used on every change, plus sequential thinking for plans that need room. Installs four parts in one click.",
        tags: &["git", "everyday"],
        version: 1,
        skills: &["code-review", "commit-message", "pr-description"],
        servers: &["sequential-thinking"],
    },
    CatalogPlugin {
        id: "quality-gate",
        name: "Quality gate",
        summary: "Test-first changes, a security pass, and measured performance.",
        description: "A review discipline for code that has to hold up: write the failing test, audit the trust boundaries, and only optimize what you measured.",
        tags: &["quality", "testing", "security"],
        version: 1,
        skills: &["test-first", "security-review", "performance"],
        servers: &[],
    },
    CatalogPlugin {
        id: "frontend",
        name: "Frontend",
        summary: "A deliberate UI direction, with a real browser to check it.",
        description: "Pairs the frontend design skill with the Playwright server, so the agent can open the result and test the interaction instead of describing it.",
        tags: &["design", "frontend", "browser"],
        version: 1,
        skills: &["frontend-design", "debug"],
        servers: &["playwright"],
    },
    CatalogPlugin {
        id: "docs-and-release",
        name: "Docs and release",
        summary: "Explain the code, write the docs, ship the notes.",
        description: "Three writing skills for the end of a project: onboard a reader, document the API against the code, and turn the merged work into release notes.",
        tags: &["docs", "release"],
        version: 1,
        skills: &["docs-writer", "explain-code", "release-notes"],
        servers: &[],
    },
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub tags: Vec<String>,
    pub version: u32,
    pub skills: Vec<String>,
    pub servers: Vec<String>,
    pub scope: String,
    pub requires_workspace: bool,
    pub commands: Vec<String>,
    pub installed: bool,
    pub installed_parts: u32,
    pub total_parts: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogList {
    pub entries: Vec<CatalogEntry>,
    pub skills_root: String,
    pub error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub installed_skills: Vec<String>,
    pub installed_servers: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RemoveResult {
    pub removed: Vec<String>,
    pub skipped: Vec<String>,
    pub errors: Vec<String>,
}

enum Entry<'a> {
    Skill(&'a CatalogSkill),
    Server(&'a CatalogServer),
    Plugin(&'a CatalogPlugin),
}

impl<'a> Entry<'a> {
    fn skills(&self) -> Vec<&'a CatalogSkill> {
        match self {
            Entry::Skill(skill) => vec![*skill],
            Entry::Server(_) => Vec::new(),
            Entry::Plugin(plugin) => plugin
                .skills
                .iter()
                .filter_map(|id| SKILLS.iter().find(|skill| skill.id == *id))
                .collect(),
        }
    }

    fn servers(&self) -> Vec<&'a CatalogServer> {
        match self {
            Entry::Skill(_) => Vec::new(),
            Entry::Server(server) => vec![*server],
            Entry::Plugin(plugin) => plugin
                .servers
                .iter()
                .filter_map(|id| SERVERS.iter().find(|server| server.id == *id))
                .collect(),
        }
    }
}

fn find_entry(id: &str) -> Option<Entry<'static>> {
    if let Some(skill) = SKILLS.iter().find(|skill| skill.id == id) {
        return Some(Entry::Skill(skill));
    }
    if let Some(plugin) = PLUGINS.iter().find(|plugin| plugin.id == id) {
        return Some(Entry::Plugin(plugin));
    }
    SERVERS.iter().find(|server| server.id == id).map(Entry::Server)
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn skills_root(home: &Path) -> PathBuf {
    SKILLS_DIR.iter().fold(home.to_path_buf(), |path, part| path.join(part))
}

fn config_path(root: &Path) -> PathBuf {
    MCP_FILE.iter().fold(root.to_path_buf(), |path, part| path.join(part))
}

/// A relative path with no `..`, root or prefix components.
fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) if !part.is_empty() => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

fn substitute(text: &str, home: &Path, workspace: Option<&Path>) -> String {
    let workspace = workspace.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default();
    text.replace("{home}", &home.to_string_lossy()).replace("{workspace}", &workspace)
}

fn marker_matches(folder: &Path, id: &str) -> bool {
    match fs::read_to_string(folder.join(MARKER)) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .ok()
            .and_then(|value| value.get("id").and_then(Value::as_str).map(|value| value == id))
            .unwrap_or(false),
        Err(_) => false,
    }
}

fn install_skill(home: &Path, skill: &CatalogSkill) -> Result<bool, String> {
    if !valid_id(skill.id) {
        return Err(format!("The catalog entry {} has an invalid skill name.", skill.id));
    }
    let folder = skills_root(home).join(skill.id);
    if folder.exists() {
        if marker_matches(&folder, skill.id) {
            return Ok(false);
        }
        return Err(format!(
            "A skill folder already exists at {}. It was not installed from the store, so it was left alone.",
            folder.display()
        ));
    }
    fs::create_dir_all(&folder).map_err(|error| format!("Could not create {}: {error}", folder.display()))?;
    let result = (|| {
        for (name, content) in skill.files {
            let relative = safe_relative(name).ok_or_else(|| format!("The catalog entry {} has an unsafe file path.", skill.id))?;
            let path = folder.join(relative);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
            }
            fs::write(&path, content).map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        }
        let marker = json!({ "id": skill.id, "version": skill.version });
        fs::write(folder.join(MARKER), serde_json::to_vec_pretty(&marker).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Could not write the install marker: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&folder);
        return Err(error);
    }
    Ok(true)
}

fn read_config(file: &Path) -> Result<Value, String> {
    let metadata = match fs::metadata(file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(error) => return Err(format!("Could not read {}: {error}", file.display())),
    };
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(format!("{} is larger than {} bytes.", file.display(), MAX_CONFIG_BYTES));
    }
    let raw = fs::read_to_string(file).map_err(|error| format!("Could not read {}: {error}", file.display()))?;
    let value: Value = serde_json::from_str(&raw).map_err(|error| format!("{} is not valid JSON: {error}", file.display()))?;
    if !value.is_object() {
        return Err(format!("{} must contain a JSON object.", file.display()));
    }
    Ok(value)
}

fn server_names(file: &Path) -> Result<Vec<String>, String> {
    let document = read_config(file)?;
    let object = document.as_object().expect("read_config returns an object");
    // The bridge accepts a bare server map as the legacy shape; count those too.
    let servers = object.get("mcpServers").unwrap_or(&document);
    let servers = servers.as_object().ok_or_else(|| format!("{}: mcpServers must be an object.", file.display()))?;
    Ok(servers.keys().cloned().collect())
}

/// The `mcpServers` map, wrapping a legacy bare server map so the bridge keeps
/// seeing every server after the store adds one.
fn document_servers_mut<'a>(document: &'a mut Value, file: &Path) -> Result<&'a mut Map<String, Value>, String> {
    let object = document.as_object_mut().expect("read_config returns an object");
    if !object.contains_key("mcpServers") {
        let legacy = std::mem::take(object);
        object.insert("mcpServers".into(), Value::Object(legacy));
    }
    object
        .get_mut("mcpServers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{}: mcpServers must be an object.", file.display()))
}

fn expected_server(server: &CatalogServer, home: &Path, workspace: Option<&Path>) -> Value {
    let mut value = Map::new();
    value.insert("transport".into(), json!(server.transport));
    if server.transport == "stdio" {
        value.insert("command".into(), json!(server.command));
        value.insert("args".into(), json!(server.args.iter().map(|arg| substitute(arg, home, workspace)).collect::<Vec<_>>()));
    } else {
        value.insert("url".into(), json!(substitute(server.url, home, workspace)));
    }
    if !server.env.is_empty() {
        let env: Map<String, Value> = server
            .env
            .iter()
            .map(|(key, value)| (key.to_string(), json!(substitute(value, home, workspace))))
            .collect();
        value.insert("env".into(), Value::Object(env));
    }
    Value::Object(value)
}

fn same_server(existing: &Value, expected: &Value) -> bool {
    let Some(existing) = existing.as_object() else {
        return false;
    };
    let Some(expected) = expected.as_object() else {
        return false;
    };
    if existing.get("transport") != expected.get("transport") {
        return false;
    }
    if existing.get("command") != expected.get("command") || existing.get("args") != expected.get("args") || existing.get("url") != expected.get("url") {
        return false;
    }
    let empty = Map::new();
    existing.get("env").and_then(Value::as_object).unwrap_or(&empty) == expected.get("env").and_then(Value::as_object).unwrap_or(&empty)
}

fn root_for(scope: ServerScope, home: &Path, workspace: Option<&Path>) -> Result<PathBuf, String> {
    match scope {
        ServerScope::User => Ok(home.to_path_buf()),
        ServerScope::Workspace => workspace
            .map(Path::to_path_buf)
            .ok_or_else(|| "Open a workspace before installing this extension.".to_string()),
    }
}

fn install_server(home: &Path, workspace: Option<&Path>, server: &CatalogServer) -> Result<bool, String> {
    if !valid_id(server.id) {
        return Err(format!("The catalog entry {} has an invalid server name.", server.id));
    }
    let root = root_for(server.scope, home, workspace)?;
    let file = config_path(&root);
    let mut document = read_config(&file)?;
    let expected = expected_server(server, home, workspace);
    let servers = document_servers_mut(&mut document, &file)?;
    if let Some(existing) = servers.get(server.id) {
        if same_server(existing, &expected) {
            return Ok(false);
        }
        return Err(format!(
            "An MCP server named {} is already configured in {} with different settings.",
            server.id,
            file.display()
        ));
    }
    servers.insert(server.id.to_string(), expected);
    write_config(&file, &document)?;
    Ok(true)
}

fn write_config(file: &Path, document: &Value) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let body = serde_json::to_vec_pretty(document).map_err(|error| error.to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let temp = file.with_file_name(format!(".mcp-{}-{}.tmp", std::process::id(), nonce));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options.open(&temp).map_err(|error| format!("Could not write {}: {error}", temp.display()))?;
    if let Err(error) = std::io::Write::write_all(&mut handle, &body) {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not write {}: {error}", temp.display()));
    }
    drop(handle);
    fs::rename(&temp, file).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Could not replace {}: {error}", file.display())
    })
}

fn remove_skill(home: &Path, skill: &CatalogSkill) -> Result<bool, String> {
    let folder = skills_root(home).join(skill.id);
    if !folder.exists() {
        return Ok(false);
    }
    if !marker_matches(&folder, skill.id) {
        return Err(format!(
            "{} was not installed from the store. Remove it yourself if you no longer want it.",
            folder.display()
        ));
    }
    let metadata = fs::symlink_metadata(&folder).map_err(|error| format!("Could not inspect {}: {error}", folder.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a folder.", folder.display()));
    }
    fs::remove_dir_all(&folder).map_err(|error| format!("Could not remove {}: {error}", folder.display()))?;
    Ok(true)
}

fn remove_server(home: &Path, workspace: Option<&Path>, server: &CatalogServer) -> Result<bool, String> {
    let root = root_for(server.scope, home, workspace)?;
    let file = config_path(&root);
    let mut document = read_config(&file)?;
    let expected = expected_server(server, home, workspace);
    let object = document.as_object_mut().expect("read_config returns an object");
    let Some(servers) = object.get_mut("mcpServers").and_then(Value::as_object_mut) else {
        return Ok(false);
    };
    let Some(existing) = servers.get(server.id) else {
        return Ok(false);
    };
    if !same_server(existing, &expected) {
        return Err(format!(
            "The server {} in {} was changed after installation. Remove it there if you no longer want it.",
            server.id,
            file.display()
        ));
    }
    servers.remove(server.id);
    write_config(&file, &document)?;
    Ok(true)
}

fn installed_skills(home: &Path) -> Vec<String> {
    let root = skills_root(home);
    SKILLS
        .iter()
        .filter(|skill| root.join(skill.id).join("SKILL.md").is_file())
        .map(|skill| skill.id.to_string())
        .collect()
}

fn installed_servers(home: &Path, workspace: Option<&Path>) -> (Vec<String>, Option<String>) {
    let mut names = Vec::new();
    let mut error = None;
    let mut roots = vec![home.to_path_buf()];
    if let Some(workspace) = workspace {
        if workspace != home {
            roots.push(workspace.to_path_buf());
        }
    }
    for root in roots {
        match server_names(&config_path(&root)) {
            Ok(found) => names.extend(found),
            Err(problem) => error = Some(problem),
        }
    }
    (names, error)
}

fn entry_scope(servers: &[&CatalogServer]) -> &'static str {
    let workspace = servers.iter().any(|server| server.scope == ServerScope::Workspace);
    let user = servers.iter().any(|server| server.scope == ServerScope::User);
    if workspace && user {
        "mixed"
    } else if workspace {
        "workspace"
    } else {
        "user"
    }
}

fn display_commands(servers: &[&CatalogServer], home: &Path, workspace: Option<&Path>) -> Vec<String> {
    servers
        .iter()
        .map(|server| {
            if server.transport == "http" {
                substitute(server.url, home, workspace)
            } else {
                let args = server.args.iter().map(|arg| substitute(arg, home, workspace)).collect::<Vec<_>>();
                std::iter::once(server.command.to_string()).chain(args).collect::<Vec<_>>().join(" ")
            }
        })
        .collect()
}

struct EntrySpec<'a> {
    id: &'a str,
    kind: &'a str,
    name: &'a str,
    summary: &'a str,
    description: &'a str,
    tags: &'a [&'a str],
    version: u32,
    skills: &'a [&'a CatalogSkill],
    servers: &'a [&'a CatalogServer],
}

struct EntryState<'a> {
    skills_installed: &'a [String],
    servers_installed: &'a [String],
    home: &'a Path,
    workspace: Option<&'a Path>,
}

fn entry_row(entry: EntrySpec<'_>, state: &EntryState<'_>) -> CatalogEntry {
    let EntrySpec { id, kind, name, summary, description, tags, version, skills, servers } = entry;
    let skill_names: Vec<String> = skills.iter().map(|skill| skill.id.to_string()).collect();
    let server_names: Vec<String> = servers.iter().map(|server| server.id.to_string()).collect();
    let installed_parts = skill_names.iter().filter(|id| state.skills_installed.contains(id)).count()
        + server_names.iter().filter(|id| state.servers_installed.contains(id)).count();
    let total_parts = skill_names.len() + server_names.len();
    CatalogEntry {
        id: id.to_string(),
        kind: kind.to_string(),
        name: name.to_string(),
        summary: summary.to_string(),
        description: description.to_string(),
        tags: tags.iter().map(|tag| tag.to_string()).collect(),
        version,
        skills: skill_names,
        servers: server_names,
        scope: entry_scope(servers).to_string(),
        requires_workspace: servers.iter().any(|server| server.scope == ServerScope::Workspace),
        commands: display_commands(servers, state.home, state.workspace),
        installed: total_parts > 0 && installed_parts == total_parts,
        installed_parts: installed_parts as u32,
        total_parts: total_parts as u32,
    }
}

pub fn list(home: &Path, workspace: Option<&Path>) -> CatalogList {
    let skills_installed = installed_skills(home);
    let (servers_installed, error) = installed_servers(home, workspace);
    let state = EntryState { skills_installed: &skills_installed, servers_installed: &servers_installed, home, workspace };
    let mut entries = Vec::new();
    for plugin in PLUGINS {
        let skills = plugin
            .skills
            .iter()
            .filter_map(|id| SKILLS.iter().find(|skill| skill.id == *id))
            .collect::<Vec<_>>();
        let servers = plugin
            .servers
            .iter()
            .filter_map(|id| SERVERS.iter().find(|server| server.id == *id))
            .collect::<Vec<_>>();
        entries.push(entry_row(EntrySpec {
            id: plugin.id,
            kind: "plugin",
            name: plugin.name,
            summary: plugin.summary,
            description: plugin.description,
            tags: plugin.tags,
            version: plugin.version,
            skills: &skills,
            servers: &servers,
        }, &state));
    }
    for skill in SKILLS {
        entries.push(entry_row(EntrySpec {
            id: skill.id,
            kind: "skill",
            name: skill.name,
            summary: skill.summary,
            description: skill.description,
            tags: skill.tags,
            version: skill.version,
            skills: &[skill],
            servers: &[],
        }, &state));
    }
    for server in SERVERS {
        entries.push(entry_row(EntrySpec {
            id: server.id,
            kind: "mcp",
            name: server.name,
            summary: server.summary,
            description: server.description,
            tags: server.tags,
            version: server.version,
            skills: &[],
            servers: &[server],
        }, &state));
    }
    CatalogList {
        entries,
        skills_root: skills_root(home).to_string_lossy().into_owned(),
        error,
    }
}

pub fn install(home: &Path, workspace: Option<&Path>, entry_id: &str) -> Result<InstallResult, String> {
    let entry = find_entry(entry_id).ok_or_else(|| "That extension is not in the bundled catalog.".to_string())?;
    let skills = entry.skills();
    let servers = entry.servers();
    if servers.iter().any(|server| server.scope == ServerScope::Workspace) && workspace.is_none() {
        return Err("Open a workspace before installing this extension.".to_string());
    }
    let mut result = InstallResult::default();
    for skill in skills {
        match install_skill(home, skill) {
            Ok(true) => result.installed_skills.push(skill.id.to_string()),
            Ok(false) => result.skipped.push(skill.id.to_string()),
            Err(error) => result.errors.push(error),
        }
    }
    for server in servers {
        match install_server(home, workspace, server) {
            Ok(true) => result.installed_servers.push(server.id.to_string()),
            Ok(false) => result.skipped.push(server.id.to_string()),
            Err(error) => result.errors.push(error),
        }
    }
    Ok(result)
}

pub fn remove(home: &Path, workspace: Option<&Path>, entry_id: &str) -> Result<RemoveResult, String> {
    let entry = find_entry(entry_id).ok_or_else(|| "That extension is not in the bundled catalog.".to_string())?;
    let mut result = RemoveResult::default();
    for skill in entry.skills() {
        match remove_skill(home, skill) {
            Ok(true) => result.removed.push(skill.id.to_string()),
            Ok(false) => result.skipped.push(skill.id.to_string()),
            Err(error) => result.errors.push(error),
        }
    }
    for server in entry.servers() {
        match remove_server(home, workspace, server) {
            Ok(true) => result.removed.push(server.id.to_string()),
            Ok(false) => result.skipped.push(server.id.to_string()),
            Err(error) => result.errors.push(error),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("glitter-catalog-{}-{tag}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn catalog_references_resolve() {
        for plugin in PLUGINS {
            for id in plugin.skills {
                assert!(SKILLS.iter().any(|skill| skill.id == *id), "{} names unknown skill {id}", plugin.id);
            }
            for id in plugin.servers {
                assert!(SERVERS.iter().any(|server| server.id == *id), "{} names unknown server {id}", plugin.id);
            }
        }
        let mut ids = std::collections::HashSet::new();
        for id in SKILLS.iter().map(|entry| entry.id).chain(PLUGINS.iter().map(|entry| entry.id)).chain(SERVERS.iter().map(|entry| entry.id)) {
            assert!(valid_id(id), "invalid catalog id {id}");
            assert!(ids.insert(id), "duplicate catalog id {id}");
        }
        for skill in SKILLS {
            assert!(skill.files.iter().any(|(name, _)| *name == "SKILL.md"), "{} has no SKILL.md", skill.id);
            for (name, _) in skill.files {
                assert!(safe_relative(name).is_some(), "{} has an unsafe path {name}", skill.id);
            }
        }
    }

    #[test]
    fn skill_install_writes_files_and_a_marker() {
        let home = TempDir::new("skill");
        let result = install(&home.0, None, "code-review").unwrap();
        assert_eq!(result.installed_skills, vec!["code-review"]);
        assert!(result.errors.is_empty());
        let folder = home.0.join(".agents/skills/code-review");
        assert!(folder.join("SKILL.md").is_file());
        let marker = read_json(&folder.join(MARKER));
        assert_eq!(marker["id"], "code-review");
        assert_eq!(marker["version"], 1);
        let listed = list(&home.0, None);
        assert!(listed.entries.iter().find(|entry| entry.id == "code-review").unwrap().installed);
    }

    #[test]
    fn install_is_idempotent_and_keeps_a_foreign_folder() {
        let home = TempDir::new("idempotent");
        assert_eq!(install(&home.0, None, "code-review").unwrap().installed_skills.len(), 1);
        let again = install(&home.0, None, "code-review").unwrap();
        assert!(again.installed_skills.is_empty());
        assert_eq!(again.skipped, vec!["code-review"]);

        let foreign = home.0.join(".agents/skills/commit-message");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "mine").unwrap();
        let result = install(&home.0, None, "commit-message").unwrap();
        assert!(result.installed_skills.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(fs::read_to_string(foreign.join("SKILL.md")).unwrap(), "mine");
    }

    #[test]
    fn plugin_installs_every_part() {
        let home = TempDir::new("plugin");
        let result = install(&home.0, None, "daily-driver").unwrap();
        assert_eq!(result.installed_skills.len(), 3);
        assert_eq!(result.installed_servers, vec!["sequential-thinking"]);
        let config = read_json(&home.0.join(".glitter/mcp.json"));
        assert_eq!(config["mcpServers"]["sequential-thinking"]["command"], "npx");
        let listed = list(&home.0, None);
        let plugin = listed.entries.iter().find(|entry| entry.id == "daily-driver").unwrap();
        assert_eq!(plugin.installed_parts, 4);
        assert_eq!(plugin.total_parts, 4);
        assert!(plugin.installed);
    }

    #[test]
    fn server_install_merges_and_preserves_other_entries() {
        let home = TempDir::new("merge");
        let file = home.0.join(".glitter/mcp.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"mcpServers":{"mine":{"transport":"stdio","command":"my-server"}},"other":true}"#).unwrap();
        let result = install(&home.0, None, "time").unwrap();
        assert_eq!(result.installed_servers, vec!["time"]);
        let config = read_json(&file);
        assert_eq!(config["other"], true);
        assert_eq!(config["mcpServers"]["mine"]["command"], "my-server");
        assert_eq!(config["mcpServers"]["time"]["command"], "uvx");
    }

    #[test]
    fn python_reference_servers_run_through_uvx() {
        // Fetch and Time are published to PyPI, not npm; `npx` cannot start them.
        for (id, package) in [("fetch", "mcp-server-fetch"), ("time", "mcp-server-time")] {
            let server = SERVERS.iter().find(|server| server.id == id).unwrap();
            assert_eq!((server.command, server.args), ("uvx", &[package][..]), "{id}");
        }
        let home = TempDir::new("uvx");
        install(&home.0, None, "fetch").unwrap();
        let config = read_json(&home.0.join(".glitter/mcp.json"));
        assert_eq!(config["mcpServers"]["fetch"], json!({"transport": "stdio", "command": "uvx", "args": ["mcp-server-fetch"]}));
    }

    #[test]
    fn a_legacy_server_map_is_wrapped_not_left_beside() {
        let home = TempDir::new("legacy");
        let file = home.0.join(".glitter/mcp.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"mine":{"transport":"stdio","command":"my-server"}}"#).unwrap();
        install(&home.0, None, "time").unwrap();
        let config = read_json(&file);
        assert_eq!(config["mcpServers"]["mine"]["command"], "my-server");
        assert!(config.get("mine").is_none());
        let listed = list(&home.0, None);
        assert!(listed.entries.iter().find(|entry| entry.id == "time").unwrap().installed);
    }

    #[test]
    fn server_install_refuses_a_different_definition() {
        let home = TempDir::new("conflict");
        let file = home.0.join(".glitter/mcp.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, r#"{"mcpServers":{"time":{"transport":"stdio","command":"something-else"}}}"#).unwrap();
        let result = install(&home.0, None, "time").unwrap();
        assert!(result.installed_servers.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(read_json(&file)["mcpServers"]["time"]["command"], "something-else");
    }

    #[test]
    fn workspace_server_uses_the_grant_and_needs_one() {
        let home = TempDir::new("workspace-home");
        let workspace = TempDir::new("workspace-root");
        assert!(install(&home.0, None, "filesystem").is_err());
        let result = install(&home.0, Some(&workspace.0), "filesystem").unwrap();
        assert_eq!(result.installed_servers, vec!["filesystem"]);
        let config = read_json(&workspace.0.join(".glitter/mcp.json"));
        assert_eq!(config["mcpServers"]["filesystem"]["args"][2], workspace.0.to_string_lossy().as_ref());
        assert!(!home.0.join(".glitter/mcp.json").exists());
    }

    #[test]
    fn home_placeholders_are_substituted() {
        let home = TempDir::new("home-env");
        install(&home.0, None, "memory").unwrap();
        let config = read_json(&home.0.join(".glitter/mcp.json"));
        let path = config["mcpServers"]["memory"]["env"]["MEMORY_FILE_PATH"].as_str().unwrap();
        assert_eq!(path, format!("{}/.glitter/mcp-memory.json", home.0.to_string_lossy()));
    }

    #[test]
    fn http_server_writes_a_url() {
        let home = TempDir::new("http");
        install(&home.0, None, "deepwiki").unwrap();
        let config = read_json(&home.0.join(".glitter/mcp.json"));
        assert_eq!(config["mcpServers"]["deepwiki"]["transport"], "http");
        assert_eq!(config["mcpServers"]["deepwiki"]["url"], "https://mcp.deepwiki.com/mcp");
    }

    #[test]
    fn remove_only_touches_store_owned_parts() {
        let home = TempDir::new("remove");
        install(&home.0, None, "code-review").unwrap();
        let result = remove(&home.0, None, "code-review").unwrap();
        assert_eq!(result.removed, vec!["code-review"]);
        assert!(!home.0.join(".agents/skills/code-review").exists());

        let foreign = home.0.join(".agents/skills/debug");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("SKILL.md"), "mine").unwrap();
        let result = remove(&home.0, None, "debug").unwrap();
        assert!(result.removed.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert!(foreign.join("SKILL.md").is_file());
    }

    #[test]
    fn remove_a_server_only_when_it_matches_the_catalog() {
        let home = TempDir::new("remove-server");
        install(&home.0, None, "time").unwrap();
        assert_eq!(remove(&home.0, None, "time").unwrap().removed, vec!["time"]);
        assert!(!read_json(&home.0.join(".glitter/mcp.json"))["mcpServers"].as_object().unwrap().contains_key("time"));

        let file = home.0.join(".glitter/mcp.json");
        let mut config = read_json(&file);
        config["mcpServers"]["time"] = json!({ "transport": "stdio", "command": "custom" });
        fs::write(&file, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
        let result = remove(&home.0, None, "time").unwrap();
        assert!(result.removed.is_empty());
        assert_eq!(result.errors.len(), 1);
        assert_eq!(read_json(&file)["mcpServers"]["time"]["command"], "custom");
    }

    #[test]
    fn list_reports_a_broken_config_without_failing() {
        let home = TempDir::new("broken");
        let file = home.0.join(".glitter/mcp.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "{not json").unwrap();
        let listed = list(&home.0, None);
        assert!(listed.error.is_some());
        assert!(!listed.entries.is_empty());
    }

    #[test]
    fn unknown_entries_are_rejected() {
        let home = TempDir::new("unknown");
        assert!(install(&home.0, None, "../../etc").is_err());
        assert!(remove(&home.0, None, "not-a-real-entry").is_err());
    }
}
