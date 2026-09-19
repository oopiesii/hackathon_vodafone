import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router";
import { Shell } from "./components/Shell";
import { api, can, type Me } from "./lib/api";
import { authClient } from "./lib/auth-client";
import { AdminUsers } from "./pages/AdminUsers";
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
  return <Routes><Route path="/view" element={<SharedDashboard/>}/><Route path="*" element={<AuthenticatedApp/>}/></Routes>;
}
function AuthenticatedApp() {
  const session = authClient.useSession();
  const signedIn = Boolean(session.data);
  const me = useQuery({ queryKey: ["me", session.data?.user.id], queryFn: () => api<Me>("/me"), enabled: signedIn });

  if (session.isPending || (signedIn && me.isPending)) {
    return <p className="loading" role="status">Завантаження…</p>;
  }

  if (!signedIn) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Shell me={me.data}>
      <Routes>
        <Route path="/" element={<Feed me={me.data} />} />
        {can(me.data, "incident", "edit") && <Route path="/analysis" element={<Analysis />} />}
        {can(me.data, "incident", "edit") && <Route path="/inbox" element={<Incoming me={me.data} />} />}
        {can(me.data, "collector", "manage") && <Route path="/sources" element={<Sources />} />}
        {can(me.data, "collector", "manage") && <Route path="/sources/telegram" element={<TelegramAdmin />} />}
        {can(me.data, "collector", "manage") && <Route path="/sources/rss" element={<RssSources />} />}
        <Route path="/account" element={<Account />} />
        {can(me.data, "collector", "manage") && <Route path="/admin/telegram" element={<TelegramAdmin />} />}
        {can(me.data, "user", "list") && <Route path="/admin/users" element={<AdminUsers />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
