//! Typed per-method DTOs for the `bridge_request` trust boundary (SEC-01).
//!
//! Every renderer-supplied param object is deserialized into its method's
//! struct (deny-unknown-fields), length/enum checked, and re-serialized
//! canonically with absent optionals omitted. Native-only fields (`grantId`,
//! `decideApproval.sessionId`) survive validation for the grant/binding checks
//! in `lib.rs` and are stripped by [`strip_native_fields`] before forwarding.
//!
//! The renderer never sends `workspaceRoot`: it is denied on every method and
//! injected natively from the resolved grant instead.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// Renderer-chosen request id: long enough for UUIDs, too short to bloat logs.
pub const REQUEST_ID_LIMIT: usize = 128;
/// Opaque host/bridge ids (session, approval, choice, turn, question).
const ID_LIMIT: usize = 512;
/// `sendTurn` prompt text; images carry their own budget.
const TEXT_LIMIT: usize = 1_000_000;
/// Short free text (clarify answers).
const SHORT_TEXT_LIMIT: usize = 100_000;
/// One-line control reasons (`subagent/interrupt|stop|close`).
const REASON_LIMIT: usize = 1_000;
/// Session display name (mirrors the host's `session/rename` limit).
const NAME_LIMIT: usize = 120;
/// Opaque pagination cursors.
const CURSOR_LIMIT: usize = 4_096;
/// Explicit binary paths (still allowlisted by `allowed_muse_bin`).
const BIN_LIMIT: usize = 4_096;
/// Renderer-sent API keys are overwritten from the keyring; capped only.
const KEY_LIMIT: usize = 4_096;
const MODEL_LIMIT: usize = 256;
const PROVIDER_LIMIT: usize = 256;
/// `setSessionOption` option names (`effort`, `mode`, agent-specific).
const OPTION_LIMIT: usize = 64;
const OPTION_VALUE_LIMIT: usize = 4_096;
/// Attached images per turn.
const IMAGE_LIMIT: usize = 20;
/// Base64 bytes per image (10 MB raw + encoding overhead, rounded up).
const IMAGE_BYTES_LIMIT: usize = 16_000_000;
/// Combined base64 payload; leaves room for JSON and prompt in the frame budget.
const TOTAL_IMAGE_BYTES_LIMIT: usize = 32 * 1024 * 1024;
/// Question answers per response (opaque SDK-owned shapes, bounded only).
const ANSWERS_LIMIT: usize = 32;
const ANSWERS_BYTES_LIMIT: usize = 65_536;
/// `session/list` page size (mirrors the host clamp, schema max 200).
const LIST_LIMIT_MAX: u32 = 200;
/// Grant ids are validated for authority by `grant_root`; the DTO caps the string.
const GRANT_ID_LIMIT: usize = 64;
/// Suggestion briefs are names and titles only. Large enough for the file list,
/// far below a normal turn, and inside the bridge's own operation budget.
const SUGGEST_PROMPT_LIMIT: usize = 64_000;
/// Whole suggestion budget (host start plus one turn). Stays under the 120s
/// bridge deadline so the sidecar can abort before the native side gives up.
const SUGGEST_TIMEOUT_LIMIT: u64 = 90_000;
/// `item/readOutput` page bytes (mirrors the host page, schema max 6 MiB).
const OUTPUT_PAGE_LIMIT: u64 = 6 * 1024 * 1024;
/// MCP server definitions mirror the bridge's config parser bounds.
const MCP_NAME_LIMIT: usize = 64;
const MCP_TEXT_LIMIT: usize = 4_096;
const MCP_ARGS_MAX: usize = 64;
const MCP_MAP_MAX: usize = 64;
const MCP_KEY_LIMIT: usize = 128;
const MCP_VALUE_LIMIT: usize = 4_096;
const MCP_TIMEOUT_MS_MIN: u64 = 1_000;
const MCP_TIMEOUT_MS_MAX: u64 = 600_000;
const BROWSER_URL_LIMIT: usize = 4_096;
const BROWSER_SELECTOR_LIMIT: usize = 4_096;
const BROWSER_KEY_LIMIT: usize = 64;

/// Image types the native drop inspector can produce — the only image source.
const IMAGE_MEDIA_TYPES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/x-icon", "image/svg+xml", "image/tiff", "image/heic", "image/heif"];

/// Agents the bridge can route to (`agents.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AgentId {
    Muse,
    Opencode,
    Grok,
    Gemini,
    Qwen,
    Goose,
    Cline,
    /// The app's own agent (`packages/glitter-bridge/src/harness`).
    Harness,
}

/// Session permission tiers (`protocol.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ApprovalMode {
    AllowAll,
    PromptUnmatched,
    OnRequest,
    DenyUnmatched,
    /// The harness's Autonomous mode; no other agent accepts it.
    Guarded,
}

/// Reasoning tiers (`protocol.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    Ultra,
}

/// Which credential Muse bills (`detect.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AuthMode {
    Auto,
    Subscription,
    ApiKey,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyParams {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DetectParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_auth_mode: Option<AuthMode>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StatusParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_auth_mode: Option<AuthMode>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SuggestParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
    prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_auth_mode: Option<AuthMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contributor_mode: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartHostParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_bin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_auth_mode: Option<AuthMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    trust_workspace: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    no_session_log: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    disable_write: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    disable_shell: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sandbox_network: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    contributor_mode: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StopHostParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListSessionsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_after: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListModelsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<bool>,
    /// A model chosen before any session exists; the agent reports its
    /// effort levels so a new thread can show them before the first send.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    approval_mode: Option<ApprovalMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<ReasoningEffort>,
    /// An ACP agent's mode (OpenCode's build or plan) chosen in the draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    /// Built-in agent only: the role models and goal this thread routes with.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orchestrator: Option<StartSessionOrchestrator>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_request_id: Option<String>,
}

/// One role's model, as Settings stores it. Provider-prefixed model ids keep
/// the bridge's `provider/model` invariant true before it parses them.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSessionOrchestratorModel {
    model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSessionOrchestratorModels {
    lead: StartSessionOrchestratorModel,
    builder: StartSessionOrchestratorModel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    small: Option<StartSessionOrchestratorModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    router: Option<StartSessionOrchestratorModel>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartSessionOrchestrator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    goal: Option<String>,
    models: StartSessionOrchestratorModels,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResumeSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_request_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ForkSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_request_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompactSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CloseSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exclude_items: Option<bool>,
}

/// A delegated child's transcript, read through the parent session's binding.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadChildSessionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    child_session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    exclude_items: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListSkillsParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
}

/// The harness's own MCP servers, read from `.glitter/mcp.json`; `refresh`
/// reconnects even when the files have not changed.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessMcpParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<bool>,
}

/// Which `.glitter/mcp.json` an added or removed server belongs to.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum McpScope {
    Workspace,
    Home,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum McpTransport {
    Stdio,
    Http,
}

/// A server the app is allowed to write. Values in `env` and `headers` are
/// write-only: the bridge never reads them back to the renderer.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessMcpServerDefinition {
    name: String,
    transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    timeout_ms: Option<u64>,
}

/// Settings → Models' Test: one Harness model, no session.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TestModelParams {
    agent_id: AgentId,
    model_id: String,
}

/// Settings → Orchestrator's role check: one probe against one Harness model.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrchestratorProbeParams {
    agent_id: AgentId,
    role: String,
    provider_id: String,
    model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessMcpConfigParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessMcpAddServerParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    scope: McpScope,
    server: HarnessMcpServerDefinition,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessMcpRemoveServerParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    scope: McpScope,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageHistoryParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadOutputParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    item_id: String,
    output_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    offset_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length_bytes: Option<u64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetReasoningEffortParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    reasoning_effort: ReasoningEffort,
}

/// Child lifecycle verbs (`subagent/*`, SS3.16).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum SubagentAction {
    SendMessage,
    FollowupTask,
    Interrupt,
    Stop,
    Resume,
    Reopen,
    Close,
    ReadResult,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubagentControlParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    subagent_id: String,
    action: SubagentAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// Foreground/background tool-task verbs (`task/*`, SS3.13–SS3.15).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum TaskAction {
    Background,
    Stop,
    StopAll,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskControlParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    action: TaskAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
}

/// Workflow-run verbs (`workflow/*`, SS3.19–SS3.20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum WorkflowAction {
    Cancel,
    Skip,
    Retry,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkflowControlParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    workflow_run_id: String,
    action: WorkflowAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    child_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
}

/// Session-goal verbs (`goal/*`, SS3.18).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum GoalAction {
    Set,
    Edit,
    Clear,
    Pause,
    Resume,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GoalControlParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    action: GoalAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    objective: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImageAttachment {
    media_type: String,
    base64_data: String,
}

/// Busy-turn disposition (`turn/start.ifBusy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BusyDisposition {
    Queue,
    Steer,
    Replace,
}

/// The shape one message asks for. Every routing floor still applies to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RouteShape {
    DirectSmall,
    DirectBuilder,
    LeadGuided,
    LeadOnly,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendTurnParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default)]
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    images: Option<Vec<ImageAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    if_busy: Option<BusyDisposition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skill: Option<SkillInvocation>,
    /// Built-in agent only: this message's override from the goal popover.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    forced_shape: Option<RouteShape>,
}

/// A structured skill invocation: the host resolves the selector.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillInvocation {
    selector: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    arguments: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SteerTurnParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default)]
    text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    images: Option<Vec<ImageAttachment>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnqueueTurnParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    turn_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelTurnParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    turn_id: Option<String>,
}

/// Question answers (`protocol.ts`): the discriminator is typed, the `answer`
/// payloads are opaque SDK-owned shapes bounded by count and serialized size.
#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
enum UserInputResponse {
    Answer {
        answers: Vec<Value>,
    },
    Cancel,
    Clarify {
        text: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RespondUserInputParams {
    session_id: String,
    user_input_id: String,
    response: UserInputResponse,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DecideApprovalParams {
    approval_id: String,
    choice_id: String,
    /// Native ownership check only; the bridge routes by approval id alone.
    session_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetApprovalModeParams {
    /// The renderer names the agent; the bridge still routes by the session's owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    mode: ApprovalMode,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetModelParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    model_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider_id: Option<String>,
}

/// Switch one live built-in session between manual models and Orchestrator.
/// A null or absent block returns the session to manual models.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetOrchestratorParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    orchestrator: Option<StartSessionOrchestrator>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetSessionOptionParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
    session_id: String,
    option: String,
    value: String,
}

/// Verbs that only name the Muse binary: login, CLI update check, CLI update.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MuseBinParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    muse_bin: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameSessionParams {
    session_id: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserShellParams {
    session_id: String,
    command_text: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum BrowserAction {
    Open,
    Navigate,
    State,
    Snapshot,
    Screenshot,
    Click,
    Type,
    Key,
    Scroll,
    Back,
    Forward,
    Reload,
    Wait,
    Console,
    Resize,
    SetStreaming,
    Close,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserOpenParams {
    grant_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserControlParams {
    grant_id: String,
    action: BrowserAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    y: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delta_x: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    delta_y: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    width: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    height: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserCloseParams {
    grant_id: String,
}

fn capped(method: &str, field: &str, value: &str, limit: usize) -> Result<(), String> {
    if value.len() > limit {
        return Err(format!("Invalid {method} parameters: {field} is longer than {limit} bytes."));
    }
    Ok(())
}

fn required(method: &str, field: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("Invalid {method} parameters: {field} is required."));
    }
    Ok(())
}

fn check_id(method: &str, field: &str, value: &str) -> Result<(), String> {
    required(method, field, value)?;
    capped(method, field, value, ID_LIMIT)
}

fn check_maybe_id(method: &str, field: &str, value: Option<&str>) -> Result<(), String> {
    if let Some(value) = value {
        capped(method, field, value, ID_LIMIT)?;
    }
    Ok(())
}

fn check_browser_number(method: &str, field: &str, value: Option<i64>, min: i64, max: i64) -> Result<(), String> {
    if value.is_some_and(|number| number < min || number > max) {
        return Err(format!("Invalid {method} parameters: {field} must be between {min} and {max}."));
    }
    Ok(())
}

fn check_browser_url(method: &str, url: &str) -> Result<(), String> {
    required(method, "url", url.trim())?;
    capped(method, "url", url, BROWSER_URL_LIMIT)?;
    let lower = url.trim().to_ascii_lowercase();
    let authority = lower.strip_prefix("http://").or_else(|| lower.strip_prefix("https://")).ok_or_else(|| format!("Invalid {method} parameters: url must use http or https."))?;
    if authority.split('/').next().is_some_and(|part| part.contains('@')) || url.chars().any(|ch| ch.is_control()) {
        return Err(format!("Invalid {method} parameters: url cannot contain credentials or control characters."));
    }
    Ok(())
}

fn check_browser_control(method: &str, parsed: &BrowserControlParams) -> Result<(), String> {
    capped(method, "grantId", &parsed.grant_id, GRANT_ID_LIMIT)?;
    if let Some(url) = parsed.url.as_deref() {
        check_browser_url(method, url)?;
    }
    if let Some(selector) = parsed.selector.as_deref() {
        capped(method, "selector", selector, BROWSER_SELECTOR_LIMIT)?;
    }
    if let Some(reference) = parsed.r#ref.as_deref() {
        capped(method, "ref", reference, BROWSER_KEY_LIMIT)?;
        if reference.is_empty() || !reference.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err(format!("Invalid {method} parameters: ref is not an accessibility reference."));
        }
    }
    if let Some(text) = parsed.text.as_deref() {
        capped(method, "text", text, SHORT_TEXT_LIMIT)?;
    }
    if let Some(key) = parsed.key.as_deref() {
        required(method, "key", key.trim())?;
        capped(method, "key", key, BROWSER_KEY_LIMIT)?;
    }
    for (field, value, min, max) in [
        ("x", parsed.x, 0, 4_096),
        ("y", parsed.y, 0, 4_096),
        ("deltaX", parsed.delta_x, -20_000, 20_000),
        ("deltaY", parsed.delta_y, -20_000, 20_000),
        ("ms", parsed.ms, 1, 10_000),
        ("width", parsed.width, 320, 2_560),
        ("height", parsed.height, 240, 1_600),
    ] {
        check_browser_number(method, field, value, min, max)?;
    }
    if parsed.x.is_some() != parsed.y.is_some() {
        return Err(format!("Invalid {method} parameters: x and y must be supplied together."));
    }
    match parsed.action {
        BrowserAction::Navigate if parsed.url.as_deref().is_none_or(|url| url.trim().is_empty()) => return Err(format!("Invalid {method} parameters: navigate requires url.")),
        BrowserAction::Click if parsed.r#ref.is_none() && parsed.selector.is_none() && (parsed.x.is_none() || parsed.y.is_none()) => return Err(format!("Invalid {method} parameters: click requires ref, selector, or coordinates.")),
        BrowserAction::Type if parsed.text.is_none() => return Err(format!("Invalid {method} parameters: type requires text.")),
        BrowserAction::Key if parsed.key.is_none() => return Err(format!("Invalid {method} parameters: key is required.")),
        BrowserAction::Resize if parsed.width.is_none() || parsed.height.is_none() => return Err(format!("Invalid {method} parameters: resize requires width and height.")),
        BrowserAction::SetStreaming if parsed.stream.is_none() => return Err(format!("Invalid {method} parameters: setStreaming requires stream.")),
        _ => {}
    }
    Ok(())
}

fn check_mcp_map(method: &str, field: &str, map: Option<&BTreeMap<String, String>>) -> Result<(), String> {
    let Some(map) = map else { return Ok(()) };
    if map.len() > MCP_MAP_MAX {
        return Err(format!("Invalid {method} parameters: {field} has more than {MCP_MAP_MAX} entries."));
    }
    for (key, value) in map {
        if key.is_empty() {
            return Err(format!("Invalid {method} parameters: {field} has an empty key."));
        }
        capped(method, field, key, MCP_KEY_LIMIT)?;
        capped(method, field, value, MCP_VALUE_LIMIT)?;
        if value.contains(['\r', '\n']) {
            return Err(format!("Invalid {method} parameters: {field} values must be one line."));
        }
    }
    Ok(())
}

fn check_mcp_server(method: &str, server: &HarnessMcpServerDefinition) -> Result<(), String> {
    required(method, "server.name", &server.name)?;
    capped(method, "server.name", &server.name, MCP_NAME_LIMIT)?;
    if let Some(command) = server.command.as_deref() {
        capped(method, "server.command", command, MCP_TEXT_LIMIT)?;
    }
    if let Some(url) = server.url.as_deref() {
        capped(method, "server.url", url, MCP_TEXT_LIMIT)?;
    }
    if let Some(args) = &server.args {
        if args.len() > MCP_ARGS_MAX {
            return Err(format!("Invalid {method} parameters: server.args has more than {MCP_ARGS_MAX} entries."));
        }
        for arg in args {
            capped(method, "server.args", arg, MCP_TEXT_LIMIT)?;
        }
    }
    check_mcp_map(method, "server.env", server.env.as_ref())?;
    check_mcp_map(method, "server.headers", server.headers.as_ref())?;
    if let Some(timeout) = server.timeout_ms {
        if !(MCP_TIMEOUT_MS_MIN..=MCP_TIMEOUT_MS_MAX).contains(&timeout) {
            return Err(format!("Invalid {method} parameters: server.timeoutMs must be between {MCP_TIMEOUT_MS_MIN} and {MCP_TIMEOUT_MS_MAX}."));
        }
    }
    Ok(())
}

fn check_orchestrator_model(method: &str, role: &str, model: &StartSessionOrchestratorModel) -> Result<(), String> {
    let field = format!("orchestrator.models.{role}.modelId");
    required(method, &field, &model.model_id)?;
    capped(method, &field, &model.model_id, MODEL_LIMIT)?;
    let Some((prefix, rest)) = model.model_id.split_once('/') else {
        return Err(format!("Invalid {method} parameters: {field} must be a provider/model id."));
    };
    if prefix.is_empty() || rest.is_empty() || prefix.len() > PROVIDER_LIMIT {
        return Err(format!("Invalid {method} parameters: {field} must be a provider/model id."));
    }
    if let Some(provider) = model.provider_id.as_deref() {
        let field = format!("orchestrator.models.{role}.providerId");
        required(method, &field, provider)?;
        capped(method, &field, provider, PROVIDER_LIMIT)?;
        if provider != prefix {
            return Err(format!("Invalid {method} parameters: {field} does not match the model id."));
        }
    }
    Ok(())
}

/// Orchestrator is Harness-only. Lead and Builder are mandatory; the bridge
/// resolves Small-task and Router fallbacks from them.
fn check_start_orchestrator(method: &str, orchestrator: &StartSessionOrchestrator) -> Result<(), String> {
    if let Some(goal) = orchestrator.goal.as_deref() {
        if !["cost", "balanced", "output"].contains(&goal) {
            return Err(format!("Invalid {method} parameters: orchestrator.goal must be cost, balanced or output."));
        }
    }
    check_orchestrator_model(method, "lead", &orchestrator.models.lead)?;
    check_orchestrator_model(method, "builder", &orchestrator.models.builder)?;
    if let Some(small) = &orchestrator.models.small {
        check_orchestrator_model(method, "small", small)?;
    }
    if let Some(router) = &orchestrator.models.router {
        check_orchestrator_model(method, "router", router)?;
    }
    Ok(())
}

fn check_images(method: &str, images: Option<&[ImageAttachment]>) -> Result<(), String> {
    if let Some(images) = images {
        if images.len() > IMAGE_LIMIT {
            return Err(format!("Invalid {method} parameters: at most {IMAGE_LIMIT} images per turn."));
        }
        let mut total = 0usize;
        for image in images {
            if !IMAGE_MEDIA_TYPES.contains(&image.media_type.as_str()) {
                return Err(format!("Invalid {method} parameters: unsupported image type."));
            }
            capped(method, "base64Data", &image.base64_data, IMAGE_BYTES_LIMIT)?;
            total += image.base64_data.len();
            if total > TOTAL_IMAGE_BYTES_LIMIT {
                return Err(format!("Invalid {method} parameters: combined images exceed 32 MiB encoded."));
            }
        }
    }
    Ok(())
}

fn parse<T: for<'de> Deserialize<'de>>(method: &str, params: &Value) -> Result<T, String> {
    serde_json::from_value(params.clone()).map_err(|err| {
        let detail: String = err.to_string().chars().take(240).collect();
        format!("Invalid {method} parameters: {detail}")
    })
}

fn emit<T: Serialize>(method: &str, value: &T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|err| format!("Invalid {method} parameters: {err}"))
}

/// Renderer-chosen request ids must stay short enough for logs and maps.
pub fn validate_request_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > REQUEST_ID_LIMIT {
        return Err(format!("Request id must be 1-{REQUEST_ID_LIMIT} characters."));
    }
    Ok(())
}

/// Validate one method's params and return the canonical object to forward.
/// A JSON null body counts as `{}` so empty-param verbs stay callable.
pub fn validate_params(method: &str, params: &Value) -> Result<Value, String> {
    let empty = Value::Object(Default::default());
    let body = if params.is_null() {
        &empty
    } else {
        params
    };
    match method {
        "ping" | "usage" | "cancelLogin" => {
            let parsed: EmptyParams = parse(method, body)?;
            emit(method, &parsed)
        }
        "detect" => {
            let parsed: DetectParams = parse(method, body)?;
            if let Some(bin) = parsed.muse_bin.as_deref() {
                capped(method, "museBin", bin, BIN_LIMIT)?;
            }
            if let Some(key) = parsed.muse_api_key.as_deref() {
                capped(method, "museApiKey", key, KEY_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "status" => {
            let parsed: StatusParams = parse(method, body)?;
            if let Some(bin) = parsed.muse_bin.as_deref() {
                capped(method, "museBin", bin, BIN_LIMIT)?;
            }
            if let Some(key) = parsed.muse_api_key.as_deref() {
                capped(method, "museApiKey", key, KEY_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "startHost" => {
            let parsed: StartHostParams = parse(method, body)?;
            if let Some(bin) = parsed.muse_bin.as_deref() {
                capped(method, "museBin", bin, BIN_LIMIT)?;
            }
            if let Some(key) = parsed.muse_api_key.as_deref() {
                capped(method, "museApiKey", key, KEY_LIMIT)?;
            }
            if let Some(mode) = parsed.sandbox_network.as_deref() {
                if !["proxy-only", "restricted", "enabled"].contains(&mode) {
                    return Err(format!("Invalid {method} parameters: sandboxNetwork must be proxy-only, restricted, or enabled."));
                }
            }
            if let Some(mode) = parsed.contributor_mode.as_deref() {
                if !["on", "off"].contains(&mode) {
                    return Err(format!("Invalid {method} parameters: contributorMode must be on or off."));
                }
            }
            emit(method, &parsed)
        }
        "suggest" => {
            let parsed: SuggestParams = parse(method, body)?;
            if let Some(grant) = parsed.grant_id.as_deref() {
                capped(method, "grantId", grant, GRANT_ID_LIMIT)?;
            }
            required(method, "prompt", &parsed.prompt)?;
            capped(method, "prompt", &parsed.prompt, SUGGEST_PROMPT_LIMIT)?;
            if let Some(model) = parsed.model_id.as_deref() {
                required(method, "modelId", model)?;
                capped(method, "modelId", model, MODEL_LIMIT)?;
            }
            if let Some(provider) = parsed.provider_id.as_deref() {
                required(method, "providerId", provider)?;
                capped(method, "providerId", provider, PROVIDER_LIMIT)?;
            }
            if let Some(timeout) = parsed.timeout_ms {
                if timeout == 0 || timeout > SUGGEST_TIMEOUT_LIMIT {
                    return Err(format!("Invalid {method} parameters: timeoutMs must be 1-{SUGGEST_TIMEOUT_LIMIT}."));
                }
            }
            if let Some(bin) = parsed.muse_bin.as_deref() {
                capped(method, "museBin", bin, BIN_LIMIT)?;
            }
            if let Some(key) = parsed.muse_api_key.as_deref() {
                capped(method, "museApiKey", key, KEY_LIMIT)?;
            }
            if let Some(mode) = parsed.contributor_mode.as_deref() {
                if !["on", "off"].contains(&mode) {
                    return Err(format!("Invalid {method} parameters: contributorMode must be on or off."));
                }
            }
            emit(method, &parsed)
        }
        "stopHost" => {
            let parsed: StopHostParams = parse(method, body)?;
            emit(method, &parsed)
        }
        "listSessions" => {
            let mut parsed: ListSessionsParams = parse(method, body)?;
            if let Some(grant) = parsed.grant_id.as_deref() {
                capped(method, "grantId", grant, GRANT_ID_LIMIT)?;
            }
            if let Some(cursor) = parsed.cursor.as_deref() {
                capped(method, "cursor", cursor, CURSOR_LIMIT)?;
            }
            // RFC 3339 timestamp; the host validates the value, the DTO caps it.
            if let Some(since) = parsed.updated_after.as_deref() {
                capped(method, "updatedAfter", since, CURSOR_LIMIT)?;
            }
            parsed.limit = parsed.limit.map(|limit| limit.clamp(1, LIST_LIMIT_MAX));
            emit(method, &parsed)
        }
        "listModels" => {
            let parsed: ListModelsParams = parse(method, body)?;
            check_maybe_id(method, "sessionId", parsed.session_id.as_deref())?;
            if let Some(model) = parsed.model_id.as_deref() {
                required(method, "modelId", model)?;
                capped(method, "modelId", model, MODEL_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "startSession" => {
            let parsed: StartSessionParams = parse(method, body)?;
            if let Some(grant) = parsed.grant_id.as_deref() {
                capped(method, "grantId", grant, GRANT_ID_LIMIT)?;
            }
            if let Some(orchestrator) = &parsed.orchestrator {
                if parsed.agent_id != Some(AgentId::Harness) {
                    return Err(format!("Invalid {method} parameters: Orchestrator applies only to the built-in agent."));
                }
                if parsed.model_id.is_some() || parsed.provider_id.is_some() || parsed.reasoning_effort.is_some() {
                    return Err(format!("Invalid {method} parameters: an Orchestrator session chooses its models from the role settings."));
                }
                check_start_orchestrator(method, orchestrator)?;
            }
            if let Some(model) = parsed.model_id.as_deref() {
                required(method, "modelId", model)?;
                capped(method, "modelId", model, MODEL_LIMIT)?;
            }
            if let Some(provider) = parsed.provider_id.as_deref() {
                required(method, "providerId", provider)?;
                capped(method, "providerId", provider, PROVIDER_LIMIT)?;
            }
            if let Some(mode) = parsed.mode.as_deref() {
                required(method, "mode", mode)?;
                capped(method, "mode", mode, OPTION_VALUE_LIMIT)?;
            }
            if let Some(id) = parsed.client_request_id.as_deref() {
                capped(method, "clientRequestId", id, ID_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "resumeSession" => {
            let parsed: ResumeSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            if let Some(cursor) = parsed.cursor.as_deref() {
                capped(method, "cursor", cursor, CURSOR_LIMIT)?;
            }
            if let Some(id) = parsed.client_request_id.as_deref() {
                capped(method, "clientRequestId", id, ID_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "forkSession" => {
            let parsed: ForkSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            if let Some(cut) = parsed.last_turn_id.as_deref() {
                check_id(method, "lastTurnId", cut)?;
            }
            if let Some(id) = parsed.client_request_id.as_deref() {
                capped(method, "clientRequestId", id, ID_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "compactSession" => {
            let parsed: CompactSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "closeSession" => {
            let parsed: CloseSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "readSession" => {
            let parsed: ReadSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "readChildSession" => {
            let parsed: ReadChildSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "childSessionId", &parsed.child_session_id)?;
            emit(method, &parsed)
        }
        "listSkills" => {
            let parsed: ListSkillsParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "harnessMcp" => {
            let parsed: HarnessMcpParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "harnessMcpConfig" => {
            let parsed: HarnessMcpConfigParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "harnessMcpAddServer" => {
            let parsed: HarnessMcpAddServerParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_mcp_server(method, &parsed.server)?;
            emit(method, &parsed)
        }
        "harnessMcpRemoveServer" => {
            let parsed: HarnessMcpRemoveServerParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            required(method, "name", &parsed.name)?;
            capped(method, "name", &parsed.name, MCP_NAME_LIMIT)?;
            emit(method, &parsed)
        }
        "mcpServers" => {
            let parsed: EmptyParams = parse(method, body)?;
            emit(method, &parsed)
        }
        "testModel" => {
            let parsed: TestModelParams = parse(method, body)?;
            // Only the built-in agent calls a provider directly; a CLI agent would need a session.
            if parsed.agent_id != AgentId::Harness {
                return Err(format!("Invalid {method} parameters: only Harness models can be tested."));
            }
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
            emit(method, &parsed)
        }
        "orchestratorProbe" => {
            let parsed: OrchestratorProbeParams = parse(method, body)?;
            if parsed.agent_id != AgentId::Harness {
                return Err(format!("Invalid {method} parameters: only Harness models can be probed."));
            }
            if !matches!(parsed.role.as_str(), "router" | "lead" | "builder" | "small") {
                return Err(format!("Invalid {method} parameters: role must be router, lead, builder or small."));
            }
            required(method, "providerId", &parsed.provider_id)?;
            capped(method, "providerId", &parsed.provider_id, PROVIDER_LIMIT)?;
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
            emit(method, &parsed)
        }
        "pageHistory" => {
            let parsed: PageHistoryParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            if let Some(cursor) = parsed.cursor.as_deref() {
                required(method, "cursor", cursor)?;
                capped(method, "cursor", cursor, CURSOR_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "browserOpen" => {
            let parsed: BrowserOpenParams = parse(method, body)?;
            capped(method, "grantId", &parsed.grant_id, GRANT_ID_LIMIT)?;
            if let Some(url) = parsed.url.as_deref() {
                check_browser_url(method, url)?;
            }
            check_browser_number(method, "width", parsed.width, 320, 2_560)?;
            check_browser_number(method, "height", parsed.height, 240, 1_600)?;
            emit(method, &parsed)
        }
        "browserControl" => {
            let parsed: BrowserControlParams = parse(method, body)?;
            check_browser_control(method, &parsed)?;
            emit(method, &parsed)
        }
        "browserClose" => {
            let parsed: BrowserCloseParams = parse(method, body)?;
            capped(method, "grantId", &parsed.grant_id, GRANT_ID_LIMIT)?;
            emit(method, &parsed)
        }
        "readOutput" => {
            let mut parsed: ReadOutputParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "itemId", &parsed.item_id)?;
            check_id(method, "outputRef", &parsed.output_ref)?;
            if parsed.length_bytes == Some(0) {
                return Err(format!("Invalid {method} parameters: lengthBytes must be at least one byte."));
            }
            parsed.length_bytes = parsed.length_bytes.map(|limit| limit.min(OUTPUT_PAGE_LIMIT));
            emit(method, &parsed)
        }
        "setReasoningEffort" => {
            let parsed: SetReasoningEffortParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "subagentControl" => {
            let parsed: SubagentControlParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "subagentId", &parsed.subagent_id)?;
            if let Some(body) = parsed.body.as_deref() {
                required(method, "body", body.trim())?;
                capped(method, "body", body, SHORT_TEXT_LIMIT)?;
            }
            if let Some(reason) = parsed.reason.as_deref() {
                capped(method, "reason", reason, REASON_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "taskControl" => {
            let parsed: TaskControlParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            match parsed.action {
                TaskAction::StopAll => {
                    if parsed.task_id.is_some() {
                        return Err(format!("Invalid {method} parameters: stopAll takes no taskId."));
                    }
                }
                _ => check_id(method, "taskId", parsed.task_id.as_deref().unwrap_or(""))?,
            }
            emit(method, &parsed)
        }
        "workflowControl" => {
            let parsed: WorkflowControlParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "workflowRunId", &parsed.workflow_run_id)?;
            match parsed.action {
                WorkflowAction::Cancel => {
                    if parsed.child_id.is_some() || parsed.attempt.is_some() {
                        return Err(format!("Invalid {method} parameters: cancel takes no child key."));
                    }
                }
                _ => {
                    check_id(method, "childId", parsed.child_id.as_deref().unwrap_or(""))?;
                    if parsed.attempt.unwrap_or(0) < 1 {
                        return Err(format!("Invalid {method} parameters: attempt must be 1 or more."));
                    }
                }
            }
            emit(method, &parsed)
        }
        "goalControl" => {
            let parsed: GoalControlParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            match parsed.action {
                GoalAction::Set | GoalAction::Edit => {
                    let objective = parsed.objective.as_deref().unwrap_or("");
                    required(method, "objective", objective.trim())?;
                    capped(method, "objective", objective, SHORT_TEXT_LIMIT)?;
                }
                _ => {
                    if parsed.objective.is_some() {
                        return Err(format!("Invalid {method} parameters: this goal action takes no objective."));
                    }
                }
            }
            emit(method, &parsed)
        }
        "sendTurn" => {
            let parsed: SendTurnParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            capped(method, "text", &parsed.text, TEXT_LIMIT)?;
            check_maybe_id(method, "clientTurnId", parsed.client_turn_id.as_deref())?;
            check_images(method, parsed.images.as_deref())?;
            if parsed.forced_shape.is_some() {
                if let Some(agent) = parsed.agent_id {
                    if agent != AgentId::Harness {
                        return Err(format!("Invalid {method} parameters: a forced shape applies only to the built-in agent."));
                    }
                }
            }
            if let Some(skill) = parsed.skill.as_ref() {
                required(method, "skill.selector", skill.selector.trim())?;
                capped(method, "skill.selector", &skill.selector, ID_LIMIT)?;
                if let Some(args) = skill.arguments.as_deref() {
                    capped(method, "skill.arguments", args, SHORT_TEXT_LIMIT)?;
                }
            }
            emit(method, &parsed)
        }
        "steerTurn" => {
            let parsed: SteerTurnParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            capped(method, "text", &parsed.text, TEXT_LIMIT)?;
            check_images(method, parsed.images.as_deref())?;
            emit(method, &parsed)
        }
        "unqueueTurn" => {
            let parsed: UnqueueTurnParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "turnId", &parsed.turn_id)?;
            emit(method, &parsed)
        }
        "cancelTurn" => {
            let parsed: CancelTurnParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_maybe_id(method, "turnId", parsed.turn_id.as_deref())?;
            emit(method, &parsed)
        }
        "respondUserInput" => {
            // Serde does not enforce deny-unknown-fields on internally-tagged
            // enums, so the discriminator level is closed by hand; `answers`
            // items stay opaque (SDK-owned) and are bounded below instead.
            if let Some(reply) = body.get("response").and_then(Value::as_object) {
                let allowed: &[&str] = match reply.get("action").and_then(Value::as_str) {
                    Some("answer") => &["action", "answers"],
                    Some("cancel") => &["action"],
                    Some("clarify") => &["action", "text"],
                    _ => &["action"],
                };
                for key in reply.keys() {
                    if !allowed.contains(&key.as_str()) {
                        return Err(format!("Invalid {method} parameters: unknown field `{key}`."));
                    }
                }
            }
            let parsed: RespondUserInputParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            check_id(method, "userInputId", &parsed.user_input_id)?;
            match &parsed.response {
                UserInputResponse::Answer {
                    answers,
                } => {
                    if answers.len() > ANSWERS_LIMIT {
                        return Err(format!("Invalid {method} parameters: at most {ANSWERS_LIMIT} answers."));
                    }
                    let bytes = serde_json::to_string(answers).map(|raw| raw.len()).unwrap_or(usize::MAX);
                    if bytes > ANSWERS_BYTES_LIMIT {
                        return Err(format!("Invalid {method} parameters: answers are longer than {ANSWERS_BYTES_LIMIT} bytes."));
                    }
                }
                UserInputResponse::Clarify {
                    text,
                } => {
                    required(method, "text", text)?;
                    capped(method, "text", text, SHORT_TEXT_LIMIT)?;
                }
                UserInputResponse::Cancel => {}
            }
            emit(method, &parsed)
        }
        "decideApproval" => {
            let parsed: DecideApprovalParams = parse(method, body)?;
            check_id(method, "approvalId", &parsed.approval_id)?;
            check_id(method, "choiceId", &parsed.choice_id)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "setApprovalMode" => {
            let parsed: SetApprovalModeParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            emit(method, &parsed)
        }
        "setModel" => {
            let parsed: SetModelParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
            if let Some(provider) = parsed.provider_id.as_deref() {
                required(method, "providerId", provider)?;
                capped(method, "providerId", provider, PROVIDER_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "setOrchestrator" => {
            let parsed: SetOrchestratorParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            if parsed.agent_id.is_some_and(|agent| agent != AgentId::Harness) {
                return Err(format!("Invalid {method} parameters: Orchestrator applies only to the built-in agent."));
            }
            if let Some(orchestrator) = &parsed.orchestrator {
                check_start_orchestrator(method, orchestrator)?;
            }
            emit(method, &parsed)
        }
        "setSessionOption" => {
            let parsed: SetSessionOptionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            required(method, "option", &parsed.option)?;
            capped(method, "option", &parsed.option, OPTION_LIMIT)?;
            required(method, "value", &parsed.value)?;
            capped(method, "value", &parsed.value, OPTION_VALUE_LIMIT)?;
            emit(method, &parsed)
        }
        "startLogin" | "checkCliUpdate" | "updateCli" => {
            let parsed: MuseBinParams = parse(method, body)?;
            if let Some(bin) = parsed.muse_bin.as_deref() {
                capped(method, "museBin", bin, BIN_LIMIT)?;
            }
            emit(method, &parsed)
        }
        "renameSession" => {
            let parsed: RenameSessionParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            // Cap the raw value: the check below runs on the whitespace-collapsed
            // name, so without this a payload padded with spaces would pass a
            // one-character check and forward megabytes to the host.
            capped(method, "name", &parsed.name, NAME_LIMIT)?;
            let trimmed = parsed.name.replace(|ch: char| ch.is_whitespace(), " ");
            let trimmed = trimmed.trim();
            if trimmed.is_empty() || trimmed.len() > NAME_LIMIT {
                return Err(format!("Invalid {method} parameters: name must be 1-{NAME_LIMIT} characters."));
            }
            emit(method, &parsed)
        }
        "userShell" => {
            let parsed: UserShellParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            required(method, "commandText", &parsed.command_text)?;
            capped(method, "commandText", &parsed.command_text, SHORT_TEXT_LIMIT)?;
            emit(method, &parsed)
        }
        _ => Err(format!("Unsupported bridge method: {method}")),
    }
}

/// Drop native-only fields after the grant/binding checks, before forwarding.
/// `grantId` resolves to an injected `workspaceRoot` on every method that takes
/// it; `decideApproval.sessionId` proves ownership to the native side while the
/// bridge routes by approval id alone.
pub fn strip_native_fields(method: &str, params: &mut Value) {
    let Some(object) = params.as_object_mut() else {
        return;
    };
    object.remove("grantId");
    if method == "decideApproval" {
        object.remove("sessionId");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Every allowlisted verb accepts the shape its real callers send.
    #[test]
    fn every_method_accepts_its_documented_shape() {
        let cases: &[(&str, Value)] = &[
            ("ping", json!({})),
            ("usage", json!({})),
            ("cancelLogin", json!({})),
            ("detect", json!({ "museBin": "/usr/local/bin/muse", "museApiKey": "k", "museAuthMode": "auto" })),
            ("status", json!({ "museApiKey": "k", "museAuthMode": "apiKey" })),
            ("status", json!({ "museBin": "/usr/local/bin/muse" })),
            ("startHost", json!({ "museBin": "/usr/local/bin/muse", "museAuthMode": "auto" })),
            ("startHost", json!({ "agentId": "opencode" })),
            ("startHost", json!({ "trustWorkspace": true, "noSessionLog": true, "disableWrite": true, "disableShell": false, "sandboxNetwork": "restricted" })),
            ("startHost", json!({ "trustWorkspace": true })),
            ("startHost", json!({ "contributorMode": "on" })),
            ("startHost", json!({ "contributorMode": "off" })),
            ("stopHost", json!({})),
            ("stopHost", json!({ "agentId": "grok" })),
            ("listSessions", json!({ "agentId": "muse", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cursor": "c", "limit": 5 })),
            ("listSessions", json!({ "agentId": "muse", "limit": 200, "updatedAfter": "2026-09-01T00:00:00Z" })),
            ("listModels", json!({})),
            ("listModels", json!({ "agentId": "gemini", "sessionId": "s-1" })),
            ("listModels", json!({ "agentId": "grok", "refresh": true })),
            ("listModels", json!({ "agentId": "opencode", "modelId": "anthropic/claude-sonnet-4" })),
            ("startSession", json!({ "agentId": "opencode", "mode": "plan" })),
            ("suggest", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "prompt": "Project: repo", "modelId": "m", "providerId": "p", "timeoutMs": 75000, "museAuthMode": "auto", "contributorMode": "off" })),
            ("suggest", json!({ "agentId": "opencode", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "prompt": "names only", "modelId": "zen/a" })),
            ("startSession", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approvalMode": "promptUnmatched", "modelId": "m", "providerId": "p" })),
            ("startSession", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approvalMode": "guarded" })),
            ("startSession", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "orchestrator": { "goal": "balanced", "models": { "lead": { "modelId": "anthropic/claude-sonnet-5", "providerId": "anthropic" }, "builder": { "modelId": "deepseek/deepseek-chat" }, "small": { "modelId": "deepseek/deepseek-chat" }, "router": { "modelId": "deepseek/deepseek-chat" } } } })),
            ("startSession", json!({ "agentId": "qwen", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reasoningEffort": "high" })),
            ("startSession", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "clientRequestId": "create-1" })),
            ("resumeSession", json!({ "sessionId": "s-1" })),
            ("resumeSession", json!({ "sessionId": "s-1", "clientRequestId": "resume-1" })),
            ("resumeSession", json!({ "agentId": "goose", "sessionId": "s-1", "cursor": null })),
            ("forkSession", json!({ "sessionId": "s-1" })),
            ("forkSession", json!({ "sessionId": "s-1", "lastTurnId": "t-3" })),
            ("compactSession", json!({ "sessionId": "s-1" })),
            ("closeSession", json!({ "sessionId": "s-1" })),
            ("readSession", json!({ "sessionId": "s-1" })),
            ("readSession", json!({ "sessionId": "s-1", "excludeItems": false })),
            ("readChildSession", json!({ "sessionId": "h-1", "childSessionId": "h-2" })),
            ("readChildSession", json!({ "agentId": "harness", "sessionId": "h-1", "childSessionId": "h-2", "excludeItems": false })),
            ("pageHistory", json!({ "sessionId": "s-1", "cursor": "c-old" })),
            ("pageHistory", json!({ "sessionId": "s-1" })),
            ("readOutput", json!({ "sessionId": "s-1", "itemId": "i-1", "outputRef": "r-1" })),
            ("readOutput", json!({ "sessionId": "s-1", "itemId": "i-1", "outputRef": "r-1", "offsetBytes": 8, "lengthBytes": 4096 })),
            ("browserOpen", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "url": "http://localhost:3000", "width": 1100, "height": 760 })),
            ("browserControl", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "action": "click", "ref": "e2" })),
            ("browserControl", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "action": "setStreaming", "stream": true })),
            ("browserClose", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
            ("setReasoningEffort", json!({ "sessionId": "s-1", "reasoningEffort": "low" })),
            ("subagentControl", json!({ "sessionId": "s-1", "subagentId": "k-1", "action": "sendMessage", "body": "use the cache" })),
            ("subagentControl", json!({ "sessionId": "s-1", "subagentId": "k-1", "action": "stop", "reason": "stale" })),
            ("subagentControl", json!({ "sessionId": "s-1", "subagentId": "k-1", "action": "readResult" })),
            ("taskControl", json!({ "sessionId": "s-1", "action": "background", "taskId": "t-1" })),
            ("taskControl", json!({ "sessionId": "s-1", "action": "stopAll" })),
            ("workflowControl", json!({ "sessionId": "s-1", "workflowRunId": "r-1", "action": "cancel" })),
            ("workflowControl", json!({ "sessionId": "s-1", "workflowRunId": "r-1", "action": "retry", "childId": "c-2", "attempt": 2 })),
            ("goalControl", json!({ "sessionId": "s-1", "action": "set", "objective": "Ship it" })),
            ("goalControl", json!({ "sessionId": "s-1", "action": "pause" })),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "hi", "reasoningEffort": "none", "images": [{ "mediaType": "image/png", "base64Data": "aGk=" }], "clientTurnId": "t-1" })),
            ("sendTurn", json!({ "agentId": "opencode", "sessionId": "s-1", "text": "", "images": [] })),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "later", "ifBusy": "queue" })),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "", "skill": { "selector": "fix-bug", "arguments": "auth.ts" } })),
            ("sendTurn", json!({ "agentId": "harness", "sessionId": "h-1", "text": "hi", "forcedShape": "direct-small" })),
            ("setOrchestrator", json!({ "agentId": "harness", "sessionId": "h-1" })),
            ("setOrchestrator", json!({ "agentId": "harness", "sessionId": "h-1", "orchestrator": { "goal": "output", "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" } } } })),
            ("listSkills", json!({ "sessionId": "s-1" })),
            ("harnessMcp", json!({ "agentId": "harness", "sessionId": "h-1" })),
            ("harnessMcp", json!({ "sessionId": "h-1", "refresh": true })),
            ("harnessMcpConfig", json!({ "agentId": "harness", "sessionId": "h-1" })),
            ("testModel", json!({ "agentId": "harness", "modelId": "anthropic/claude-sonnet-5" })),
            ("orchestratorProbe", json!({ "agentId": "harness", "role": "builder", "providerId": "anthropic", "modelId": "anthropic/claude-sonnet-5" })),
            ("harnessMcpAddServer", json!({ "sessionId": "h-1", "scope": "workspace", "server": { "name": "docs", "transport": "stdio", "command": "npx", "args": ["-y", "server-filesystem", "."], "env": { "LOG_LEVEL": "warn" } } })),
            ("harnessMcpAddServer", json!({ "sessionId": "h-1", "scope": "home", "server": { "name": "docs", "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer token" }, "timeoutMs": 30000 } })),
            ("harnessMcpRemoveServer", json!({ "sessionId": "h-1", "scope": "workspace", "name": "docs" })),
            ("mcpServers", json!({})),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "instead", "ifBusy": "replace" })),
            ("steerTurn", json!({ "sessionId": "s-1", "text": "more tests" })),
            ("steerTurn", json!({ "sessionId": "s-1", "text": "", "images": [{ "mediaType": "image/png", "base64Data": "eA==" }], "reasoningEffort": "high" })),
            ("unqueueTurn", json!({ "sessionId": "s-1", "turnId": "t-1" })),
            ("cancelTurn", json!({ "sessionId": "s-1" })),
            ("cancelTurn", json!({ "agentId": "muse", "sessionId": "s-1", "turnId": "t-1" })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "answer", "answers": [{ "questionId": "q1", "selected": ["a"] }] } })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "cancel" } })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "clarify", "text": "which file?" } })),
            ("decideApproval", json!({ "approvalId": "a-1", "choiceId": "c", "sessionId": "s-1" })),
            ("setApprovalMode", json!({ "sessionId": "s-1", "mode": "denyUnmatched" })),
            ("setApprovalMode", json!({ "sessionId": "s-1", "mode": "guarded" })),
            ("setApprovalMode", json!({ "agentId": "harness", "sessionId": "h-1", "mode": "allowAll" })),
            ("setApprovalMode", json!({ "agentId": "grok", "sessionId": "g-1", "mode": "denyUnmatched" })),
            ("setModel", json!({ "sessionId": "s-1", "modelId": "m", "providerId": "p" })),
            ("setModel", json!({ "agentId": "grok", "sessionId": "s-1", "modelId": "grok-4.6" })),
            ("setSessionOption", json!({ "agentId": "opencode", "sessionId": "s-1", "option": "effort", "value": "high" })),
            ("startLogin", json!({})),
            ("startLogin", json!({ "museBin": "/usr/local/bin/muse" })),
            ("checkCliUpdate", json!({})),
            ("checkCliUpdate", json!({ "museBin": "/usr/local/bin/muse" })),
            ("updateCli", json!({})),
            ("updateCli", json!({ "museBin": "/usr/local/bin/muse" })),
            ("renameSession", json!({ "sessionId": "s-1", "name": "Fix auth retry" })),
            ("userShell", json!({ "sessionId": "s-1", "commandText": "git status --short" })),
        ];
        for (method, params) in cases {
            assert!(validate_params(method, params).is_ok(), "{method} rejects its documented shape: {params}");
        }
    }

    #[test]
    fn unknown_fields_and_renderer_roots_are_rejected() {
        assert!(validate_params("startHost", &json!({ "sandboxNetwork": "wide-open" })).is_err());
        assert!(validate_params("startHost", &json!({ "contributorMode": "auto" })).is_err());
        // Nominated roots never reach the bridge: the native side injects them.
        assert!(validate_params("startSession", &json!({ "grantId": "g", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("resumeSession", &json!({ "sessionId": "s", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("listSessions", &json!({ "grantId": "g", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "names", "workspaceRoot": "/etc" })).is_err());
        for (method, mut params) in [
            ("startSession", json!({ "agentId": "harness", "grantId": "g" })),
            ("resumeSession", json!({ "sessionId": "h-1" })),
            ("sendTurn", json!({ "sessionId": "h-1", "text": "hi" })),
            ("harnessMcp", json!({ "sessionId": "h-1" })),
            ("harnessMcpConfig", json!({ "sessionId": "h-1" })),
        ] {
            params.as_object_mut().unwrap().insert("harnessMcpTrust".into(), json!({ "workspaceTrusted": true }));
            assert!(validate_params(method, &params).is_err(), "{method} accepted renderer-supplied MCP consent");
        }
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "" })).is_err());
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "names", "timeoutMs": 0 })).is_err());
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "names", "contributorMode": "auto" })).is_err());
        // Stray keys fail closed on every verb family.
        assert!(validate_params("ping", &json!({ "sessionId": "s" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "mode": "allowAll" })).is_err());
        assert!(validate_params("decideApproval", &json!({ "approvalId": "a", "choiceId": "c", "sessionId": "s", "grantId": "g" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": [{ "mediaType": "image/png", "base64Data": "eA==", "path": "/etc/passwd" }] })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "cancel", "sessionId": "s-other" } })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "answer", "answers": [], "text": "x" } })).is_err());
        // Oversight actions carry exactly their verb's key set.
        assert!(validate_params("taskControl", &json!({ "sessionId": "s", "action": "stopAll", "taskId": "t" })).is_err());
        assert!(validate_params("taskControl", &json!({ "sessionId": "s", "action": "stop" })).is_err());
        assert!(validate_params("workflowControl", &json!({ "sessionId": "s", "workflowRunId": "r", "action": "cancel", "childId": "c" })).is_err());
        assert!(validate_params("workflowControl", &json!({ "sessionId": "s", "workflowRunId": "r", "action": "retry", "childId": "c", "attempt": 0 })).is_err());
        assert!(validate_params("goalControl", &json!({ "sessionId": "s", "action": "set" })).is_err());
        assert!(validate_params("goalControl", &json!({ "sessionId": "s", "action": "pause", "objective": "x" })).is_err());
        assert!(validate_params("subagentControl", &json!({ "sessionId": "s", "subagentId": "k", "action": "explode" })).is_err());
    }

    #[test]
    fn wrong_types_and_shapes_are_rejected() {
        assert!(validate_params("sendTurn", &json!({ "sessionId": 42, "text": "t" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": ["t"] })).is_err());
        assert!(validate_params("listSessions", &json!({ "limit": "many" })).is_err());
        assert!(validate_params("listModels", &json!({ "refresh": "true" })).is_err());
        assert!(validate_params("listSessions", &json!({ "limit": 1.5 })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": "nope" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": "cancel" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "answer" } })).is_err());
        assert!(validate_params("setApprovalMode", &json!({ "sessionId": "s" })).is_err());
        assert!(validate_params("sendTurn", &json!(["s", "t"])).is_err());
        // MCP writes are bounded and closed: no stray server fields, no bad scope.
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace" })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "system", "server": { "name": "x", "transport": "stdio", "command": "x" } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "", "transport": "stdio", "command": "x" } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "x", "transport": "sse", "url": "https://example.com" } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "x", "transport": "stdio", "command": "x", "cwd": "/" } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "x", "transport": "stdio", "command": "x", "env": { "TOKEN": "two\nlines" } } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "x", "transport": "stdio", "command": "x", "timeoutMs": 100 } })).is_err());
        assert!(validate_params("harnessMcpAddServer", &json!({ "sessionId": "s", "scope": "workspace", "server": { "name": "x".repeat(65), "transport": "stdio", "command": "x" } })).is_err());
        assert!(validate_params("testModel", &json!({ "agentId": "muse", "modelId": "m" })).is_err());
        assert!(validate_params("testModel", &json!({ "agentId": "harness", "modelId": "" })).is_err());
        assert!(validate_params("testModel", &json!({ "modelId": "anthropic/m" })).is_err());
        assert!(validate_params("testModel", &json!({ "agentId": "harness", "modelId": "a/m", "providerKeys": {} })).is_err());
        assert!(validate_params("orchestratorProbe", &json!({ "agentId": "muse", "role": "builder", "providerId": "anthropic", "modelId": "anthropic/m" })).is_err());
        assert!(validate_params("orchestratorProbe", &json!({ "agentId": "harness", "role": "judge", "providerId": "anthropic", "modelId": "anthropic/m" })).is_err());
        assert!(validate_params("orchestratorProbe", &json!({ "agentId": "harness", "role": "builder", "providerId": "", "modelId": "anthropic/m" })).is_err());
        assert!(validate_params("orchestratorProbe", &json!({ "agentId": "harness", "role": "builder", "providerId": "anthropic", "modelId": "" })).is_err());
        assert!(validate_params("orchestratorProbe", &json!({ "agentId": "harness", "role": "builder", "providerId": "anthropic", "modelId": "m", "refresh": "yes" })).is_err());
        // Orchestrator is built-in only, carries its own role models, and stays closed.
        let orchestrator = json!({ "goal": "balanced", "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" } } });
        assert!(validate_params("startSession", &json!({ "agentId": "muse", "orchestrator": orchestrator.clone() })).is_err());
        assert!(validate_params("startSession", &json!({ "orchestrator": orchestrator.clone() })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "modelId": "anthropic/m", "orchestrator": orchestrator.clone() })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "reasoningEffort": "high", "orchestrator": orchestrator.clone() })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "goal": "fast", "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" } } } })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "models": { "lead": { "modelId": "anthropic/lead" } } } })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "models": { "lead": { "modelId": "unslashed" }, "builder": { "modelId": "deepseek/build" } } } })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "models": { "lead": { "modelId": "anthropic/lead", "providerId": "openai" }, "builder": { "modelId": "deepseek/build" } } } })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" } }, "shape": "lead-only" } })).is_err());
        assert!(validate_params("startSession", &json!({ "agentId": "harness", "orchestrator": { "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" }, "judge": { "modelId": "deepseek/build" } } } })).is_err());
        // A live switch carries the same role block; absent means off, and it stays built-in only.
        let live = validate_params("setOrchestrator", &json!({ "agentId": "harness", "sessionId": "h-1", "orchestrator": orchestrator.clone() })).expect("switch on");
        assert_eq!(live["orchestrator"]["goal"], json!("balanced"));
        let off = validate_params("setOrchestrator", &json!({ "agentId": "harness", "sessionId": "h-1" })).expect("switch off");
        assert!(off.get("orchestrator").is_none());
        assert!(validate_params("setOrchestrator", &json!({ "agentId": "muse", "sessionId": "s-1", "orchestrator": orchestrator.clone() })).is_err());
        assert!(validate_params("setOrchestrator", &json!({ "agentId": "harness", "sessionId": "h-1", "orchestrator": { "goal": "fast", "models": { "lead": { "modelId": "anthropic/lead" }, "builder": { "modelId": "deepseek/build" } } } })).is_err());
        assert!(validate_params("setOrchestrator", &json!({ "agentId": "harness", "sessionId": "h-1", "orchestrator": { "models": { "lead": { "modelId": "anthropic/lead" } } } })).is_err());
        assert!(validate_params("harnessMcpRemoveServer", &json!({ "sessionId": "s", "scope": "workspace" })).is_err());
        assert!(validate_params("harnessMcpRemoveServer", &json!({ "sessionId": "s", "scope": "workspace", "name": "" })).is_err());
        assert!(validate_params("bogus", &json!({})).is_err());
    }

    #[test]
    fn enum_variants_are_closed() {
        assert!(validate_params("startSession", &json!({ "approvalMode": "allowEverything" })).is_err());
        assert!(validate_params("setApprovalMode", &json!({ "sessionId": "s", "mode": "allowEverything" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "reasoningEffort": "turbo" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "ifBusy": "wait" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "forcedShape": "router" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "agentId": "muse", "sessionId": "s", "text": "t", "forcedShape": "direct-small" })).is_err());
        assert!(validate_params("steerTurn", &json!({ "sessionId": "s", "text": "t", "ifBusy": "queue" })).is_err());
        assert!(validate_params("unqueueTurn", &json!({ "sessionId": "s" })).is_err());
        assert!(validate_params("forkSession", &json!({ "sessionId": "s", "lastTurnId": "" })).is_err());
        assert!(validate_params("forkSession", &json!({ "sessionId": "s", "cutPoint": { "lastTurnId": "t" } })).is_err());
        assert!(validate_params("compactSession", &json!({ "sessionId": "s", "turnId": "t" })).is_err());
        assert!(validate_params("closeSession", &json!({ "sessionId": "s", "turnId": "t" })).is_err());
        assert!(validate_params("readSession", &json!({ "sessionId": "s", "excludeItems": "no" })).is_err());
        assert!(validate_params("readChildSession", &json!({ "sessionId": "h-1" })).is_err());
        assert!(validate_params("readChildSession", &json!({ "sessionId": "h-1", "childSessionId": "h-2", "excludeItems": "no" })).is_err());
        assert!(validate_params("detect", &json!({ "museAuthMode": "oauth" })).is_err());
        assert!(validate_params("status", &json!({ "museAuthMode": "oauth" })).is_err());
        assert!(validate_params("startHost", &json!({ "agentId": "chatgpt" })).is_err());
        assert!(validate_params("setModel", &json!({ "agentId": "muse2", "sessionId": "s", "modelId": "m" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "maybe" } })).is_err());
        // Wrong case is not normalized into a valid variant.
        assert!(validate_params("setApprovalMode", &json!({ "sessionId": "s", "mode": "AllowAll" })).is_err());
    }

    #[test]
    fn aggregate_image_budget_is_enforced() {
        let mut images: Vec<ImageAttachment> = (0..3)
            .map(|_| ImageAttachment {
                media_type: "image/png".into(),
                base64_data: "x".repeat(11 * 1024 * 1024),
            })
            .collect();
        assert!(check_images("sendTurn", Some(&images)).is_err());
        images.pop();
        assert!(check_images("sendTurn", Some(&images)).is_ok());
    }

    #[test]
    fn a_padded_rename_is_capped_before_the_whitespace_check() {
        // The name check runs on the whitespace-collapsed value; without a cap on
        // the raw one, a payload padded with spaces passes a one-character check.
        let padded = format!("{}{}", "x", " ".repeat(NAME_LIMIT * 4));
        let out = validate_params("renameSession", &serde_json::json!({ "sessionId": "s-1", "name": padded }));
        assert!(out.is_err(), "a padded name must be refused by the raw cap");
        let short = validate_params("renameSession", &serde_json::json!({ "sessionId": "s-1", "name": "  Real   name  " }));
        assert!(short.is_ok(), "ordinary names still pass");
    }

    #[test]
    fn size_limits_fail_closed() {
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id(&"i".repeat(129)).is_err());
        assert!(validate_request_id("0192c9d4-7b1a-4e0e-9f2a-9c1d3e5f7a9b").is_ok());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "x".repeat(1_000_001) })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "", "text": "t" })).is_err());
        assert!(validate_params("renameSession", &json!({ "sessionId": "s", "name": "   " })).is_err());
        assert!(validate_params("renameSession", &json!({ "sessionId": "s", "name": "x".repeat(121) })).is_err());
        assert!(validate_params("listSessions", &json!({ "cursor": "x".repeat(4_097) })).is_err());
        assert!(validate_params("detect", &json!({ "museBin": "x".repeat(4_097) })).is_err());
        assert!(validate_params("setModel", &json!({ "sessionId": "s", "modelId": "" })).is_err());
        assert!(validate_params("setSessionOption", &json!({ "sessionId": "s", "option": "effort", "value": "" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "clarify", "text": "" } })).is_err());
        let big_image = json!({ "mediaType": "image/png", "base64Data": "x".repeat(16_000_001) });
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": [big_image] })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": [{ "mediaType": "application/pdf", "base64Data": "eA==" }] })).is_err());
        let many: Vec<Value> = (0..21).map(|_| json!({ "mediaType": "image/png", "base64Data": "eA==" })).collect();
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": many })).is_err());
        let answers: Vec<Value> = (0..33).map(|n| json!({ "n": n })).collect();
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "answer", "answers": answers } })).is_err());
        let fat = vec![json!({ "blob": "x".repeat(65_537) })];
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "answer", "answers": fat } })).is_err());
        // Error detail truncates instead of echoing a hostile payload back.
        let err = validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "veryLongFieldName": "x".repeat(2000) })).unwrap_err();
        assert!(err.len() < 400, "error echoes input: {err}");
    }

    #[test]
    fn canonical_forward_omits_nulls_clamps_and_strips_native_fields() {
        // Absent optionals serialize to nothing — never explicit nulls the SDK
        // could read as a set value (e.g. `approvalMode: null`).
        let out = validate_params("startSession", &json!({ "grantId": "g" })).expect("startSession");
        assert_eq!(out, json!({ "grantId": "g" }));
        // Explicit nulls deserialize to absent and stay absent.
        let out = validate_params("resumeSession", &json!({ "sessionId": "s", "cursor": null })).expect("resume");
        assert_eq!(out, json!({ "sessionId": "s" }));
        // Null params count as `{}` for empty verbs, and fail where required.
        let out = validate_params("ping", &Value::Null).expect("ping null");
        assert_eq!(out, json!({}));
        assert!(validate_params("sendTurn", &Value::Null).is_err());
        // Page size clamps to the host's 1..=200 range instead of failing.
        let out = validate_params("listSessions", &json!({ "limit": 999_999 })).expect("clamp");
        assert_eq!(out.get("limit"), Some(&json!(200)));
        let out = validate_params("listSessions", &json!({ "limit": 0 })).expect("clamp");
        assert_eq!(out.get("limit"), Some(&json!(1)));
        // Native-only fields survive validation for the binding checks, then go.
        let mut out = validate_params("listSessions", &json!({ "grantId": "g", "limit": 5 })).expect("grant");
        assert_eq!(out.get("grantId"), Some(&json!("g")));
        strip_native_fields("listSessions", &mut out);
        assert!(out.get("grantId").is_none());
        let mut out = validate_params("decideApproval", &json!({ "approvalId": "a", "choiceId": "c", "sessionId": "s" })).expect("decide");
        strip_native_fields("decideApproval", &mut out);
        assert_eq!(out, json!({ "approvalId": "a", "choiceId": "c" }));
        // Other verbs keep their session id for bridge routing.
        let mut out = validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t" })).expect("turn");
        strip_native_fields("sendTurn", &mut out);
        assert_eq!(out.get("sessionId"), Some(&json!("s")));
        // The per-message shape survives validation for the bridge and harness.
        let out = validate_params("sendTurn", &json!({ "agentId": "harness", "sessionId": "h-1", "text": "t", "forcedShape": "direct-builder" })).expect("forced shape");
        assert_eq!(out["forcedShape"], json!("direct-builder"));
    }
}
