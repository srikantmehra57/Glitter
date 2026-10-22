import { BadgeCheck, BookOpen, Brain, Bug, Clock, Coffee, Compass, Database, FlaskConical, FolderTree, Gauge, GitCommitHorizontal, GitPullRequest, Globe, Layers, Library, Lightbulb, ListTree, MonitorPlay, Package, Palette, Rocket, ScanSearch, Server, ShieldCheck, SquareTerminal, WandSparkles, Webhook, type LucideIcon } from "lucide-react";
import { extensionArt, type ExtensionIcon, type ExtensionKind } from "../lib/extensionArt";

const ICONS: Record<ExtensionIcon, LucideIcon> = {
  review: ScanSearch,
  commit: GitCommitHorizontal,
  "pull-request": GitPullRequest,
  test: FlaskConical,
  debug: Bug,
  refactor: Layers,
  security: ShieldCheck,
  performance: Gauge,
  design: Palette,
  docs: BookOpen,
  explain: Lightbulb,
  release: Rocket,
  folder: FolderTree,
  steps: ListTree,
  memory: Brain,
  web: Globe,
  time: Clock,
  browser: MonitorPlay,
  library: Library,
  compass: Compass,
  database: Database,
  api: Webhook,
  terminal: SquareTerminal,
  daily: Coffee,
  quality: BadgeCheck,
  skill: WandSparkles,
  plugin: Package,
  server: Server,
};

/** An extension's thumbnail: a tinted tile with the icon for what it does. Decorative; the row names it. */
export function ExtensionThumb({ kind, id, name, size = 36 }: { kind: ExtensionKind; id: string; name?: string; size?: number }) {
  const art = extensionArt(kind, id, name);
  const Icon = ICONS[art.icon];
  return (
    <span className={`ext-thumb tone-${art.tone}`} style={{ width: size, height: size }} aria-hidden="true">
      <Icon size={Math.round(size * 0.46)} strokeWidth={1.8} />
    </span>
  );
}
