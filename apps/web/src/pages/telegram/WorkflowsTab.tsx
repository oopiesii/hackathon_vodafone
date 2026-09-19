import type { FormEvent } from "react";
import { Card, Field } from "../../components/ui";
import { send } from "../../lib/api";
import { checked, field, type TabProps, type Workflow } from "./types";

function WorkflowForm({ workflow, busy, run }: { workflow?: Workflow | undefined } & Pick<TabProps, "busy" | "run">) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      name: field(form, "name"), poll_seconds: Number(field(form, "poll_seconds")), history_days: Number(field(form, "history_days")),
      enabled: checked(form, "enabled"), comments_enabled: checked(form, "comments_enabled"), filter_spam: checked(form, "filter_spam"),
    };
    const saved = await run(async () => { await send("/admin/workflows" + (workflow ? "/" + workflow.id : ""), workflow ? "PUT" : "POST", body); });
    if (saved && !workflow) form.reset();
  }
  return (
    <form className="form-grid" onSubmit={submit}>
      <Field label="Назва" className="full"><input name="name" defaultValue={workflow?.name ?? ""} required maxLength={120} /></Field>
      <Field label="Перевірка пропущених повідомлень, с"><input type="number" name="poll_seconds" min={15} max={3600} defaultValue={workflow?.poll_seconds ?? 30} required /></Field>
      <Field label="Історія для нових каналів, днів"><input type="number" name="history_days" min={1} max={90} defaultValue={workflow?.history_days ?? 7} required /></Field>
      <div className="full row">
        <label className="check"><input type="checkbox" name="enabled" defaultChecked={workflow?.enabled ?? false} />Workflow увімкнено</label>
        <label className="check"><input type="checkbox" name="comments_enabled" defaultChecked={workflow?.comments_enabled ?? true} />Збирати коментарі</label>
        <label className="check"><input type="checkbox" name="filter_spam" defaultChecked={workflow?.filter_spam ?? true} />Відсівати явний спам</label>
      </div>
      <p className="note full">
        Послідовність: Telegram → нормалізація → тематичний фільтр → перевірка → dashboard.
        Зміна періоду історії впливає на нові канали; збережені позиції не скидаються.
      </p>
      <div className="form-actions full"><button type="submit" className="btn" disabled={busy}>{workflow ? "Зберегти workflow" : "Створити workflow"}</button></div>
    </form>
  );
}

export function WorkflowsTab({ state, workflowId, busy, run }: TabProps) {
  const workflow = state.workflows.find((w) => w.id === workflowId);
  return (
    <div className="stack">
      <Card title={workflow ? "Параметри поточного workflow" : "Новий workflow"}>
        <WorkflowForm key={`${workflow?.id}:${JSON.stringify(workflow)}`} workflow={workflow} busy={busy} run={run} />
      </Card>
      {workflow && (
        <>
          <Card title="Повторна обробка" description="Застосовує поточні правила фільтра до вже зібраних матеріалів. Ручні рішення зберігаються."
            actions={<button type="button" className="btn btn-outline" disabled={busy}
              onClick={() => run(async () => {
                const r = await send<{ count: number }>(`/admin/workflows/${workflowId}/reprocess`, "POST");
                return `Поставлено на повторну обробку: ${r.count}. Ручні рішення збережено.`;
              })}>Повторно застосувати фільтр</button>} />
          <Card><details><summary>Створити ще один workflow</summary><div className="details-body"><WorkflowForm busy={busy} run={run} /></div></details></Card>
        </>
      )}
    </div>
  );
}
