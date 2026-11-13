import { useId, useState } from "react";
import { HARNESS_RULE_LENGTH, HARNESS_RULE_LIMIT, harnessRuleProblem } from "../lib/permissionRules";
import type { PermissionRule, PermissionRuleEffect } from "../lib/types";
import { SectionHead } from "./SettingsSection";

const EXAMPLES = "Bash(npm test) · Bash(npm run *) · WebFetch(docs.example.com) · WebSearch · Mcp(github) · Network";

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
    <SectionHead title="Built-in agent rules" help="Your own lists, applied to every built-in agent thread. Muse and the agent CLIs keep their own permissions." />
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
    <p className="settings-note">Write a rule as Tool(pattern): {EXAMPLES}. A path — Edit(.env), Edit(src/**) — is deny-only, because edits already run in Ask and Auto. Network is allow-only. A Bash rule may end in * to cover a command prefix. Edit rules cover built-in edits; commands can still change those files. Rules cannot inspect commands run indirectly by other programs.</p>
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
