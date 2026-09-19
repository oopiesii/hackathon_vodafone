// Секунди epoch приходять з extract(epoch …), решта — ISO-рядки.
const toDate = (value: string | number) => new Date(typeof value === "number" ? value * 1000 : value);

export const formatDate = (value: string | number | null | undefined, empty = "Невідомо") =>
  value ? toDate(value).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : empty;

export const formatDateTime = (value: string | number | null | undefined, empty = "Невідомо") =>
  value ? toDate(value).toLocaleString("uk-UA", { timeZone: "Europe/Kyiv" }) : empty;

export const excerpt = (text: string, limit = 700) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
