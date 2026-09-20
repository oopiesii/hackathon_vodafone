import { useCallback, useMemo, useState } from "react";

const KEY = "ufv.dashboard.layout.v1";

/** Керування одним віджетом: згортання та переміщення. Передається у <Card widget={...}>. */
export type WidgetHandle = {
  name: string;
  collapsed: boolean;
  editing: boolean;
  position: number;
  total: number;
  onToggle: () => void;
  onMove: (direction: -1 | 1) => void;
};

type Stored = { order: string[]; collapsed: string[] };

const strings = (value: unknown) => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

// Сховище браузера може бути вимкнене, очищене або кинути виняток у приватному вікні.
// Вигляд за замовчуванням мусить працювати й тоді, тому читання й запис завжди в try/catch.
function read(): Stored {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Stored>;
    return { order: strings(parsed.order), collapsed: strings(parsed.collapsed) };
  } catch { return { order: [], collapsed: [] }; }
}

function write(state: Stored) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* сховище недоступне: розкладка лишається лише на цей сеанс */ }
}

/** Збережений порядок не вирішує, які віджети існують: перелік завжди приходить із коду.
 *  Невідомі id відкидаються, нові з'являються на своєму типовому місці, а не в кінці. */
export function reconcile(stored: string[], defaults: string[]) {
  const known = stored.filter((id, index) => defaults.includes(id) && stored.indexOf(id) === index);
  const result = [...known];
  defaults.forEach((id, index) => { if (!known.includes(id)) result.splice(Math.min(index, result.length), 0, id); });
  return result;
}

export function useDashboardLayout(defaults: string[]) {
  const [state, setState] = useState(read);
  const [editing, setEditing] = useState(false);
  const key = defaults.join(",");
  const order = useMemo(() => reconcile(state.order, key ? key.split(",") : []), [state.order, key]);
  const collapsed = useMemo(() => state.collapsed.filter(id => order.includes(id)), [state.collapsed, order]);

  const save = useCallback((next: Stored) => { setState(next); write(next); }, []);
  const reset = useCallback(() => save({ order: [], collapsed: [] }), [save]);

  const handle = (id: string, name: string): WidgetHandle => ({
    name,
    collapsed: collapsed.includes(id),
    editing,
    position: order.indexOf(id) + 1,
    total: order.length,
    onToggle: () => save({ order, collapsed: collapsed.includes(id) ? collapsed.filter(x => x !== id) : [...collapsed, id] }),
    onMove: direction => {
      const index = order.indexOf(id), target = index + direction;
      if (index < 0 || target < 0 || target >= order.length) return;
      const next = [...order];
      next.splice(target, 0, next.splice(index, 1)[0]!);
      save({ order: next, collapsed });
    },
  });

  return { order, collapsed, editing, setEditing, reset, handle, customised: order.join(",") !== key || collapsed.length > 0 };
}
