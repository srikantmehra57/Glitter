import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, ExternalLink, Info, Link2, LoaderCircle, Server, SquareSlash, TriangleAlert, WandSparkles, X } from "lucide-react";
import { githubDiscard, githubInspect, openUrl } from "../lib/bridge";
import { useModalDialog } from "../lib/dialogFocus";
import { describeError } from "../lib/errors";
import { FEATURED_SOURCES, analysisSummary, componentSummary, pluginTitle, readGithubSource, selectableParts, shortCommit, unsupportedSummary } from "../lib/pluginLibrary";
import { useRetained } from "../lib/presence";
import { currentThread, useAppStore } from "../lib/store";
import type { GithubPreview, PluginInstallOutcome } from "../lib/types";
import { ExtensionThumb } from "./ExtensionThumb";

/** What opened the dialog: empty for a fresh link, or a repository (and marketplace plugin) to fetch at once. */
export type GithubRequest = { id: number; source?: string; plugin?: string | null; selected?: string[] | null; update?: boolean };

type Phase = "idle" | "fetching" | "ready" | "working" | "done";

function PartGroup({ icon, title, hint, names, selected, onToggle, onAll, children }: {
  icon: ReactNode;
  title: string;
  hint: string;
  names: string[];
  selected: Set<string>;
  onToggle: (name: string) => void;
  onAll: (names: string[], on: boolean) => void;
  children: (name: string, index: number) => ReactNode;
}) {
  if (!names.length) return null;
  const chosen = names.filter((name) => selected.has(name)).length;
  const all = chosen === names.length;
  return (
    <section className="gh-group">
      <header className="gh-group-head">
        <span className="gh-group-title">{icon}{title}<span className="gh-group-count">{chosen}/{names.length}</span></span>
        {names.length > 1 ? <button type="button" className="ghost-btn small" onClick={() => onAll(names, !all)}>{all ? "Select none" : "Select all"}</button> : null}
      </header>
      <p className="gh-group-hint">{hint}</p>
      <ul className="gh-parts">
        {names.map((name, index) => (
          <li key={name}>
            <label className={`gh-part${selected.has(name) ? " on" : ""}`}>
              <input type="checkbox" checked={selected.has(name)} onChange={() => onToggle(name)} />
              {children(name, index)}
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Add from GitHub: paste a repository, see exactly what it holds, choose what
 * to install. A marketplace is added as a source instead, and its plugins show
 * in Discover. Every fetch and write happens natively; this only shows the
 * preview and sends back the token and the choice.
 */
export function GithubInstallDialog({ request, onClose, onAddedSource }: {
  request: GithubRequest | null;
  onClose: () => void;
  onAddedSource?: (id: string) => void;
}) {
  const shown = useRetained(request);
  const open = Boolean(request);
  const node = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const run = useRef(0);
  /** The preview whose staged download is still on disk, to discard when replaced or closed. */
  const held = useRef<GithubPreview | null>(null);
  const [source, setSource] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [outcome, setOutcome] = useState<PluginInstallOutcome | null>(null);
  const s = useAppStore(useShallow((state) => ({
    threads: state.threads,
    selectedSessionId: state.selectedSessionId,
    installLibraryPlugin: state.installLibraryPlugin,
    addMarketplace: state.addMarketplace,
  })));
  const thread = currentThread(s);
  const typed = readGithubSource(source);

  useModalDialog(open, node);

  const inspect = async (spec: string, plugin?: string | null, keep?: string[] | null) => {
    const ticket = ++run.current;
    setPhase("fetching"); setError(null); setOutcome(null);
    if (held.current) void githubDiscard(held.current.token).catch(() => {});
    held.current = null;
    setPreview(null);
    try {
      const fetched = await githubInspect(spec, plugin);
      if (ticket !== run.current) { void githubDiscard(fetched.token).catch(() => {}); return; }
      held.current = fetched;
      setPreview(fetched);
      const parts = fetched.plugin ? selectableParts(fetched.plugin) : [];
      const wanted = keep?.length ? parts.filter((name) => keep.includes(name)) : parts;
      setSelected(new Set(wanted.length ? wanted : parts));
      setPhase("ready");
    } catch (failure) {
      if (ticket !== run.current) return;
      setError(describeError("Could not read that repository", failure));
      setPhase("idle");
    }
  };

  useEffect(() => {
    if (!request) return;
    setSource(request.source ?? "");
    setPreview(null); setError(null); setOutcome(null); setSelected(new Set());
    if (request.source) void inspect(request.source, request.plugin, request.selected);
    else {
      setPhase("idle");
      window.setTimeout(() => input.current?.focus(), 0);
    }
    // A new request id is a new dialog session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id]);

  const close = () => {
    run.current += 1;
    if (held.current && phase !== "done") void githubDiscard(held.current.token).catch(() => {});
    held.current = null;
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!typed.repo || phase === "fetching" || phase === "working") return;
    void inspect(source.trim());
  };

  const toggle = (name: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    return next;
  });
  const setAll = (names: string[], on: boolean) => setSelected((current) => {
    const next = new Set(current);
    for (const name of names) if (on) next.add(name); else next.delete(name);
    return next;
  });

  const install = async () => {
    if (!preview?.plugin || phase !== "ready") return;
    const parts = selectableParts(preview.plugin);
    const chosen = parts.filter((name) => selected.has(name));
    if (!chosen.length) return;
    setPhase("working"); setError(null);
    try {
      const done = await s.installLibraryPlugin(preview.token, chosen.length === parts.length ? null : chosen, thread?.sessionId);
      held.current = null;
      setOutcome(done);
      setPhase("done");
    } catch (failure) {
      setError(describeError(`Could not install ${pluginTitle(preview.plugin)}`, failure));
      setPhase("ready");
    }
  };

  const addSource = async () => {
    if (!preview?.marketplace || phase !== "ready") return;
    setPhase("working"); setError(null);
    try {
      const added = await s.addMarketplace(preview.token);
      held.current = null;
      setPreview(null);
      onAddedSource?.(added.id);
      onClose();
    } catch (failure) {
      setError(describeError("Could not add that source", failure));
      setPhase("ready");
    }
  };

  const plugin = preview?.plugin ?? null;
  const market = preview?.marketplace ?? null;
  const fetchingName = typed.repo ?? (shown?.source ? readGithubSource(shown.source).repo : null);
  const title = shown?.update ? "Update plugin" : shown?.plugin ? "Install plugin" : "Add from GitHub";
  const chosenCount = plugin ? selectableParts(plugin).filter((name) => selected.has(name)).length : 0;
  const unsupported = plugin ? unsupportedSummary(plugin) : null;
  const notes = [...(preview?.conflicts ?? []), ...(plugin?.notes ?? [])];
  // A plugin's own logo leads; a marketplace listing without one keeps its
  // generated tile with the owner's avatar in the corner, as Discover shows it.
  const listed = Boolean(preview?.origin.plugin);
  const thumb = preview?.icon ?? (listed ? null : preview?.avatar ?? null);
  const corner = preview?.icon || listed ? preview?.avatar ?? null : null;

  return <dialog ref={node} className="modal github-dialog" aria-labelledby="github-dialog-title" aria-hidden={!open} onCancel={(event) => { event.preventDefault(); if (phase !== "working") close(); }} onClose={close} onClick={(event) => { if (event.target === event.currentTarget && phase !== "working") close(); }}>
    <header className="github-dialog-head">
      <h2 id="github-dialog-title">{title}</h2>
      <button type="button" className="icon-btn" aria-label="Close" disabled={phase === "working"} onClick={close}><X size={16} /></button>
    </header>

    {shown?.plugin ? null : <form className="github-source" onSubmit={submit}>
      <label className="search-field github-source-field">
        <Link2 size={14} aria-hidden="true" />
        <input
          ref={input}
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder="github.com/owner/repo"
          aria-label="GitHub repository"
          aria-invalid={Boolean(typed.problem)}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          disabled={phase === "working"}
        />
      </label>
      <button type="submit" className="secondary" disabled={!typed.repo || phase === "fetching" || phase === "working"}>{phase === "fetching" ? "Fetching…" : preview ? "Fetch again" : "Fetch"}</button>
    </form>}
    {typed.problem && !shown?.plugin ? <p className="github-hint error" role="alert">{typed.problem}</p> : null}

    <div className="github-body">
      {phase === "idle" && !preview && !error ? <div className="github-idle">
        <p className="github-hint">A plugin, a marketplace of plugins, or a repository of skills. Claude Code and Codex plugins are both read; nothing is installed until you choose.</p>
        <span className="github-try-label">Try one</span>
        <ul className="github-try">
          {FEATURED_SOURCES.map((featured) => (
            <li key={featured.spec}>
              <button type="button" onClick={() => { setSource(featured.spec); void inspect(featured.spec); }}>
                <ExtensionThumb kind={featured.kind === "marketplace" ? "plugin" : "skill"} id={featured.spec} name={featured.name} size={28} />
                <span><strong>{featured.name}</strong><code>{featured.spec}</code></span>
              </button>
            </li>
          ))}
        </ul>
      </div> : null}

      {phase === "fetching" ? <div className="github-loading" role="status" aria-live="polite">
        <div className="github-skeleton"><span /><span><i /><i /><i /></span></div>
        <p><LoaderCircle size={13} className="spin" aria-hidden="true" />Fetching {fetchingName ?? "the repository"}{shown?.plugin ? ` for ${shown.plugin}` : ""} from GitHub…</p>
      </div> : null}

      {error ? <p className="github-error" role="alert"><TriangleAlert size={14} aria-hidden="true" />{error}</p> : null}

      {phase === "done" && plugin && outcome ? <div className="github-done" role="status">
        <span className="github-done-mark"><Check size={20} strokeWidth={2.4} /></span>
        <h3>{pluginTitle(plugin)} is installed</h3>
        <p>{componentSummary({ skills: outcome.skills.length, commands: outcome.commands.length, servers: outcome.servers.length })}. The built-in agent picks them up on its next turn; type / in the composer to call a skill by name.</p>
        {outcome.problems.length ? <ul className="github-notes">{outcome.problems.map((problem) => <li key={problem}><Info size={12} aria-hidden="true" />{problem}</li>)}</ul> : null}
      </div> : null}

      {preview && phase !== "done" && phase !== "fetching" ? <>
        <div className="github-hero">
          <ExtensionThumb kind="plugin" id={plugin?.name ?? market?.name ?? preview.origin.repo} name={plugin?.name ?? market?.name} size={56} src={thumb} badge={corner} category={plugin?.category} />
          <div className="github-hero-copy">
            <h3>
              {plugin ? pluginTitle(plugin) : market ? pluginTitle({ name: market.name }) : preview.origin.repo}
              {plugin?.version ? <span className="picker-tag">v{plugin.version}</span> : null}
              {market ? <span className="picker-tag">Marketplace</span> : null}
              {preview.installed ? <span className="picker-tag free"><Check size={9} />Installed</span> : null}
            </h3>
            <p className="github-hero-meta">
              {plugin?.author ?? market?.owner ? <span>{plugin?.author ?? market?.owner}</span> : null}
              <button type="button" className="github-link" title={preview.origin.url} onClick={() => void openUrl(preview.origin.url)}>{preview.origin.owner}/{preview.origin.repo}{preview.origin.path ? `/${preview.origin.path}` : ""}<ExternalLink size={11} aria-hidden="true" /></button>
              <code title={preview.origin.commit}>{shortCommit(preview.origin.commit)}</code>
            </p>
            {plugin?.description ?? market?.description ? <p className="github-hero-desc">{plugin?.description ?? market?.description}</p> : null}
            {plugin ? <div className="github-tags">
              {plugin.formats.map((format) => <span key={format} className="picker-tag">{format}</span>)}
              {plugin.license ? <span className="picker-tag">{plugin.license}</span> : null}
              {plugin.category ? <span className="picker-tag">{plugin.category}</span> : null}
            </div> : null}
          </div>
        </div>
        {plugin?.longDescription ? <p className="github-long">{plugin.longDescription}</p> : null}

        {plugin ? <>
          <p className="github-summary">{analysisSummary(plugin)}</p>
          <PartGroup icon={<WandSparkles size={13} aria-hidden="true" />} title="Skills" hint="Instructions the agent loads when a request matches them." names={plugin.skills.map((row) => row.name)} selected={selected} onToggle={toggle} onAll={setAll}>
            {(name, index) => <span className="gh-part-copy"><code>{name}</code><span>{plugin.skills[index].description}</span></span>}
          </PartGroup>
          <PartGroup icon={<SquareSlash size={13} aria-hidden="true" />} title="Commands" hint="Installed as skills you call with /name." names={plugin.commands.map((row) => row.name)} selected={selected} onToggle={toggle} onAll={setAll}>
            {(name, index) => <span className="gh-part-copy"><code>/{name}</code><span>{plugin.commands[index].description}</span></span>}
          </PartGroup>
          <PartGroup icon={<Server size={13} aria-hidden="true" />} title="MCP servers" hint="Added to ~/.glitter/mcp.json. They start on this Mac, and their tool calls follow the thread's permissions." names={plugin.servers.map((row) => row.name)} selected={selected} onToggle={toggle} onAll={setAll}>
            {(name, index) => {
              const server = plugin.servers[index];
              return <span className="gh-part-copy"><code>{name}<span className="picker-tag">{server.transport}</span></code><span className="gh-command" title={server.display}>{server.display}</span>{server.needsEnv.length ? <span className="gh-warn">Needs {server.needsEnv.join(", ")}</span> : null}</span>;
            }}
          </PartGroup>
          {unsupported || notes.length ? <ul className="github-notes">
            {unsupported ? <li><Info size={12} aria-hidden="true" />{unsupported}</li> : null}
            {notes.map((note) => <li key={note}><Info size={12} aria-hidden="true" />{note}</li>)}
          </ul> : null}
        </> : null}

        {market ? <section className="gh-group">
          <header className="gh-group-head"><span className="gh-group-title">Plugins<span className="gh-group-count">{market.plugins.length}</span></span></header>
          <p className="gh-group-hint">Adding the source lists these in Discover. Each one is fetched and shown to you before it installs.</p>
          <ul className="github-market">
            {market.plugins.slice(0, 12).map((row) => (
              <li key={row.name}>
                <ExtensionThumb kind="plugin" id={row.name} category={row.category} size={24} />
                <span><strong>{pluginTitle(row)}</strong>{row.description ? <span>{row.description}</span> : null}</span>
              </li>
            ))}
          </ul>
          {market.plugins.length > 12 ? <p className="gh-group-hint">and {market.plugins.length - 12} more.</p> : null}
        </section> : null}
      </> : null}
    </div>

    <footer className="github-dialog-foot">
      {phase === "done" ? <button type="button" className="primary" onClick={close}>Done</button> : <>
        <span className="github-foot-note">{plugin ? "Skills go to ~/.agents/skills. Remove takes back only what was installed." : market ? "A source only lists plugins; it installs nothing." : "Uses git and your own GitHub access."}</span>
        <button type="button" className="ghost-btn" disabled={phase === "working"} onClick={close}>Cancel</button>
        {!preview ? null : market ? <button type="button" className="primary" disabled={phase !== "ready"} onClick={() => void addSource()}>{phase === "working" ? "Adding…" : "Add source"}</button>
          : <button type="button" className="primary" disabled={phase !== "ready" || !plugin || !chosenCount} onClick={() => void install()}>{phase === "working" ? "Installing…" : shown?.update || preview?.installed ? "Update" : chosenCount && plugin && chosenCount < selectableParts(plugin).length ? `Install ${chosenCount}` : "Install"}</button>}
      </>}
    </footer>
  </dialog>;
}
