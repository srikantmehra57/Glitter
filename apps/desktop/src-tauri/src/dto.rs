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
/// Opaque pagination cursors.
const CURSOR_LIMIT: usize = 4_096;
const MODEL_LIMIT: usize = 256;
const PROVIDER_LIMIT: usize = 256;
/// A library entry's display name; the model id itself is the identity.
const MODEL_NAME_LIMIT: usize = 120;
/// Effort levels per library entry (the app's tier vocabulary has seven).
const MODEL_EFFORTS_LIMIT: usize = 8;
/// A library entry's context window, in tokens (100M is far past any model).
const MODEL_WINDOW_MAX: i64 = 100_000_000;
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

/// The one agent the app runs (`packages/glitter-harness/src/harness`). The
/// renderer may still name it; any other id is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum AgentId {
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
    /// Auto: classify each call and ask only for risky ones.
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmptyParams {}

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
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartHostParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    agent_id: Option<AgentId>,
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
    /// The Harness mode (build or plan) chosen in the draft.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    /// The role models and goal this thread routes with.
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

/// One model library entry as the add/edit dialog submits it. A field the
/// renderer leaves out is one the user left open; the harness keeps whatever
/// the live catalog and family tables say about it.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelLibraryEntry {
    provider_id: String,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context_window: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    efforts: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    default_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    images: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    documents: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    video: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cost: Option<ModelEntryCost>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    effort_source: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelEntryCost {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    currency: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelLibraryListParams {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelLibraryPutParams {
    entry: ModelLibraryEntry,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelLibraryRemoveParams {
    model_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListProviderModelsParams {
    provider_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    refresh: Option<bool>,
}

/// Settings → Permissions' rules for the built-in agent. The bridge parses the
/// pattern; here only the effect is closed and the list and each rule bounded.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HarnessRulesParams {
    agent_id: AgentId,
    rules: Vec<PermissionRuleParam>,
    /// Settings → Permissions' protected paths. Absent keeps the bridge's
    /// current set (the defaults). Each one is a workspace-relative glob.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    protected_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum RuleEffect {
    Allow,
    Deny,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PermissionRuleParam {
    effect: RuleEffect,
    rule: String,
}

const RULES_LIMIT: usize = 200;
const RULE_LIMIT: usize = 300;
/// Mirrors `PROTECTED_PATH_LIMIT` and `PROTECTED_PATH_LENGTH` in the harness.
const PROTECTED_PATHS_LIMIT: usize = 100;
const PROTECTED_PATH_LIMIT: usize = 200;

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
    /// This message's override from the goal popover.
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
/// The model library entry's shape and bounds; which provider ids exist and
/// whether an effort level is real are the harness's call, not the DTO's.
fn validate_model_entry(method: &str, entry: &ModelLibraryEntry) -> Result<(), String> {
    required(method, "providerId", &entry.provider_id)?;
    capped(method, "providerId", &entry.provider_id, PROVIDER_LIMIT)?;
    required(method, "model", &entry.model)?;
    capped(method, "model", &entry.model, MODEL_LIMIT)?;
    if entry.model.chars().any(|c| c.is_whitespace()) {
        return Err(format!("Invalid {method} parameters: model must not contain whitespace."));
    }
    if let Some(name) = entry.display_name.as_deref() {
        capped(method, "displayName", name, MODEL_NAME_LIMIT)?;
    }
    if let Some(window) = entry.context_window {
        if window <= 0 || window > MODEL_WINDOW_MAX {
            return Err(format!("Invalid {method} parameters: contextWindow must be 1-{MODEL_WINDOW_MAX}."));
        }
    }
    if let Some(efforts) = &entry.efforts {
        if efforts.len() > MODEL_EFFORTS_LIMIT {
            return Err(format!("Invalid {method} parameters: at most {MODEL_EFFORTS_LIMIT} effort levels."));
        }
        for effort in efforts {
            required(method, "efforts", effort)?;
            capped(method, "efforts", effort, OPTION_LIMIT)?;
        }
    }
    if let Some(default) = entry.default_effort.as_deref() {
        required(method, "defaultEffort", default)?;
        capped(method, "defaultEffort", default, OPTION_LIMIT)?;
        let listed = entry.efforts.as_ref().is_some_and(|efforts| efforts.iter().any(|effort| effort == default));
        if !listed {
            return Err(format!("Invalid {method} parameters: defaultEffort must be one of efforts."));
        }
    }
    if let Some(source) = entry.effort_source.as_deref() {
        if source != "fetched" && source != "user" {
            return Err(format!("Invalid {method} parameters: effortSource must be fetched or user."));
        }
    }
    if let Some(cost) = &entry.cost {
        for (field, value) in [("input", cost.input.as_deref()), ("output", cost.output.as_deref())] {
            if let Some(value) = value {
                capped(method, field, value, 40)?;
            }
        }
        if let Some(currency) = cost.currency.as_deref() {
            capped(method, "currency", currency, 8)?;
        }
    }
    Ok(())
}

pub fn validate_params(method: &str, params: &Value) -> Result<Value, String> {
    let empty = Value::Object(Default::default());
    let body = if params.is_null() {
        &empty
    } else {
        params
    };
    match method {
        "ping" | "detect" => {
            let parsed: EmptyParams = parse(method, body)?;
            emit(method, &parsed)
        }
        "startHost" => {
            let parsed: StartHostParams = parse(method, body)?;
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
        "modelLibraryList" => {
            let parsed: ModelLibraryListParams = parse(method, body)?;
            emit(method, &parsed)
        }
        "modelLibraryPut" => {
            let parsed: ModelLibraryPutParams = parse(method, body)?;
            validate_model_entry(method, &parsed.entry)?;
            emit(method, &parsed)
        }
        "modelLibraryRemove" => {
            let parsed: ModelLibraryRemoveParams = parse(method, body)?;
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
            emit(method, &parsed)
        }
        "listProviderModels" => {
            let parsed: ListProviderModelsParams = parse(method, body)?;
            required(method, "providerId", &parsed.provider_id)?;
            capped(method, "providerId", &parsed.provider_id, PROVIDER_LIMIT)?;
            emit(method, &parsed)
        }
        "startSession" => {
            let parsed: StartSessionParams = parse(method, body)?;
            if let Some(grant) = parsed.grant_id.as_deref() {
                capped(method, "grantId", grant, GRANT_ID_LIMIT)?;
            }
            if let Some(orchestrator) = &parsed.orchestrator {
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
        "harnessRules" => {
            let parsed: HarnessRulesParams = parse(method, body)?;
            if parsed.rules.len() > RULES_LIMIT {
                return Err(format!("Invalid {method} parameters: at most {RULES_LIMIT} rules."));
            }
            for rule in &parsed.rules {
                required(method, "rule", &rule.rule)?;
                capped(method, "rule", &rule.rule, RULE_LIMIT)?;
                if rule.rule.chars().any(char::is_control) {
                    return Err(format!("Invalid {method} parameters: a rule cannot contain control characters."));
                }
            }
            let paths = parsed.protected_paths.as_deref().unwrap_or_default();
            if paths.len() > PROTECTED_PATHS_LIMIT {
                return Err(format!("Invalid {method} parameters: at most {PROTECTED_PATHS_LIMIT} protected paths."));
            }
            for path in paths {
                required(method, "protectedPaths", path)?;
                capped(method, "protectedPaths", path, PROTECTED_PATH_LIMIT)?;
                // The bridge builds seatbelt rules from these, so anything that
                // could leave the workspace or break out of a regex is refused.
                if path.chars().any(|ch| ch.is_control() || matches!(ch, '"' | '\\' | '[' | ']' | '{' | '}')) || path.starts_with('/') || path.starts_with('~') || path.split('/').any(|part| part.is_empty() || part == "." || part == "..") {
                    return Err(format!("Invalid {method} parameters: a protected path is a pattern inside the workspace."));
                }
            }
            emit(method, &parsed)
        }
        "testModel" => {
            let parsed: TestModelParams = parse(method, body)?;
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
            emit(method, &parsed)
        }
        "orchestratorProbe" => {
            let parsed: OrchestratorProbeParams = parse(method, body)?;
            if !matches!(parsed.role.as_str(), "router" | "lead" | "builder" | "small") {
                return Err(format!("Invalid {method} parameters: role must be router, lead, builder or small."));
            }
            required(method, "providerId", &parsed.provider_id)?;
            capped(method, "providerId", &parsed.provider_id, PROVIDER_LIMIT)?;
            required(method, "modelId", &parsed.model_id)?;
            capped(method, "modelId", &parsed.model_id, MODEL_LIMIT)?;
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
        "sendTurn" => {
            let parsed: SendTurnParams = parse(method, body)?;
            check_id(method, "sessionId", &parsed.session_id)?;
            capped(method, "text", &parsed.text, TEXT_LIMIT)?;
            check_maybe_id(method, "clientTurnId", parsed.client_turn_id.as_deref())?;
            check_images(method, parsed.images.as_deref())?;
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
            ("detect", json!({})),
            ("startHost", json!({})),
            ("startHost", json!({ "agentId": "harness" })),
            ("stopHost", json!({})),
            ("listSessions", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "cursor": "c", "limit": 5 })),
            ("listSessions", json!({ "agentId": "harness", "limit": 200, "updatedAfter": "2026-09-01T00:00:00Z" })),
            ("listModels", json!({})),
            ("listModels", json!({ "agentId": "harness", "sessionId": "h-1" })),
            ("listModels", json!({ "refresh": true })),
            ("listModels", json!({ "modelId": "anthropic/claude-sonnet-4" })),
            ("modelLibraryList", json!({})),
            ("modelLibraryPut", json!({ "entry": { "providerId": "anthropic", "model": "claude-sonnet-4-5" } })),
            ("modelLibraryPut", json!({ "entry": { "providerId": "custom-1", "model": "glm-5.3", "displayName": "GLM", "contextWindow": 200000, "efforts": ["low", "high"], "defaultEffort": "high", "images": true, "documents": false, "video": null, "cost": { "input": "3", "output": "15", "currency": "USD" }, "effortSource": "user" } })),
            ("modelLibraryRemove", json!({ "modelId": "anthropic/claude-sonnet-4-5" })),
            ("listProviderModels", json!({ "providerId": "openrouter" })),
            ("listProviderModels", json!({ "providerId": "openrouter", "refresh": true })),
            ("startSession", json!({ "agentId": "harness", "mode": "plan" })),
            ("suggest", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "prompt": "Project: repo", "modelId": "m", "providerId": "p", "timeoutMs": 75000 })),
            ("suggest", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "prompt": "names only", "modelId": "zen/a" })),
            ("startSession", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approvalMode": "promptUnmatched", "modelId": "m", "providerId": "p" })),
            ("startSession", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "approvalMode": "guarded" })),
            ("startSession", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "orchestrator": { "goal": "balanced", "models": { "lead": { "modelId": "anthropic/claude-sonnet-5", "providerId": "anthropic" }, "builder": { "modelId": "deepseek/deepseek-chat" }, "small": { "modelId": "deepseek/deepseek-chat" }, "router": { "modelId": "deepseek/deepseek-chat" } } } })),
            ("startSession", json!({ "agentId": "harness", "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "reasoningEffort": "high" })),
            ("startSession", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "clientRequestId": "create-1" })),
            ("resumeSession", json!({ "sessionId": "s-1" })),
            ("resumeSession", json!({ "sessionId": "s-1", "clientRequestId": "resume-1" })),
            ("resumeSession", json!({ "agentId": "harness", "sessionId": "s-1", "cursor": null })),
            ("compactSession", json!({ "sessionId": "s-1" })),
            ("closeSession", json!({ "sessionId": "s-1" })),
            ("readChildSession", json!({ "sessionId": "h-1", "childSessionId": "h-2" })),
            ("readChildSession", json!({ "agentId": "harness", "sessionId": "h-1", "childSessionId": "h-2", "excludeItems": false })),
            ("browserOpen", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "url": "http://localhost:3000", "width": 1100, "height": 760 })),
            ("browserControl", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "action": "click", "ref": "e2" })),
            ("browserControl", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "action": "setStreaming", "stream": true })),
            ("browserClose", json!({ "grantId": "wg-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "hi", "reasoningEffort": "none", "images": [{ "mediaType": "image/png", "base64Data": "aGk=" }], "clientTurnId": "t-1" })),
            ("sendTurn", json!({ "agentId": "harness", "sessionId": "s-1", "text": "", "images": [] })),
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
            ("harnessRules", json!({ "agentId": "harness", "rules": [{ "effect": "allow", "rule": "Bash(npm test)" }, { "effect": "deny", "rule": "Edit(.env)" }] })),
            ("harnessRules", json!({ "agentId": "harness", "rules": [] })),
            ("orchestratorProbe", json!({ "agentId": "harness", "role": "builder", "providerId": "anthropic", "modelId": "anthropic/claude-sonnet-5" })),
            ("harnessMcpAddServer", json!({ "sessionId": "h-1", "scope": "workspace", "server": { "name": "docs", "transport": "stdio", "command": "npx", "args": ["-y", "server-filesystem", "."], "env": { "LOG_LEVEL": "warn" } } })),
            ("harnessMcpAddServer", json!({ "sessionId": "h-1", "scope": "home", "server": { "name": "docs", "transport": "http", "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer token" }, "timeoutMs": 30000 } })),
            ("harnessMcpRemoveServer", json!({ "sessionId": "h-1", "scope": "workspace", "name": "docs" })),
            ("sendTurn", json!({ "sessionId": "s-1", "text": "instead", "ifBusy": "replace" })),
            ("steerTurn", json!({ "sessionId": "s-1", "text": "more tests" })),
            ("steerTurn", json!({ "sessionId": "s-1", "text": "", "images": [{ "mediaType": "image/png", "base64Data": "eA==" }], "reasoningEffort": "high" })),
            ("unqueueTurn", json!({ "sessionId": "s-1", "turnId": "t-1" })),
            ("cancelTurn", json!({ "sessionId": "s-1" })),
            ("cancelTurn", json!({ "agentId": "harness", "sessionId": "s-1", "turnId": "t-1" })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "answer", "answers": [{ "questionId": "q1", "selected": ["a"] }] } })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "cancel" } })),
            ("respondUserInput", json!({ "sessionId": "s-1", "userInputId": "q", "response": { "action": "clarify", "text": "which file?" } })),
            ("decideApproval", json!({ "approvalId": "a-1", "choiceId": "c", "sessionId": "s-1" })),
            ("setApprovalMode", json!({ "sessionId": "s-1", "mode": "denyUnmatched" })),
            ("setApprovalMode", json!({ "sessionId": "s-1", "mode": "guarded" })),
            ("setApprovalMode", json!({ "agentId": "harness", "sessionId": "h-1", "mode": "allowAll" })),
            ("setModel", json!({ "sessionId": "s-1", "modelId": "m", "providerId": "p" })),
            ("setModel", json!({ "agentId": "harness", "sessionId": "h-1", "modelId": "openai/gpt-5" })),
            ("setSessionOption", json!({ "agentId": "harness", "sessionId": "s-1", "option": "effort", "value": "high" })),
        ];
        for (method, params) in cases {
            assert!(validate_params(method, params).is_ok(), "{method} rejects its documented shape: {params}");
        }
    }

    #[test]
    fn unknown_fields_and_renderer_roots_are_rejected() {
        // The Muse CLI's host posture and identity fields are gone.
        assert!(validate_params("startHost", &json!({ "sandboxNetwork": "restricted" })).is_err());
        assert!(validate_params("startHost", &json!({ "museBin": "/usr/local/bin/muse" })).is_err());
        assert!(validate_params("detect", &json!({ "museApiKey": "k" })).is_err());
        for retired in ["status", "usage", "startLogin", "cancelLogin", "checkCliUpdate", "updateCli", "forkSession", "readSession", "pageHistory", "readOutput", "renameSession", "userShell", "mcpServers", "setReasoningEffort", "subagentControl", "taskControl", "workflowControl", "goalControl"] {
            assert!(validate_params(retired, &json!({})).is_err(), "{retired} is no longer a verb");
        }
        // Nominated roots never reach the bridge: the native side injects them.
        assert!(validate_params("startSession", &json!({ "grantId": "g", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("resumeSession", &json!({ "sessionId": "s", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("listSessions", &json!({ "grantId": "g", "workspaceRoot": "/etc" })).is_err());
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "names", "workspaceRoot": "/etc" })).is_err());
        for (method, mut params) in [
            ("startSession", json!({ "agentId": "harness", "grantId": "g" })),
            ("resumeSession", json!({ "sessionId": "h-1" })),
            ("sendTurn", json!({ "sessionId": "h-1", "text": "hi" })),
            ("listSkills", json!({ "sessionId": "h-1" })),
            ("harnessMcp", json!({ "sessionId": "h-1" })),
            ("harnessMcpConfig", json!({ "sessionId": "h-1" })),
        ] {
            params.as_object_mut().unwrap().insert("harnessMcpTrust".into(), json!({ "workspaceTrusted": true }));
            assert!(validate_params(method, &params).is_err(), "{method} accepted renderer-supplied MCP consent");
        }
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "" })).is_err());
        assert!(validate_params("suggest", &json!({ "grantId": "g", "prompt": "names", "timeoutMs": 0 })).is_err());
        // Stray keys fail closed on every verb family.
        assert!(validate_params("ping", &json!({ "sessionId": "s" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "mode": "allowAll" })).is_err());
        assert!(validate_params("decideApproval", &json!({ "approvalId": "a", "choiceId": "c", "sessionId": "s", "grantId": "g" })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "t", "images": [{ "mediaType": "image/png", "base64Data": "eA==", "path": "/etc/passwd" }] })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "cancel", "sessionId": "s-other" } })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "answer", "answers": [], "text": "x" } })).is_err());
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
        assert!(validate_params("harnessRules", &json!({ "agentId": "muse", "rules": [] })).is_err(), "no other agent exists");
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [], "protectedPaths": [".env", "*.pem", ".glitter/**"] })).is_ok());
        for bad in ["../x", "/etc/passwd", "~/.ssh", "a//b", "a\"b", "a\\b", "[a]", ""] {
            assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [], "protectedPaths": [bad] })).is_err(), "{bad}");
        }
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [], "protectedPaths": (0..101).map(|i| format!("f{i}")).collect::<Vec<_>>() })).is_err());
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [{ "effect": "ask", "rule": "Bash(x)" }] })).is_err(), "the effect is closed");
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [{ "effect": "allow", "rule": "" }] })).is_err());
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": [{ "effect": "allow", "rule": "x".repeat(301) }] })).is_err());
        assert!(validate_params("harnessRules", &json!({ "agentId": "harness", "rules": (0..201).map(|_| json!({ "effect": "deny", "rule": "WebSearch" })).collect::<Vec<_>>() })).is_err());
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
        assert!(validate_params("compactSession", &json!({ "sessionId": "s", "turnId": "t" })).is_err());
        assert!(validate_params("closeSession", &json!({ "sessionId": "s", "turnId": "t" })).is_err());
        assert!(validate_params("readChildSession", &json!({ "sessionId": "h-1" })).is_err());
        assert!(validate_params("readChildSession", &json!({ "sessionId": "h-1", "childSessionId": "h-2", "excludeItems": "no" })).is_err());
        for agent in ["muse", "opencode", "grok", "gemini", "qwen", "goose", "cline", "chatgpt"] {
            assert!(validate_params("startHost", &json!({ "agentId": agent })).is_err(), "{agent} is not an agent");
        }
        assert!(validate_params("setModel", &json!({ "agentId": "muse2", "sessionId": "s", "modelId": "m" })).is_err());
        assert!(validate_params("respondUserInput", &json!({ "sessionId": "s", "userInputId": "q", "response": { "action": "maybe" } })).is_err());
        // Wrong case is not normalized into a valid variant.
        assert!(validate_params("setApprovalMode", &json!({ "sessionId": "s", "mode": "AllowAll" })).is_err());
    }

    #[test]
    fn model_library_entries_are_bounded() {
        let entry = |model: Value| json!({ "entry": model });
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m" }))).is_ok());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "", "model": "m" }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "" }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "a b" }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "contextWindow": 0 }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "contextWindow": 100_000_001 }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "contextWindow": 200_000 }))).is_ok());
        // A default level must be one the entry lists.
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "defaultEffort": "high" }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "efforts": ["low", "high"], "defaultEffort": "high" }))).is_ok());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "effortSource": "guessed" }))).is_err());
        let nine: Vec<Value> = (0..9).map(|_| json!("low")).collect();
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "efforts": nine }))).is_err());
        assert!(validate_params("modelLibraryPut", &entry(json!({ "providerId": "anthropic", "model": "m", "extra": true }))).is_err());
        assert!(validate_params("modelLibraryRemove", &json!({ "modelId": "" })).is_err());
        assert!(validate_params("listProviderModels", &json!({ "providerId": "" })).is_err());
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
    fn size_limits_fail_closed() {
        assert!(validate_request_id("").is_err());
        assert!(validate_request_id(&"i".repeat(129)).is_err());
        assert!(validate_request_id("0192c9d4-7b1a-4e0e-9f2a-9c1d3e5f7a9b").is_ok());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "s", "text": "x".repeat(1_000_001) })).is_err());
        assert!(validate_params("sendTurn", &json!({ "sessionId": "", "text": "t" })).is_err());
        assert!(validate_params("listSessions", &json!({ "cursor": "x".repeat(4_097) })).is_err());
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
