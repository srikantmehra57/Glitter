//! A readable Markdown transcript projected from `muse export`.
//!
//! The CLI document (export schema 1) stays the source. This module only
//! selects the events a person reads — messages, host-recorded thought text,
//! tool calls, approvals and run outcomes — and refuses a schema it does not
//! know. Encrypted reasoning blobs are never copied. The result is not the
//! full export; the header says so.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

/// Per-message ceiling. A longer message is cut in the transcript; the JSON
/// export still has the rest.
const MESSAGE_CHARS: usize = 200_000;
/// Tool arguments and results dominate export size, so they cut sooner.
const TOOL_CHARS: usize = 32 * 1024;
/// Refuse to parse an export larger than this. The JSON export is the way out.
pub(crate) const EXPORT_JSON_CAP: u64 = 64 * 1024 * 1024;

pub(crate) fn render_session_markdown(doc: &Value, title: &str) -> Result<String, String> {
    let version = doc.get("export_schema_version").and_then(Value::as_i64);
    if version != Some(1) {
        return Err("This Muse export uses a schema this app cannot turn into Markdown. Export JSON instead.".into());
    }
    let events = doc
        .get("events")
        .and_then(Value::as_array)
        .ok_or("This Muse export has no event list, so it cannot be turned into Markdown.")?;

    let root = doc
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|items| items.first());
    let root_id = root
        .and_then(|session| session.get("session_id"))
        .and_then(Value::as_str)
        .and_then(safe_token);
    let turns = root
        .and_then(|session| session.get("turn_count"))
        .and_then(json_int);

    let mut sections: Vec<String> = Vec::new();
    let mut calls: HashMap<String, String> = HashMap::new();
    let mut shown_args: HashSet<String> = HashSet::new();
    let mut current_session = root_id.unwrap_or("");

    for event in events {
        let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");
        let envelope = event.get("envelope");
        let payload_type = envelope
            .and_then(|item| item.get("payload_type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let payload = envelope
            .and_then(|item| item.get("payload"))
            .unwrap_or(&Value::Null);
        let session = event
            .get("derived")
            .and_then(|item| item.get("session_id"))
            .and_then(Value::as_str)
            .and_then(safe_token)
            .unwrap_or("");
        if !session.is_empty() && session != current_session {
            note_session(&mut sections, root_id.unwrap_or(""), session);
            current_session = session;
        }

        if kind == "fork" || payload_type == "session.fork.created" {
            if let Some(source) = payload
                .get("source_session_id")
                .and_then(Value::as_str)
                .and_then(safe_token)
            {
                sections.push(format!("## Fork\n\nForked from `{source}`.\n"));
            }
            continue;
        }
        if kind != "record" {
            continue;
        }
        match payload_type {
            "runtime.user_intent.accepted" => push_user(&mut sections, payload),
            "runtime.session" => push_runtime(&mut sections, payload, &mut calls, &mut shown_args),
            _ => {}
        }
    }

    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", heading_text(title)));
    let mode = match doc.get("redaction").and_then(Value::as_str) {
        Some("redacted") => "Share-safe",
        Some("raw") => "Raw",
        Some(other) => {
            if let Some(other) = safe_token(other) {
                out.push_str(&format!("Redaction `{other}` is not one this app knows. Export JSON to keep the log unchanged.\n\n"));
            } else {
                out.push_str("The export's redaction mode is not one this app knows. Export JSON to keep the log unchanged.\n\n");
            }
            "Unrecognized"
        }
        None => {
            out.push_str("The export did not say whether it is share-safe or raw.\n\n");
            "Unrecognized"
        }
    };
    if mode != "Unrecognized" {
        out.push_str(mode);
        out.push_str(" transcript of the Muse session log (export schema 1). ");
    }
    out.push_str("It includes messages, thought text the host recorded, tool calls, approvals and run outcomes. It is not the full export.\n");
    if let Some(id) = root_id {
        out.push_str(&format!("\nSession `{id}`"));
        if let Some(turns) = turns {
            out.push_str(&format!(
                " · {turns} {}",
                if turns == 1 { "turn" } else { "turns" }
            ));
        }
        out.push('\n');
    }
    if doc
        .get("session_terminated_abnormally")
        .and_then(Value::as_bool)
        == Some(true)
    {
        out.push_str("\nThe session ended abnormally.\n");
    }
    if let Some(line) = diagnostics_line(doc) {
        out.push('\n');
        out.push_str(&line);
        out.push('\n');
    }
    out.push('\n');
    if sections.is_empty() {
        out.push_str("This log has no messages to show.\n");
    } else {
        out.push_str(&sections.join("\n"));
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

fn note_session(sections: &mut Vec<String>, root: &str, session: &str) {
    if session == root {
        sections.push(format!("## Thread\n\n`{session}`\n"));
    } else {
        sections.push(format!("## Subagent\n\n`{session}`\n"));
    }
}

fn push_user(sections: &mut Vec<String>, payload: &Value) {
    let (text, notes) = intent_body(payload);
    if text.is_empty() && notes.is_empty() {
        return;
    }
    let mut body = String::new();
    let semantic = payload
        .get("semantic_kind")
        .and_then(|item| item.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("chat");
    if semantic != "chat" && safe_token(semantic).is_some() {
        body.push_str(&format!("({semantic})\n\n"));
    }
    if !text.is_empty() {
        body.push_str(&cap_chars(&text, MESSAGE_CHARS));
        body.push('\n');
    }
    for note in notes {
        body.push_str(&format!("({note})\n"));
    }
    sections.push(format!("## You\n\n{body}"));
}

fn intent_body(payload: &Value) -> (String, Vec<String>) {
    let blocks = payload.get("refill_blocks").and_then(Value::as_array);
    if let Some(blocks) = blocks {
        return blocks_body(blocks);
    }
    let mut text = String::new();
    let mut notes = Vec::new();
    let messages = payload
        .get("model_messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten();
    for message in messages {
        let content = message.get("content").and_then(Value::as_array);
        let Some(content) = content else {
            continue;
        };
        let (part, part_notes) = blocks_body(content);
        if !part.is_empty() {
            if !text.is_empty() {
                text.push_str("\n\n");
            }
            text.push_str(&part);
        }
        notes.extend(part_notes);
    }
    (text, notes)
}

fn blocks_body(blocks: &[Value]) -> (String, Vec<String>) {
    let mut text = String::new();
    let mut notes = Vec::new();
    for block in blocks {
        let kind = block.get("kind").and_then(Value::as_str).unwrap_or("");
        if kind == "text" {
            if let Some(value) = block.get("text").and_then(Value::as_str) {
                let value = value.trim();
                if value.is_empty() {
                    continue;
                }
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(value);
            }
        } else if let Some(kind) = safe_token(kind) {
            notes.push(format!("{kind} block"));
        }
    }
    (text, notes)
}

fn push_runtime(
    sections: &mut Vec<String>,
    payload: &Value,
    calls: &mut HashMap<String, String>,
    shown_args: &mut HashSet<String>,
) {
    let group = payload.get("kind").and_then(Value::as_str).unwrap_or("");
    let Some(event) = payload.get("event") else {
        return;
    };
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("");
    match (group, kind) {
        ("run", "assistant_message_committed") => {
            push_text_section(sections, "Muse", event.get("text"))
        }
        ("run", "reasoning_summary_committed") | ("run", "reasoning_committed") => {
            push_text_section(sections, "Thought", event.get("text"))
        }
        ("run", "assistant_tool_calls_committed") => {
            push_tool_calls(sections, event, calls, shown_args)
        }
        ("run", "tool_result_batch_committed") => push_tool_results(sections, event, calls),
        ("run", "terminal") => push_terminal(sections, event),
        ("approval", "requested") => push_approval_request(sections, event, shown_args),
        ("approval", "decision_applied") => {
            if let Some(decision) = event
                .get("decision")
                .and_then(Value::as_str)
                .and_then(host_label)
            {
                sections.push(format!("## Approval\n\n{decision}\n"));
            }
        }
        _ => {}
    }
}

fn push_text_section(sections: &mut Vec<String>, heading: &str, value: Option<&Value>) {
    let Some(text) = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    else {
        return;
    };
    sections.push(format!(
        "## {heading}\n\n{}\n",
        cap_chars(text, MESSAGE_CHARS)
    ));
}

fn push_tool_calls(
    sections: &mut Vec<String>,
    event: &Value,
    calls: &mut HashMap<String, String>,
    shown_args: &mut HashSet<String>,
) {
    let Some(items) = event.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for call in items {
        let name = call
            .get("name")
            .and_then(Value::as_str)
            .and_then(host_label)
            .unwrap_or_else(|| "Tool call".to_string());
        let id = call
            .get("call_id")
            .and_then(Value::as_str)
            .and_then(safe_token)
            .unwrap_or("")
            .to_string();
        if !id.is_empty() {
            calls.insert(id.clone(), name.clone());
        }
        if !id.is_empty() && shown_args.contains(&id) {
            continue;
        }
        let args = call
            .get("args")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let mut body = String::new();
        if !args.is_empty() {
            body.push_str(&fenced(&cap_chars(args, TOOL_CHARS)));
            body.push('\n');
            if !id.is_empty() {
                shown_args.insert(id);
            }
        }
        if body.is_empty() {
            sections.push(format!("## {name}\n"));
        } else {
            sections.push(format!("## {name}\n\n{body}"));
        }
    }
}

fn push_tool_results(sections: &mut Vec<String>, event: &Value, calls: &HashMap<String, String>) {
    let Some(results) = event.get("results").and_then(Value::as_array) else {
        return;
    };
    for result in results {
        let id = result
            .get("tool_call_id")
            .and_then(Value::as_str)
            .and_then(safe_token)
            .unwrap_or("");
        let name = calls.get(id).map(String::as_str);
        let heading = match name {
            Some(name) => format!("Result · {name}"),
            None => "Result".to_string(),
        };
        let text = result
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let body = if text.is_empty() {
            "The result was empty.\n".to_string()
        } else {
            format!("{}\n", fenced(&cap_chars(text, TOOL_CHARS)))
        };
        sections.push(format!("## {heading}\n\n{body}"));
    }
}

fn push_terminal(sections: &mut Vec<String>, event: &Value) {
    let Some(terminal) = event
        .get("terminal")
        .and_then(Value::as_str)
        .and_then(host_label)
    else {
        return;
    };
    if terminal == "completed" {
        return;
    }
    let mut body = format!("Ended: {terminal}.");
    if let Some(reason) = event
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        body.push_str("\n\n");
        body.push_str(&cap_chars(reason, MESSAGE_CHARS));
    }
    sections.push(format!("## Run\n\n{body}\n"));
}

fn push_approval_request(
    sections: &mut Vec<String>,
    event: &Value,
    shown_args: &mut HashSet<String>,
) {
    let tool = event
        .get("tool_name")
        .and_then(Value::as_str)
        .and_then(host_label);
    let id = event
        .get("tool_call_id")
        .and_then(Value::as_str)
        .and_then(safe_token)
        .unwrap_or("");
    let mut body = match &tool {
        Some(tool) => format!("Requested for {tool}."),
        None => "Requested.".to_string(),
    };
    let command = event
        .pointer("/approval_subject/raw_command")
        .and_then(Value::as_str)
        .or_else(|| event.get("raw_args").and_then(Value::as_str))
        .unwrap_or("")
        .trim();
    if !command.is_empty() && (id.is_empty() || !shown_args.contains(id)) {
        body.push_str("\n\n");
        body.push_str(&fenced(&cap_chars(command, TOOL_CHARS)));
        if !id.is_empty() {
            shown_args.insert(id.to_string());
        }
    }
    sections.push(format!("## Approval\n\n{body}\n"));
}

fn diagnostics_line(doc: &Value) -> Option<String> {
    let diagnostics = doc.get("diagnostics")?.as_object()?;
    let mut parts = Vec::new();
    let unparseable = diagnostics
        .get("unparseable_lines")
        .and_then(json_int)
        .unwrap_or(0);
    let unknown = diagnostics
        .get("unknown_payload_kinds")
        .and_then(json_int)
        .unwrap_or(0);
    let gaps = diagnostics.get("gaps").and_then(json_int).unwrap_or(0);
    if unparseable > 0 {
        parts.push(counted(unparseable, "unreadable line", "unreadable lines"));
    }
    if unknown > 0 {
        parts.push(counted(unknown, "unknown record", "unknown records"));
    }
    if gaps > 0 {
        parts.push(counted(gaps, "gap", "gaps"));
    }
    if parts.is_empty() {
        return None;
    }
    let joined = match parts.len() {
        1 => parts.remove(0),
        2 => format!("{} and {}", parts[0], parts[1]),
        _ => {
            let last = parts.pop().unwrap_or_default();
            format!("{}, and {last}", parts.join(", "))
        }
    };
    Some(format!("The log reported {joined}."))
}

fn counted(n: u64, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn heading_text(title: &str) -> String {
    let flat: String = title
        .chars()
        .take(200)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.is_empty() {
        "Muse thread".to_string()
    } else {
        flat
    }
}

/// A host label for a heading or a one-line outcome. Control characters and
/// line breaks are flattened so the value cannot open a new Markdown block.
fn host_label(value: &str) -> Option<String> {
    let flat: String = value
        .chars()
        .take(80)
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    let flat = flat.trim_matches('#').trim();
    if flat.is_empty() {
        None
    } else {
        Some(flat.to_string())
    }
}

/// Ids and host enumerations that are safe to place in a Markdown line.
fn safe_token(value: &str) -> Option<&str> {
    if value.is_empty() || value.len() > 80 {
        return None;
    }
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        Some(value)
    } else {
        None
    }
}

fn json_int(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().filter(|n| *n >= 0).map(|n| n as u64))
}

fn cap_chars(text: &str, max: usize) -> String {
    let mut out = String::new();
    for (index, ch) in text.chars().enumerate() {
        if index == max {
            let rest = text.chars().count() - max;
            out.push_str(&format!(
                "\n\n[Cut here. {rest} more characters are in the JSON export.]"
            ));
            return out;
        }
        out.push(ch);
    }
    out
}

fn fenced(body: &str) -> String {
    let mut run = 0usize;
    let mut longest = 0usize;
    for ch in body.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(if longest >= 3 { longest + 1 } else { 3 });
    format!("{fence}\n{}\n{fence}", body.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "export_schema_version": 1,
            "redaction": "redacted",
            "session_terminated_abnormally": false,
            "sessions": [{ "session_id": "s-1", "turn_count": 1 }],
            "diagnostics": { "unparseable_lines": 0, "unknown_payload_kinds": 1, "gaps": 0 },
            "events": [
                {
                    "kind": "fork",
                    "envelope": { "payload_type": "session.fork.created", "payload": { "source_session_id": "s-0" } }
                },
                {
                    "kind": "record",
                    "derived": { "session_id": "s-1" },
                    "envelope": {
                        "payload_type": "runtime.user_intent.accepted",
                        "payload": {
                            "semantic_kind": { "kind": "chat" },
                            "refill_blocks": [{ "kind": "text", "text": "hello ``` code" }, { "kind": "image", "text": "hidden-bytes" }]
                        }
                    }
                },
                {
                    "kind": "record",
                    "derived": { "session_id": "s-1" },
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": {
                            "kind": "run",
                            "event": { "kind": "reasoning_committed", "text": "", "encrypted_content": "cipher-blob-do-not-copy" }
                        }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": { "kind": "run", "event": { "kind": "reasoning_summary_committed", "text": "Looked at the file." } }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": { "kind": "run", "event": { "kind": "assistant_message_committed", "text": "Done." } }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": {
                            "kind": "run",
                            "event": {
                                "kind": "assistant_tool_calls_committed",
                                "tool_calls": [{ "name": "bash", "call_id": "call-1", "args": "{\"command\":\"ls\"}" }]
                            }
                        }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": {
                            "kind": "approval",
                            "event": {
                                "kind": "requested",
                                "tool_name": "bash",
                                "tool_call_id": "call-1",
                                "approval_subject": { "raw_command": "ls" }
                            }
                        }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": { "kind": "approval", "event": { "kind": "decision_applied", "decision": "approved" } }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": {
                            "kind": "run",
                            "event": { "kind": "tool_result_batch_committed", "results": [{ "tool_call_id": "call-1", "text": "a.txt" }] }
                        }
                    }
                },
                {
                    "kind": "record",
                    "derived": { "session_id": "child-1" },
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": { "kind": "run", "event": { "kind": "terminal", "terminal": "completed" } }
                    }
                },
                {
                    "kind": "record",
                    "envelope": {
                        "payload_type": "runtime.session",
                        "payload": { "kind": "run", "event": { "kind": "terminal", "terminal": "failed", "reason": "not logged in" } }
                    }
                },
                { "kind": "retained_frame", "envelope": { "retained_frame": "secret-frame" } }
            ]
        })
    }

    #[test]
    fn projects_the_readable_events_and_leaves_the_rest_out() {
        let markdown = render_session_markdown(&sample(), "Fix auth").unwrap();
        assert!(markdown.starts_with("# Fix auth\n"));
        assert!(markdown.contains("Share-safe transcript"));
        assert!(markdown.contains("not the full export"));
        assert!(markdown.contains("Session `s-1` · 1 turn"));
        assert!(markdown.contains("1 unknown record"));
        assert!(markdown.contains("## Fork\n\nForked from `s-0`."));
        assert!(markdown.contains("## You\n\nhello ``` code\n(image block)"));
        assert!(!markdown.contains("hidden-bytes"));
        assert!(markdown.contains("## Thought\n\nLooked at the file."));
        assert!(!markdown.contains("cipher-blob-do-not-copy"));
        assert!(markdown.contains("## Muse\n\nDone."));
        assert!(markdown.contains("## bash\n\n```\n{\"command\":\"ls\"}\n```"));
        assert!(markdown.contains("## Approval\n\nRequested for bash.\n"));
        assert!(!markdown.contains("## Approval\n\nRequested for bash.\n\n```"));
        assert!(markdown.contains("## Approval\n\napproved"));
        assert!(markdown.contains("## Result · bash\n\n```\na.txt\n```"));
        assert!(markdown.contains("## Subagent\n\n`child-1`"));
        assert!(markdown.contains("## Run\n\nEnded: failed.\n\nnot logged in"));
        assert!(!markdown.contains("Ended: completed"));
        assert!(!markdown.contains("secret-frame"));
        let bash = markdown.match_indices("## bash").count();
        assert_eq!(
            bash, 1,
            "the approval does not repeat arguments already shown"
        );
    }

    #[test]
    fn an_unknown_schema_is_refused() {
        let error =
            render_session_markdown(&json!({ "export_schema_version": 2, "events": [] }), "T")
                .unwrap_err();
        assert!(error.contains("Export JSON instead"));
    }

    #[test]
    fn a_log_with_no_messages_says_so() {
        let doc = json!({
            "export_schema_version": 1,
            "redaction": "raw",
            "sessions": [{ "session_id": "s-9", "turn_count": 0 }],
            "events": [{ "kind": "record", "envelope": { "payload_type": "session.end", "payload": {} } }]
        });
        let markdown = render_session_markdown(&doc, "  ").unwrap();
        assert!(markdown.contains("# Muse thread\n"));
        assert!(markdown.contains("Raw transcript"));
        assert!(markdown.contains("0 turns"));
        assert!(markdown.contains("This log has no messages to show."));
    }

    #[test]
    fn fences_grow_past_backticks_and_long_tool_text_is_cut() {
        let long = format!("```\n{}", "x".repeat(TOOL_CHARS));
        let doc = json!({
            "export_schema_version": 1,
            "redaction": "raw",
            "sessions": [],
            "events": [{
                "kind": "record",
                "envelope": {
                    "payload_type": "runtime.session",
                    "payload": {
                        "kind": "run",
                        "event": {
                            "kind": "tool_result_batch_committed",
                            "results": [{ "text": long }]
                        }
                    }
                }
            }]
        });
        let markdown = render_session_markdown(&doc, "T").unwrap();
        assert!(markdown.contains("````"));
        assert!(markdown.contains("4 more characters are in the JSON export."));
        assert!(!markdown.contains(&"x".repeat(TOOL_CHARS + 4)));
    }

    #[test]
    fn an_abnormal_end_and_a_foreign_redaction_are_reported() {
        let doc = json!({
            "export_schema_version": 1,
            "redaction": "scrubbed",
            "session_terminated_abnormally": true,
            "sessions": [],
            "diagnostics": { "unparseable_lines": 2, "gaps": 1 },
            "events": []
        });
        let markdown = render_session_markdown(&doc, "T\n## no").unwrap();
        assert!(markdown.starts_with("# T ## no\n"));
        assert!(markdown.contains("Redaction `scrubbed`"));
        assert!(markdown.contains("ended abnormally"));
        assert!(markdown.contains("2 unreadable lines and 1 gap"));
    }
}
