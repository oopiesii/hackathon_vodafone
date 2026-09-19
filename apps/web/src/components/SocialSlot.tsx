import { Badge, Card } from "./ui";
import socialSchema from "../../../../packages/contracts/events/social.post.observed.v1.schema.json?raw";
export function SocialSlot({ platform }: { platform: "Threads" | "X" }) {
  return <Card title={platform} actions={<Badge tone="secondary">Не підключено</Badge>}><div className="stack"><p>Місце для майбутньої інтеграції. Публікації цього сервісу зараз не збираються.</p><ol className="social-lifecycle"><li>Пошук згадок кожні 5 хвилин</li><li>Стеження за знайденим постом і відповідями</li><li>Рідші перевірки до згасання обговорення</li></ol><p className="hint">Запланована модель стеження, як у Telegram. Запуск потребує офіційного доступу й підстави використання матеріалів; частота залежатиме від лімітів API.</p><details><summary>Контракт майбутньої інтеграції</summary><pre className="slot-contract">{socialSchema}</pre></details></div></Card>;
}
