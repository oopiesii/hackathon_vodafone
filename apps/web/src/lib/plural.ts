/** Українські числівники: десятки 11–14 мають форму множини. */
export function plural(value: number, one: string, few: string, many: string) {
  const n = Math.abs(value);
  if (!Number.isInteger(n)) return few;
  return n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
}
export const quantity = (value: number, one: string, few: string, many: string) => `${value.toLocaleString("uk-UA", { maximumFractionDigits: 1 })} ${plural(value, one, few, many)}`;
export const brandName = (brand: string) => ({ vodafone: "Vodafone", kyivstar: "Київстар", lifecell: "lifecell", telecom: "Телеком" }[brand] ?? "Бренд не визначено");
