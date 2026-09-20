import { Activity, Inbox, LayoutDashboard, LogOut, Menu, Moon, Newspaper, Radio, Sun, Swords, Users, Wrench } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { can, type Me } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { ROLES } from "../lib/labels";
import { useTheme } from "../lib/theme";
import { Badge } from "./ui";

function VodafoneMark() {
  return <svg className="brand-vodafone" viewBox="-.398 -4.59 378.918 388.633" aria-hidden="true">
    <path fill="#e60000" d="m119.441 14.328c47.465-18.918 102.754-17.61 148.954 4.363-13.165-2-26.555-.492-39.586 1.711-35.391 6.684-69.024 23.336-95.313 48.075-25.207 24.777-42.871 57.652-47.86 92.824-3.3 24.922-.241 51.062 10.942 73.746 11.524 23.8 31.809 43.32 56.258 53.394 23.559 9.97 50.887 9.86 74.75.961 35.805-13.14 61.531-48.62 64.473-86.527 1.851-24.844-4.192-51.273-20.883-70.328-15.934-18.652-39.238-28.926-62.559-34.774-1.25-23 9.586-45.722 26.77-60.68 9.543-8.605 21.386-14.09 33.633-17.6l.93-.321c35.058 16.812 64.847 44.539 83.827 78.578 16.262 28.98 24.743 62.375 23.903 95.64-.16 43.016-16.239 85.606-43.801 118.497-26.063 31.367-62.516 53.93-102.246 62.965-39.836 9.191-82.695 5.226-119.977-11.704-36.48-16.293-67.386-44.617-87.047-79.457-16.355-28.953-25.007-62.336-24.289-95.64.078-41.496 14.813-82.672 40.54-115.121 20.55-25.91 47.812-46.512 78.581-58.602z" />
    <path fill="#fff" d="m228.809 20.402c13.03-2.203 26.421-3.71 39.586-1.71l1.89.32-1.265.48c-12.247 3.512-24.09 8.996-33.633 17.602-17.184 14.957-28.02 37.68-26.77 60.68 23.32 5.847 46.625 16.12 62.559 34.773 16.691 19.055 22.734 45.484 20.883 70.328-2.942 37.906-28.668 73.387-64.473 86.527-23.863 8.899-51.191 9.008-74.75-.96-24.45-10.075-44.734-29.594-56.258-53.395-11.183-22.684-14.242-48.824-10.941-73.746 4.988-35.172 22.652-68.047 47.86-92.824 26.288-24.739 59.921-41.391 95.312-48.075zm0 0" />
  </svg>;
}

export function Brand({ sub = "Vodafone Україна", vodafone = false }: { sub?: string; vodafone?: boolean }) {
  return (
    <>
      {vodafone ? <VodafoneMark /> : <span className="brand-mark"><Activity size={18} aria-hidden="true" /></span>}
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
        <Link to="/" className="brand"><Brand vodafone /></Link>
        <nav aria-label="Основна навігація">
          <div className="nav-group">
            <div className="nav-label">Моніторинг</div>
            <NavLink className="nav-link" to="/" end><LayoutDashboard size={16} aria-hidden="true" />Сьогодні</NavLink>
            <NavLink className="nav-link" to="/feed"><Newspaper size={16} aria-hidden="true" />Стрічка</NavLink>
            <NavLink className="nav-link" to="/competitors"><Swords size={16} aria-hidden="true" />Конкуренти</NavLink>
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
            <div className="nav-label">Налаштування</div>
            <NavLink className="nav-link" to="/account"><Wrench size={16} aria-hidden="true" />Розробник</NavLink>
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
          <Link to="/" className="brand"><Brand vodafone /></Link>
          <button type="button" className="btn btn-ghost btn-icon" aria-label="Меню" aria-expanded={navOpen} aria-controls="sidebar" onClick={() => setNavOpen(!navOpen)}>
            <Menu size={18} aria-hidden="true" />
          </button>
        </div>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
