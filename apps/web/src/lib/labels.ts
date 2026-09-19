export type Tone = "neutral" | "secondary" | "success" | "warning" | "info" | "danger";

export const TOPICS: Record<string, string> = {
  mobile: "Мобільний зв’язок",
  internet: "Інтернет",
  network: "Мережа й покриття",
  billing: "Тарифи та списання",
  support: "Підтримка",
  other: "Інше",
};

export const ROLES: Record<string, string> = { admin: "Адміністратор", analyst: "Аналітик", viewer: "Перегляд" };

export const ITEM_STATES: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Очікує обробки", tone: "info" },
  accepted: { label: "У стрічці", tone: "success" },
  review: { label: "На перевірці", tone: "warning" },
  rejected: { label: "Відсіяне", tone: "secondary" },
  deleted: { label: "Видалено у джерелі", tone: "danger" },
};

// Стани, які пишуть API та collector; невідоме значення показуємо як є.
const RUNTIME: Record<string, { label: string; tone: Tone }> = {
  online: { label: "Підключено", tone: "success" },
  watching: { label: "Збирається", tone: "success" },
  pending: { label: "Очікує", tone: "neutral" },
  disabled: { label: "Вимкнено", tone: "secondary" },
  deleted: { label: "Видалено", tone: "secondary" },
  flood_wait: { label: "FloodWait", tone: "warning" },
  setup_required: { label: "Очікує авторизації", tone: "warning" },
  api_credentials_required: { label: "Потрібен API-доступ", tone: "warning" },
  error: { label: "Помилка", tone: "danger" },
};

export const runtimeStatus = (status: string) => RUNTIME[status] ?? { label: status, tone: "neutral" as Tone };
