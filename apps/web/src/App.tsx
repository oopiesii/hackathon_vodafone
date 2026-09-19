import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { Shell } from "./components/Shell";
import { api, can, errorText, type Me } from "./lib/api";
import { authClient } from "./lib/auth-client";
import { AdminUsers } from "./pages/AdminUsers";
import { Dashboard } from "./pages/Dashboard";
import { Feed } from "./pages/Feed";
import { Login } from "./pages/Login";
import { TelegramAdmin } from './pages/telegram/TelegramAdmin';
import { RssSources } from './pages/RssSources';
import { Sources } from './pages/Sources';
import { Incoming } from './pages/Incoming';
import { Account } from './pages/Account';
import { SharedDashboard } from './pages/SharedDashboard';
import { Analysis } from './pages/Analysis';

export function App() {
  return <Routes><Route path="/view" element={<PublicApp/>}/><Route path="*" element={<AuthenticatedApp/>}/></Routes>;
}

// A cache belongs to one mounted authorization boundary. Retired requests can
// only complete into their old client; they cannot repopulate the next session.
function QueryScope({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function PublicApp() {
  const location = useLocation();
  const [boundary, setBoundary] = useState({ location, id: 0 });
  // Native same-document hash navigation can reuse the history entry's key.
  // Change the mount identity before any old shared content can be committed.
  if (boundary.location !== location) {
    setBoundary({ location, id: boundary.id + (location.hash ? 1 : 0) });
    return null;
  }
  // A new link resets access. Filters preserve the redeemed scope: rereading
  // an unbound cookie here could adopt another tab's broader share session.
  return <QueryScope key={boundary.id}><SharedDashboard/></QueryScope>;
}
function AuthenticatedApp() {
  const session = authClient.useSession();

  if (session.isPending) {
    return <p className="loading" role="status">Завантаження…</p>;
  }

  if (!session.data) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const identity = JSON.stringify([session.data.session.id, session.data.user.id, session.data.user.role]);
  return <QueryScope key={identity}><AuthorizedApp/></QueryScope>;
}

function AuthorizedApp() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/me"), refetchInterval: 60000, refetchOnWindowFocus: true });
  if (me.isError) return <div className="auth"><div className="auth-card stack" role="alert">
    <p>Не вдалося підтвердити права доступу. {errorText(me.error)}</p>
    <button type="button" className="btn" onClick={() => { void me.refetch(); }} disabled={me.isFetching}>Спробувати знову</button>
    <button type="button" className="btn btn-outline" onClick={() => { void authClient.signOut(); }}>Вийти</button>
  </div></div>;
  if (!me.data) return <p className="loading" role="status">Завантаження…</p>;
  const permissions = Object.entries(me.data.permissions).sort(([a], [b]) => a.localeCompare(b)).map(([resource, actions]) => [resource, [...actions].sort()]);
  const scope = JSON.stringify([me.data.user.id, me.data.user.role, permissions]);
  return <QueryScope key={scope}><PrivateApp me={me.data}/></QueryScope>;
}

function PrivateApp({ me }: { me: Me }) {
  return (
    <Shell me={me}>
      <Routes>
        <Route path="/" element={<Dashboard me={me} />} />
        <Route path="/feed" element={<Feed me={me} />} />
        {can(me, "incident", "edit") && <Route path="/analysis" element={<Analysis />} />}
        {can(me, "incident", "edit") && <Route path="/inbox" element={<Incoming me={me} />} />}
        {can(me, "collector", "manage") && <Route path="/sources" element={<Sources />} />}
        {can(me, "collector", "manage") && <Route path="/sources/telegram" element={<TelegramAdmin />} />}
        {can(me, "collector", "manage") && <Route path="/sources/rss" element={<RssSources />} />}
        <Route path="/account" element={<Account />} />
        {can(me, "collector", "manage") && <Route path="/admin/telegram" element={<TelegramAdmin />} />}
        {can(me, "user", "list") && <Route path="/admin/users" element={<AdminUsers />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
