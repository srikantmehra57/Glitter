import type { ReactNode } from "react";

/** A section heading inside a Settings page: title, one-line help and an optional action. */
export function SectionHead({ id, title, help, action }: { id?: string; title: string; help?: ReactNode; action?: ReactNode }) {
  return <div className={`settings-card-heading${action ? " with-action" : ""}`}>
    <div><h4 id={id}>{title}</h4>{help ? <p>{help}</p> : null}</div>
    {action}
  </div>;
}

/** One setting: its name and help on the left, its control on the right. */
export function SettingRow({ label, help, children }: { label: ReactNode; help?: ReactNode; children?: ReactNode }) {
  return <div className="setting-row">
    <div className="setting-copy">{label}{help ? <span className="field-help">{help}</span> : null}</div>
    {children ? <div className="setting-control">{children}</div> : null}
  </div>;
}
