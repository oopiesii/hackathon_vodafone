export class ApiError extends Error {
  constructor(public status: number, public code: string) {
    super(`${status} ${code}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

// Запис із JSON-тілом; порожній об'єкт зберігає формат запитів попередньої консолі.
export const send = <T = unknown>(path: string, method: "POST" | "PUT" | "DELETE", body: unknown = {}) =>
  api<T>(path, { method, body: JSON.stringify(body) });

const ERRORS: Record<string, string> = {
  unauthorized: "Сеанс завершено. Увійдіть знову.",
  forbidden: "Недостатньо прав для цієї дії.",
  forbidden_origin: "Запит відхилено: інше походження сторінки.",
  not_found: "Запис не знайдено.",
  duplicate_or_linked_record: "Такий запис уже існує або пов’язаний з іншими даними.",
  invalid_link: "Посилання недійсне.",
  invalid_or_expired_link: "Посилання недійсне, відкликане або його строк минув.",
  share_scope_changed: "Доступ за посиланням змінився. Відкрийте потрібне посилання знову.",
  internal: "Внутрішня помилка сервера.",
};

// API повертає або код, або готове пояснення українською (перевірка полів).
export function errorText(error: unknown, fallback = "Не вдалося виконати запит.") {
  if (error instanceof ApiError) return ERRORS[error.code] ?? (/[а-яіїєґ]/i.test(error.code) ? error.code : `${fallback} (${error.status})`);
  return error instanceof Error ? error.message : fallback;
}

export type Me = {
  user: { id: string; email: string; name: string; role: string };
  permissions: Record<string, string[]>;
};

export type Mention = {
  id: string;
  url: string | null;
  published_at: string | null;
  category: string | null;
  severity: "h" | "m" | "l" | null;
  summary: string;
  quote: string | null;
  source_kind: string;
  source_title: string | null;
};

export const can = (me: Me | undefined, resource: string, action: string) =>
  me?.permissions[resource]?.includes(action) ?? false;
