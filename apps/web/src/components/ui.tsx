import { CircleAlert, CircleCheck, Info, X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type Ref } from "react";
import type { Tone } from "../lib/labels";

export function PageHeader({ title, description, actions, breadcrumb }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-heading">
        {breadcrumb}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Card({ title, description, actions, footer, className = "", children }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode; footer?: ReactNode; className?: string; children?: ReactNode;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {description && <p className="card-desc">{description}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {children && <div className="card-content">{children}</div>}
      {footer && <div className="card-footer">{footer}</div>}
    </section>
  );
}

export function Badge({ tone = "neutral", dot = false, title, children }: {
  tone?: Tone; dot?: boolean; title?: string; children: ReactNode;
}) {
  return (
    <span className={tone === "neutral" ? "badge" : `badge badge-${tone}`} title={title}>
      {dot && <span className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

const ALERT_ICON = { danger: CircleAlert, success: CircleCheck, info: Info };

export function Alert({ tone = "info", sticky = false, children }: {
  tone?: "danger" | "success" | "info"; sticky?: boolean; children: ReactNode;
}) {
  const Icon = ALERT_ICON[tone];
  return (
    <div className={`alert alert-${tone}${sticky ? " alert-sticky" : ""}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon size={16} aria-hidden="true" />
      <div className="alert-body">{children}</div>
    </div>
  );
}

// Поле огортає control у <label>, тому окремі id/htmlFor не потрібні.
export function Field({ label, hint, className = "", children }: {
  label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <label className={`field ${className}`}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Switch({ checked, onChange, disabled, label, ariaLabel }: {
  checked: boolean; onChange?: (next: boolean) => void; disabled?: boolean; label: ReactNode; ariaLabel: string;
}) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={ariaLabel}
      disabled={disabled} onClick={() => onChange?.(!checked)}>
      <span className="switch-track" aria-hidden="true"><span className="switch-thumb" /></span>
      {label}
    </button>
  );
}

export function Tabs<T extends string>({ items, value, onChange, label }: {
  items: { value: T; label: string; count?: number | string | undefined }[]; value: T; onChange: (next: T) => void; label: string;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () => {
      const selected = element.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
      if (!selected) return;
      const outer = element.getBoundingClientRect(), inner = selected.getBoundingClientRect();
      if (inner.left < outer.left) element.scrollLeft += inner.left - outer.left;
      else if (inner.right > outer.right) element.scrollLeft += inner.right - outer.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [value]);
  return (
    <div ref={strip} className="tabs" role="group" aria-label={label}>
      {items.map((item) => (
        <button key={item.value} type="button" className="tab" aria-pressed={item.value === value} onClick={() => onChange(item.value)}>
          {item.label}
          {item.count !== undefined && <span className="tab-count">{typeof item.count === "number" ? item.count.toLocaleString("uk-UA") : item.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon" aria-hidden="true">{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Dialog({ ref, title, titleId, footer, children }: {
  ref: Ref<HTMLDialogElement>; title: string; titleId: string; footer?: ReactNode; children?: ReactNode;
}) {
  return (
    <dialog ref={ref} className="dialog" aria-labelledby={titleId}>
      <div className="dialog-header">
        <h2 className="dialog-title" id={titleId}>{title}</h2>
        <form method="dialog"><button className="btn btn-ghost btn-icon btn-sm" aria-label="Закрити"><X size={16} aria-hidden="true" /></button></form>
      </div>
      {children && <div className="dialog-body">{children}</div>}
      {footer && <div className="dialog-footer">{footer}</div>}
    </dialog>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}
