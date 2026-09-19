export type Tone = "neutral" | "secondary" | "success" | "warning" | "info" | "danger";

export const TOPICS: Record<string, string> = {
  mobile: "Мобільний зв’язок",
  internet: "Інтернет",
  network: "Мережа й покриття",
  billing: "Тарифи та списання",
  support: "Підтримка",
  other: "Інше",
};

export const SOURCE_TYPES: Record<string, string> = { channel: "Канал", supergroup: "Супергрупа", forum: "Форум" };

export const ROLES: Record<string, string> = { admin: "Адміністратор", analyst: "Аналітик", viewer: "Перегляд" };

export const ITEM_STATES: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Очікує обробки", tone: "info" },
  accepted: { label: "У стрічці", tone: "success" },
  review: { label: "На перевірці", tone: "warning" },
  rejected: { label: "Відсіяне", tone: "secondary" },
  deleted: { label: "Видалено у джерелі", tone: "danger" },
};

// Стани, які пишуть API та collector; технічний код лишається у title значка.
const RUNTIME: Record<string, { label: string; tone: Tone }> = {
  online: { label: "Підключено", tone: "success" },
  connecting: { label: "Підключення", tone: "info" },
  unauthorized: { label: "Потрібна нова сесія", tone: "warning" },
  stopped: { label: "Зупинено", tone: "secondary" },
  watching: { label: "Збирається", tone: "success" },
  pending: { label: "Очікує", tone: "neutral" },
  resolve: { label: "Пошук обговорення", tone: "neutral" },
  disabled: { label: "Вимкнено", tone: "secondary" },
  deleted: { label: "Видалено", tone: "secondary" },
  flood_wait: { label: "FloodWait", tone: "warning" },
  setup_required: { label: "Очікує авторизації", tone: "warning" },
  api_credentials_required: { label: "Потрібен API-доступ", tone: "warning" },
  error: { label: "Помилка", tone: "danger" },
};

export const runtimeStatus = (status: string) => RUNTIME[status] ?? { label: "Стан невідомий", tone: "neutral" as Tone };
