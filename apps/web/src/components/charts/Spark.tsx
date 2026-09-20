/** Міні-ряд плитки; повні значення доступні в таблиці показників dashboard. */
export function Spark({ values }: { values: number[] }) {
  // Без ряду плитка лишається з числом і поясненням; окремий напис «Немає ряду» — внутрішній жаргон.
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const points = values.map((v, i) => `${4 + i * 112 / (values.length - 1)},${28 - Math.max(0, v) * 24 / max}`).join(" ");
  return <svg className="spark" viewBox="0 0 120 32" aria-hidden="true"><polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}
