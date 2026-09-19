import { useEffect, useRef, useState } from "react";
import { Brand, ThemeToggle } from "../components/Shell";
import { Alert, Badge } from "../components/ui";
import { api, errorText } from "../lib/api";
import { Feed } from "./Feed";

export function SharedDashboard() {
  const once = useRef(false), [info, setInfo] = useState<{ name: string; scope: string; workflow_id: string } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    void (async () => {
      try {
        if (location.hash) {
          const token = location.hash.slice(1);
          history.replaceState(null, "", "/view");
          await api("/shared/redeem", { method: "POST", body: JSON.stringify({ token }) });
        }
        setInfo(await api("/shared/me"));
      } catch (e) { setError(errorText(e, "Посилання недоступне.")); }
    })();
  }, []);
  return (
    <div className="public">
      <header className="public-bar">
        <span className="brand"><Brand sub="Dashboard за посиланням" /></span>
        <ThemeToggle compact />
      </header>
      <main className="content">
        {error ? <Alert tone="danger">Посилання недійсне або відкликане. {error}</Alert>
          : info ? <Feed shared workflowId={String(info.workflow_id)} title={info.name || "Спільний dashboard"} badge={<Badge tone="secondary">Доступ за посиланням</Badge>} />
          : <p className="loading" role="status">Перевірка доступу…</p>}
        <p className="note">Доступ обмежений налаштуваннями адміністратора та строком дії посилання.</p>
      </main>
    </div>
  );
}
