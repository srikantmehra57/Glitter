import { useState } from "react";
import { Activity, ArrowRightLeft, BadgeCheck, BookOpen, Bot, Brain, Briefcase, Bug, Calculator, ChartColumn, Clock, Cloud, Code, Coffee, Compass, Container, CreditCard, Cpu, Database, FileSpreadsheet, FileText, Film, FlaskConical, FolderTree, Gamepad2, Gauge, GitCommitHorizontal, GitPullRequest, Globe, GraduationCap, Image, Layers, Library, Lightbulb, ListTree, Lock, Mail, MapPin, MessageSquare, MonitorPlay, Music, Package, Paintbrush, Palette, Plug, Presentation, Rocket, ScanSearch, Server, ShieldCheck, Smartphone, SquareTerminal, UploadCloud, WandSparkles, Webhook, Workflow, type LucideIcon } from "lucide-react";
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
  document: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
  image: Image,
  video: Film,
  audio: Music,
  cloud: Cloud,
  container: Container,
  mobile: Smartphone,
  agent: Bot,
  plug: Plug,
  mail: Mail,
  chart: ChartColumn,
  monitor: Activity,
  lock: Lock,
  art: Paintbrush,
  game: Gamepad2,
  learn: GraduationCap,
  location: MapPin,
  math: Calculator,
  migrate: ArrowRightLeft,
  automation: Workflow,
  language: Cpu,
  code: Code,
  productivity: Briefcase,
  payments: CreditCard,
  chat: MessageSquare,
  deploy: UploadCloud,
  skill: WandSparkles,
  plugin: Package,
  server: Server,
};

/**
 * An extension's thumbnail: its own logo when it ships one, else a tinted tile
 * with the icon for what it does. `badge` is a small corner mark, such as the
 * avatar of the marketplace that lists it. Decorative; the row names it.
 */
export function ExtensionThumb({ kind, id, name, size = 36, src, badge, category }: {
  kind: ExtensionKind;
  id: string;
  name?: string;
  size?: number;
  src?: string | null;
  badge?: string | null;
  category?: string | null;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const [badgeBroken, setBadgeBroken] = useState<string | null>(null);
  const art = extensionArt(kind, id, name, category);
  const Icon = ICONS[art.icon];
  const image = src && broken !== src ? src : null;
  const corner = badge && badgeBroken !== badge ? badge : null;
  return (
    <span className={`ext-thumb tone-${art.tone}${image ? " has-image" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      {image ? <img src={image} alt="" draggable={false} onError={() => setBroken(image)} /> : <Icon size={Math.round(size * 0.46)} strokeWidth={1.8} />}
      {corner ? <img className="ext-thumb-badge" src={corner} alt="" draggable={false} onError={() => setBadgeBroken(corner)} /> : null}
    </span>
  );
}
