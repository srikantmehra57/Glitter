import { useId, useState } from "react";
import { DEFAULT_PROTECTED_PATHS, HARNESS_RULE_LENGTH, HARNESS_RULE_LIMIT, PROTECTED_PATH_LENGTH, PROTECTED_PATH_LIMIT, effectiveProtectedPaths, harnessRuleProblem, protectedPathProblem } from "../lib/permissionRules";
import type { PermissionRule, PermissionRuleEffect } from "../lib/types";
import { SectionHead } from "./SettingsSection";

const EXAMPLES = "Bash(npm test) · Bash(npm run *) · Read(.env) · WebFetch(docs.example.com) · WebSearch · Mcp(github) · Network";

/**
 * Settings → Permissions: the user's own allow and deny lists for the built-in
 * agent. The harness reads the syntax and answers with the rules it could not
 * parse; those are shown here and ignored there, never widened into a grant.
 */
export function PermissionRulesCard({ rules, onChange, problems, syncError, onRetry }: {
  rules: PermissionRule[];
  onChange: (rules: PermissionRule[]) => void;
  problems: string[];
  syncError?: string | null;
  onRetry?: () => void;
}) {
  return <>
    <SectionHead title="Rules" help="Your own lists, applied to every thread." />
    {syncError ? <div className="settings-note danger" role="alert">
      <p>{syncError}</p>
      {onRetry ? <button type="button" className="text-btn" onClick={onRetry}>Retry applying rules</button> : null}
    </div> : null}
    {problems.length ? <div className="settings-note danger" role="alert">
      <strong>The harness could not use {problems.length === 1 ? "this rule" : `${problems.length} rules`}.</strong>
      <ul>{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>
      <span>They are ignored until you fix them. Nothing was widened to make them work.</span>
    </div> : null}
    <RuleList effect="allow" title="Always allow" help="Skips the approval this rule names, for commands, web calls and MCP tools. A risky command still asks, and the danger checks still run." placeholder="Bash(npm test)" rules={rules} onChange={onChange} />
    <RuleList effect="deny" title="Never allow" help="Matching tool calls are refused in every permission mode, including Full access." placeholder="Edit(.env)" rules={rules} onChange={onChange} />
    <p className="settings-note">Write a rule as Tool(pattern): {EXAMPLES}. A path — Edit(.env), Read(.env), Edit(src/**) — is deny-only: edits already run in Ask and Auto, and reads never ask. A Read rule also keeps search out of the file. Network is allow-only. A Bash rule may end in * to cover a command prefix. Edit rules cover built-in edits; commands can still change those files. Rules cannot inspect commands run indirectly by other programs.</p>
  </>;
}

function RuleList({ effect, title, help, placeholder, rules, onChange }: {
  effect: PermissionRuleEffect;
  title: string;
  help: string;
  placeholder: string;
  rules: PermissionRule[];
  onChange: (rules: PermissionRule[]) => void;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const mine = rules.filter((entry) => entry.effect === effect);
  const full = rules.length >= HARNESS_RULE_LIMIT;
  const add = () => {
    const rule = text.trim();
    const issue = harnessRuleProblem(rule);
    if (issue) { setProblem(issue); return; }
    if (mine.some((entry) => entry.rule === rule)) { setProblem("That rule is already in this list."); return; }
    if (full) { setProblem(`At most ${HARNESS_RULE_LIMIT} rules across both lists.`); return; }
    onChange([...rules, { effect, rule }]);
    setText("");
    setProblem(null);
  };
  return <>
    <SectionHead title={title} help={help} />
    <section className="settings-card permission-rules" aria-label={title}>
      {mine.length ? <ul>
        {mine.map((entry) => <li key={entry.rule}>
          <span><strong>{entry.rule}</strong></span>
          <button type="button" className="ghost-btn small" aria-label={`Remove ${entry.rule} from ${title}`} onClick={() => onChange(rules.filter((kept) => !(kept.effect === effect && kept.rule === entry.rule)))}>Remove</button>
        </li>)}
      </ul> : null}
      <form onSubmit={(event) => { event.preventDefault(); add(); }}>
        <div className="permission-rule-form">
          <input id={id} aria-label={`Add a rule to ${title}`} value={text} placeholder={placeholder} maxLength={HARNESS_RULE_LENGTH} spellCheck={false} disabled={full} onChange={(event) => { setText(event.target.value); setProblem(null); }} />
          <button type="submit" className="secondary small" aria-label={`Add rule to ${title}`} disabled={full}>Add rule</button>
        </div>
        {problem ? <p className="settings-note danger" role="alert">{problem}</p> : null}
        {full ? <p className="settings-note" role="status">Both lists hold {HARNESS_RULE_LIMIT} rules. Remove one to add another.</p> : null}
      </form>
    </section>
  </>;
}

/**
 * Settings → Permissions: files the built-in agent must ask about before each
 * change, in every mode, and that its shell cannot write. `undefined` means
 * the defaults, so a later default reaches everyone who never changed the list.
 */
export function ProtectedPathsCard({ paths, onChange }: { paths: string[] | undefined; onChange: (paths: string[] | undefined) => void }) {
  const id = useId();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const current = effectiveProtectedPaths(paths);
  const isDefault = current.length === DEFAULT_PROTECTED_PATHS.length && current.every((path, index) => path === DEFAULT_PROTECTED_PATHS[index]);
  const full = current.length >= PROTECTED_PATH_LIMIT;
  const save = (next: string[]) => onChange(next.length === DEFAULT_PROTECTED_PATHS.length && next.every((path, index) => path === DEFAULT_PROTECTED_PATHS[index]) ? undefined : next);
  const add = () => {
    const path = text.trim();
    const issue = protectedPathProblem(path);
    if (issue) { setProblem(issue); return; }
    if (current.includes(path)) { setProblem("That path is already protected."); return; }
    if (full) { setProblem(`At most ${PROTECTED_PATH_LIMIT} protected paths.`); return; }
    save([...current, path]);
    setText("");
    setProblem(null);
  };
  return <>
    <SectionHead title="Protected files" help="Agent edits to these ask first in every mode, Full access included, and agent commands cannot change them." />
    <section className="settings-card permission-rules" aria-label="Protected files">
      <ul>
        {current.map((path) => <li key={path}>
          <span><strong>{path}</strong></span>
          <button type="button" className="ghost-btn small" aria-label={`Stop protecting ${path}`} onClick={() => save(current.filter((kept) => kept !== path))}>Remove</button>
        </li>)}
      </ul>
      <form onSubmit={(event) => { event.preventDefault(); add(); }}>
        <div className="permission-rule-form">
          <input id={id} aria-label="Add a protected path" value={text} placeholder="config/secrets/**" maxLength={PROTECTED_PATH_LENGTH} spellCheck={false} disabled={full} onChange={(event) => { setText(event.target.value); setProblem(null); }} />
          <button type="submit" className="secondary small" disabled={full}>Add path</button>
        </div>
        {problem ? <p className="settings-note danger" role="alert">{problem}</p> : null}
        {full ? <p className="settings-note" role="status">{PROTECTED_PATH_LIMIT} paths are protected. Remove one to add another.</p> : null}
      </form>
    </section>
    <p className="settings-note">A name such as .env or *.pem matches in any folder; a path with a slash starts at the workspace folder, and folder/** covers everything inside. Files in node_modules are not protected. Git's own files (.git) are always off-limits.{isDefault ? null : <> <button type="button" className="text-btn" onClick={() => save([...DEFAULT_PROTECTED_PATHS])}>Restore defaults</button></>}</p>
  </>;
}
