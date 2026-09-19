import { Activity, Inbox, LogOut, Menu, Moon, Newspaper, Radio, Sun, UserRound, Users } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { can, type Me } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { ROLES } from "../lib/labels";
import { useTheme } from "../lib/theme";
import { Badge } from "./ui";

export function Brand({ sub = "Vodafone Україна" }: { sub?: string }) {
  return (
    <>
      <span className="brand-mark"><Activity size={18} aria-hidden="true" /></span>
      <span className="brand-text">
        <span className="brand-name">Монітор бренду</span>
        <span className="brand-sub">{sub}</span>
      </span>
    </>
  );
}

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { theme, toggle } = useTheme();
  const Icon = theme === "dark" ? Sun : Moon;
  const label = theme === "dark" ? "Світла тема" : "Темна тема";
  return compact
    ? <button type="button" className="btn btn-ghost btn-icon" aria-label={label} onClick={toggle}><Icon size={16} aria-hidden="true" /></button>
    : <button type="button" className="btn btn-ghost btn-sm" onClick={toggle}><Icon size={16} aria-hidden="true" />{label}</button>;
}

export function Shell({ me, children }: { me: Me | undefined; children: ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  useEffect(() => {
    if (!navOpen) return;
    const listener = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [navOpen]);

  const manage = can(me, "collector", "manage") || can(me, "user", "list");
  return (
    <div className="app" data-nav-open={navOpen}>
      <aside className="sidebar" id="sidebar">
        <Link to="/" className="brand"><Brand /></Link>
        <nav aria-label="Основна навігація">
          <div className="nav-group">
            <div className="nav-label">Моніторинг</div>
            <NavLink className="nav-link" to="/" end><Newspaper size={16} aria-hidden="true" />Стрічка</NavLink>
            {can(me, "incident", "edit") && <NavLink className="nav-link" to="/analysis"><Activity size={16} aria-hidden="true" />Аналіз і пошук</NavLink>}
            {can(me, "incident", "edit") && <NavLink className="nav-link" to="/inbox"><Inbox size={16} aria-hidden="true" />Увесь вхід</NavLink>}
          </div>
          {manage && (
            <div className="nav-group">
              <div className="nav-label">Керування</div>
              {can(me, "collector", "manage") && <NavLink className="nav-link" to="/sources"><Radio size={16} aria-hidden="true" />Sources</NavLink>}
              {can(me, "user", "list") && <NavLink className="nav-link" to="/admin/users"><Users size={16} aria-hidden="true" />Користувачі</NavLink>}
            </div>
          )}
          <div className="nav-group">
            <div className="nav-label">Профіль</div>
            <NavLink className="nav-link" to="/account"><UserRound size={16} aria-hidden="true" />Акаунт</NavLink>
          </div>
        </nav>
        {me && (
          <div className="sidebar-foot">
            <div className="user">
              <span className="user-email" title={me.user.email}>{me.user.email}</span>
              <span><Badge tone="secondary">{ROLES[me.user.role] ?? me.user.role}</Badge></span>
            </div>
            <ThemeToggle />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => authClient.signOut()}>
              <LogOut size={16} aria-hidden="true" />Вийти
            </button>
          </div>
        )}
      </aside>
      <button type="button" className="scrim" aria-label="Закрити меню" tabIndex={-1} onClick={() => setNavOpen(false)} />
      <div className="main">
        <div className="topbar">
          <Link to="/" className="brand"><Brand /></Link>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Меню" aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen(!navOpen)}>
            <Menu size={18} aria-hidden="true" />
          </button>
        </div>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
