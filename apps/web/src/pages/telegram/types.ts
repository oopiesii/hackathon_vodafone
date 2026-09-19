export type Account = {
  id: number; label: string; api_id: number | null; enabled: boolean; status: string; credentials_ready: boolean;
  has_session: boolean; last_error: string | null; cooldown_until: number | null; checked_at: string | null;
};
export type Workflow = {
  id: number; name: string; enabled: boolean; comments_enabled: boolean; filter_spam: boolean; poll_seconds: number; history_days: number;
};
export type Channel = {
  id: number; workflow_id: number; account_id: number; username: string; enabled: boolean; permission_note: string;
  source_type: string | null; last_success_at: string | null; post_cursor: number | string; status: string; last_error: string | null; last_polled_at: string | null;
};
export type Membership = { account_id: number; username: string; title: string };
export type Thread = {
  id: number; channel_id: number; post_id: number | string; comment_cursor: number | string;
  last_polled_at: string | null; status: string; last_error: string | null;
};
export type Share = {
  id: number; workflow_id: number; name: string; scope: "summary" | "posts" | "full";
  channel_ids: string; topics: string; expires_at: number; revoked: boolean;
};
export type AdminState = {
  telegram_enabled: boolean; accounts: Account[]; workflows: Workflow[]; channels: Channel[]; memberships: Membership[];
  threads: Thread[]; shares: Share[]; audit: { occurred_at: string; action: string; object_type: string; object_id: string | null }[];
  services: { name: string; heartbeat_at: string; detail: string }[];
};

// run виконує дію, перечитує стан і показує повідомлення (типове — «Збережено.») або помилку.
export type TabProps = {
  state: AdminState; workflowId: number; busy: boolean;
  run: (action: () => Promise<string | void>) => Promise<boolean>;
};

export const field = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
export const checked = (form: HTMLFormElement, name: string) => (form.elements.namedItem(name) as HTMLInputElement).checked;
