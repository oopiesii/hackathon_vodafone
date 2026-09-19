// Лише відомі коди. Новий код не означає успішну дію або справний сервіс.
export const serviceNames: Record<string, string> = {
  "collector-telegram": "Збирач Telegram",
  "collector-rss": "Збирач RSS",
  processor: "Обробник матеріалів",
};

const serviceDetails: Record<string, Record<string, string>> = {
  "collector-telegram": { enabled: "Модуль увімкнено", disabled: "Модуль вимкнено" },
  "collector-rss": {
    "RSS/Atom; feed excerpts; polling with backoff": "Анонси RSS/Atom; опитування з паузами після помилок",
  },
  processor: { "rules-v2; database catch-up active": "Правила версії 2; обробка накопичених матеріалів" },
};

export const auditActions: Record<string, string> = {
  module_enabled: "Модуль увімкнено",
  module_disabled: "Модуль вимкнено",
  created: "Створено",
  updated: "Оновлено",
  deleted: "Видалено",
  enabled: "Увімкнено",
  disabled: "Вимкнено",
  revoked: "Доступ відкликано",
  reprocess_requested: "Запитано повторну обробку",
  refresh_requested: "Запитано оновлення",
  setup_prepared: "Місця для акаунтів підготовлено",
  credentials_rotated: "Облікові дані замінено",
  api_credentials_completed: "Дані API додано",
  session_registered: "Сесію зареєстровано",
  session_recovered_needs_api: "Сесію відновлено; потрібні дані API",
  review_accepted: "Матеріал прийнято вручну",
  review_review: "Матеріал залишено на перевірці",
  review_rejected: "Матеріал відхилено вручну",
  settings_updated: "Налаштування оновлено",
  source_added: "Джерело додано",
  sources_imported: "Джерела імпортовано",
  source_import_created: "Джерело створено під час імпорту",
  source_import_enabled: "Джерело ввімкнено під час імпорту",
  join_requested: "Запитано приєднання",
  policy_updated: "Політику спостереження оновлено",
  pause: "Завдання призупинено",
  resume: "Завдання повернуто в чергу",
  cancel: "Завдання скасовано",
  retry: "Запитано повторну спробу",
  auto: "Обрано автоматичне спостереження",
  pinned: "Спостереження закріплено",
  paused: "Спостереження призупинено",
  llm_allowed: "AI-доступ дозволено",
  llm_revoked: "AI-доступ відкликано",
  action_none: "Статус реагування знято",
  action_investigating: "Статус реагування: перевіряємо",
  action_responding: "Статус реагування: готуємо відповідь",
  action_resolved: "Статус реагування: закрито",
};

export const auditObjects: Record<string, string> = {
  telegram: "Модуль Telegram",
  rss: "RSS",
  workflow: "Робочий потік",
  account: "Акаунт",
  channel: "Канал",
  share: "Посилання доступу",
  document: "Матеріал",
  refresh: "Запит оновлення",
  telegram_job: "Завдання Telegram",
  telegram_watch: "Спостереження Telegram",
  source: "Джерело",
};

export function diagnosticLabel(labels: Record<string, string>, value: string): string | undefined {
  return Object.hasOwn(labels, value) ? labels[value] : undefined;
}

export function serviceDetailLabel(name: string, detail: string): string | undefined {
  return Object.hasOwn(serviceDetails, name) ? diagnosticLabel(serviceDetails[name]!, detail) : undefined;
}
