export type Tone = "neutral" | "secondary" | "success" | "warning" | "info" | "danger";

export const TOPICS: Record<string, string> = {
  mobile: "Мобільний зв’язок",
  internet: "Інтернет",
  network: "Мережа й покриття",
  billing: "Тарифи та списання",
  support: "Підтримка",
  other: "Інше",
};

// Статус дій команди над матеріалом. Це не висновок моделі, а запис людини; типове значення — прочерк.
export const ACTION_STATUS: Record<string, { label: string; tone: Tone }> = {
  none: { label: "Дій ще немає", tone: "secondary" },
  investigating: { label: "З’ясовуємо", tone: "info" },
  responding: { label: "Реагуємо", tone: "warning" },
  resolved: { label: "Вирішено", tone: "success" },
};
export const ACTION_VALUES = ["none", "investigating", "responding", "resolved"] as const;

export const SOURCE_TYPES: Record<string, string> = { channel: "Канал", supergroup: "Супергрупа", forum: "Форум" };

export const ROLES: Record<string, string> = { admin: "Адміністратор", analyst: "Аналітик", viewer: "Перегляд" };

export const ITEM_STATES: Record<string, { label: string; tone: Tone }> = {
  pending: { label: "Очікує обробки", tone: "info" },
  accepted: { label: "Прийнято попередньо", tone: "success" },
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
