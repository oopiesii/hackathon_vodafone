/** Синтетичні приклади лише для UI слота. Ніколи не пишуться в raw/core чи NATS. */
export type DemoTower = { id: string; label: string; status: "available" | "unavailable" | "unknown"; reason: string };
export const DEMO_REGIONS: { id: string; name: string; sites: DemoTower[] }[] = [
  { id: "kyiv", name: "Київщина", sites: [
    { id: "DEMO-KY-01", label: "Умовна зона А", status: "unavailable", reason: "Навчальний приклад: живлення відсутнє, резерв вичерпано." },
    { id: "DEMO-KY-02", label: "Умовна зона Б", status: "available", reason: "Навчальний приклад: майданчик повідомляє штатний стан." },
    { id: "DEMO-KY-03", label: "Умовна зона В", status: "unknown", reason: "Навчальний приклад: телеметрія не надходить; стан невідомий." },
  ] },
  { id: "lviv", name: "Львівщина", sites: [
    { id: "DEMO-LV-01", label: "Умовна зона А", status: "available", reason: "Навчальний приклад: працює від резервного живлення." },
    { id: "DEMO-LV-02", label: "Умовна зона Б", status: "available", reason: "Навчальний приклад: штатний стан." },
  ] },
  { id: "odesa", name: "Одещина", sites: [
    { id: "DEMO-OD-01", label: "Умовна зона А", status: "unknown", reason: "Навчальний приклад: застаріле спостереження не означає відмову." },
    { id: "DEMO-OD-02", label: "Умовна зона Б", status: "available", reason: "Навчальний приклад: штатний стан." },
  ] },
];
