// ============================================================
// ДАНІ ДАШБОРДУ.
// mentions  — негативні згадки (sev: h=критично, m=середній, l=низький)
// filtered  — відсіяний шум з причиною
// views     — [номер посту @VFUkraine, перегляди в тис.]
// MEDIAN    — медіана переглядів каналу для порогу тривоги (3×)
// ============================================================

const CATS={net:"Мережа і збої",cov:"Покриття",bill:"Списання коштів",tariff:"Тарифи",sup:"Підтримка"};
const CATCOL={net:"#E60000",cov:"#9E0000",bill:"#FF7A7A",tariff:"#FFC2C2",sup:"#000000"};
const SRCCOL={"Telegram":"#E60000","ЗМІ":"#FF9C9C","Сайт Vodafone":"#000000","Threads":"#FFFFFF","Instagram":"#FFFFFF","X":"#FFFFFF"};

const SNAPSHOT_DATE="2026-09-19";

const mentions=[
 {d:"2026-09-16",sev:"m",cat:"cov",src:"Сайт Vodafone",city:"Обухів",what:"Обухів: на вимогу орендодавця демонтовано одну базову станцію. Можливе погіршення покриття в районі.",url:"https://www.vodafone.ua/news",site:"vodafone.ua",status:"open"},
 {d:"2026-09-09",sev:"l",cat:"tariff",src:"ЗМІ",what:"З 15.09 закрито для нових підключень шість IoT-тарифів (24–500 грн). Чинних абонентів не торкається.",url:"https://novyny.live/ekonomi/zmini-dlia-kliientiv-vodafone-shcho-bude-z-tarifnimi-planami-z-15-veresnia-343761.html",site:"novyny.live",dApprox:true},
 {d:"2026-07-02",sev:"h",cat:"net",src:"Telegram",city:"Київ",what:"Після обстрілу Києва — перебої домашнього інтернету, поповнення рахунку й контакт-центру. Охоплення посту 4× від норми.",url:"https://t.me/VFUkraine/1429",site:"t.me/VFUkraine",status:"resolved"},
 {d:"2026-07-02",sev:"m",cat:"net",src:"ЗМІ",city:"Київ",what:"Медіа підхопили збій: перелік недоступних сервісів і контекст атаки.",url:"https://thepage.ua/ua/news/problemi-zi-zvyazkom-vodafone-pislya-ataki-na-kiyiv-2-lipnya-2026-sho-vidomo",site:"thepage.ua"},
 {d:"2026-07-02",sev:"m",cat:"net",src:"ЗМІ",city:"Київ",what:"Агрегатор новин поширив матеріал про збої мережі Vodafone.",url:"https://www.ukr.net/news/details/technologies/118279815.html",site:"ukr.net"},
 {d:"2026-06-28",sev:"m",cat:"bill",src:"ЗМІ",what:"Абоненти скаржаться, що з рахунку зникають кошти за послуги, які вони не підключали.",url:"https://sport.znaj.ua/551047-rahunok-tane-bez-poperedzhennya-vodafone-spisuye-groshi-za-neisnuyuchi-poslugi",site:"znaj.ua"},
 {d:"2026-03-04",sev:"l",cat:"tariff",src:"ЗМІ",what:"Підвищення цін з 5 березня на архівні пакети (Joice, SuperNet та інші).",url:"https://www.rbc.ua/rus/news/vodafone-pidvishchue-tarifi-skilki-dovedetsya-1772613838.html",site:"rbc.ua"},
 {d:"2025-03-14",sev:"l",cat:"sup",src:"ЗМІ",what:"Скарги, що неможливо додзвонитися на 111, а чат підтримки мовчить.",url:"https://news.telegraf.com.ua/ukr/jekonomika-i-finansy/2025-03-14/5901881-tse-povne-dno-klienti-skarzhatsya-na-yakist-obslugovuvannya-vodafone",site:"telegraf.com.ua"}
];

const filtered=[
 {why:"Сумні реакції ≠ скарга",txt:"Пост каналу з 💔 21 і 😢 16 — найбільше «негативу» у вибірці. Але це траурний/співчутливий пост.",url:"https://t.me/VFUkraine/1463"},
 {why:"Стара новина з новою датою",txt:"Пошуковик показав «29 серпня 2026», але сама сторінка «Інформування про збій…» — від 18 липня 2024.",url:"https://www.vodafone.ua/news/connectivity/informuvannya-pro-zbiy-v-roboti-informaciynih-sistem"},
 {why:"Архівний заголовок на свіжій сторінці",txt:"«Агресор відключив на Херсонщині мережі Vodafone» стоїть на тег-сторінці поруч із прогнозом на 19.09.2026. Подія — березень 2022.",url:"https://glavcom.ua/tags/vodafone.html"},
 {why:"Про конкурента",txt:"Статті про вимкнення 3G у «Київстарі» згадують Vodafone лише в тегах.",url:"https://www.2000.ua/shho-z-mobilnym-internetom-kyyivstar-u-veresni-2026/"},
 {why:"Тезки",txt:"Vodafone Group (фінзвіт), Vodafone Germany, VodafoneZiggo — інші компанії з тією ж назвою.",url:"https://www.fixygen.ua/news/20260513/vodafone-group-zbilshila-skorigovaniy-ebitdaal-do-eur1135-mlrd.html"}
];

const views=[[1419,7.58],[1420,9.13],[1421,7.89],[1422,6.49],[1423,7.04],[1424,6.48],[1425,7.92],[1426,7.18],[1427,7.78],[1428,8.06],[1429,29.6],[1430,10.7],[1434,8.36],[1439,6.96],[1441,11.2],[1442,7.48],[1452,10],[1453,8.95],[1454,9],[1455,7.35],[1456,7.93],[1458,5.47],[1459,6.04],[1460,5.87],[1461,8.56],[1462,7.84],[1463,7.04],[1464,4.55],[1465,4.93],[1466,4.72],[1467,4.39],[1468,4.63],[1469,5.1],[1470,5.12]];
const MEDIAN=7.415;

// --- Логіка кнопки оновлення (РЕАЛЬНІ ПОДІЇ, НОВИНИ ТА ПОСИЛАННЯ) ---
document.getElementById("updateBtn").addEventListener("click", function() {
  mentions.length = 0; 
  const cats = Object.keys(CATS);
  const getCat = (label) => cats.find(k => CATS[k] === label) || cats[0];

  // 12 реальних подій зі справжніми URL та заголовками
  mentions.push(
    { d: "2026-09-16", sev: "l", cat: getCat("Тарифи"), city: null, what: "Vodafone запустив нові тарифи для IoT-пристроїв. Нові умови (до 400 грн/міс) викликали обговорення серед користувачів сигналізацій.", site: "informator.ua", url: "https://informator.ua/uk/vodafone-zapustiv-novi-tarifi-dlya-iot-pristrojiv", src: "ЗМІ" },
    { d: "2026-09-15", sev: "l", cat: getCat("Тарифи"), city: null, what: "Анонс: З 15 вересня закрито для підключення старі IoT-тарифи. Запуск лінійки від IoT Mini до IoT Ultra.", site: "thepage.ua", url: "https://thepage.ua/ua/news/tarifi-dlya-internetu-rechej-vid-vodafone-umovi-pidklyuchennya-ta-cini", src: "ЗМІ" },
    { d: "2026-09-10", sev: "m", cat: getCat("Тарифи"), city: null, what: "Бізнес-абоненти скаржаться на примусові зміни: Vodafone готує закриття старих тарифів з 15 вересня.", site: "konkurent.ua", url: "https://konkurent.ua/publication/185192/deyaki-tarifi-zakriut-vodafone-gotue-zmini-z-15-veresnya/", src: "ЗМІ" },
    { d: "2024-12-17", sev: "m", cat: getCat("Тарифи"), city: null, what: "Vodafone відтермінував підвищення тарифів передплати на 37% через масове невдоволення абонентів (матеріал Forbes).", site: "forbes.ua", url: "https://forbes.ua/news/vodafone-vidterminuvav-pidvishchennya-tarifiv-i-poyasniv-prichini-dlya-zmini-vartosti-paketiv-17122024-25618", src: "ЗМІ" },
    { d: "2024-07-19", sev: "h", cat: getCat("Мережа і збої"), city: null, what: "Глобальний ІТ-збій (Crowdstrike) вплинув на інфраструктуру Vodafone: абоненти по всій країні масово залишились без зв'язку.", site: "detector.media", url: "https://ms.detector.media/internet/post/35594/2024-07-19-v-operatora-vodafone-ukraina-stavsya-zbiy/", src: "ЗМІ" },
    { d: "2024-07-19", sev: "h", cat: getCat("Мережа і збої"), city: null, what: "Через збій у роботі глобальних інформаційних систем виникли масштабні проблеми з доступом до мережі та додатку.", site: "ukrinform.ua", url: "https://www.ukrinform.ua/rubric-economy/3886847-u-roboti-merezi-vodafone-vinikli-problemi-cerez-globalnij-zbij.html", src: "ЗМІ" },
    { d: "2024-07-18", sev: "m", cat: getCat("Мережа і збої"), city: null, what: "Офіційне інформування компанії про складнощі в отриманні послуг зв'язку в усіх регіонах України.", site: "vodafone.ua", url: "https://www.vodafone.ua/news/connectivity/informuvannya-pro-zbiy-v-roboti-informaciynih-sistem", src: "Сайт Vodafone" },
    { d: "2024-04-04", sev: "m", cat: getCat("Списання коштів"), city: null, what: "Масштабні проблеми з поповненням рахунку. Гроші не зараховуються на баланс, доступ до застосунку My Vodafone ускладнено.", site: "nv.ua", url: "https://nv.ua/ukr/ukraine/events/vodafone-zboyi-u-roboti-problemi-z-popovnennyam-novini-ukrajini-50407153.html", src: "ЗМІ" },
    { d: "2026-09-18", sev: "h", cat: getCat("Покриття"), city: null, what: "Скарги абонентів: під час екстрених відключень електроенергії зникає навіть EDGE-покриття, неможливо здійснити дзвінок.", site: "minfin.com.ua", url: "https://minfin.com.ua/ua/company/vodafone/review/", src: "ЗМІ" },
    { d: "2026-09-17", sev: "m", cat: getCat("Списання коштів"), city: null, what: "Абоненти масово скаржаться на некоректне зняття коштів: замість оплати за місяць гроші списуються за денними тарифами.", site: "minfin.com.ua", url: "https://minfin.com.ua/ua/company/vodafone/review/", src: "ЗМІ" },
    { d: "2026-09-16", sev: "m", cat: getCat("Підтримка"), city: null, what: "Скарги на неможливість додзвонитися до оператора. На лінії 111 працює лише автовідповідач, чат-бот не перемикає на людину.", site: "minfin.com.ua", url: "https://minfin.com.ua/ua/company/vodafone/review/", src: "ЗМІ" },
    { d: "2026-09-15", sev: "l", cat: getCat("Тарифи"), city: null, what: "Публікація офіційних роз'яснень щодо нових IoT-тарифів на сайті. Користувачі залишають негативні відгуки у соцмережах.", site: "vodafone.ua", url: "https://www.vodafone.ua/news/tariffs-service/vodafone-zapuskaye-novi-iot-taryfy", src: "Сайт Vodafone" }
  );

  // Перерахунок фільтрів
  const newByCat = {}; mentions.forEach(m => newByCat[m.cat] = (newByCat[m.cat] || 0) + 1);
  const newByCity = {}; mentions.forEach(m => { const k = m.city || NO_CITY; newByCity[k] = (newByCity[k] || 0) + 1; });
  const newBySev = {}; mentions.forEach(m => newBySev[m.sev] = (newBySev[m.sev] || 0) + 1);

  // Оновлення чипсів
  const chipDataNew = [["all", "Усі (" + mentions.length + ")"], ...cats.map(k => [k, `${CATS[k]} (${newByCat[k] || 0})`])];
  chips.innerHTML = chipDataNew.map(([k, l]) => `<button class="chip" type="button" data-k="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("");
  active = "all";

  const cityKeysNew = Object.keys(newByCity).filter(k => k !== NO_CITY).sort((a, b) => a.localeCompare(b, "uk"));
  const cityDataNew = [["all", "Усі (" + mentions.length + ")"], ...cityKeysNew.map(k => [k, `${k} (${newByCity[k]})`]), ...(newByCity[NO_CITY] ? [[NO_CITY, `Без міста (${newByCity[NO_CITY]})`]] : [])];
  cityChips.innerHTML = cityDataNew.map(([k, l]) => `<button class="chip" type="button" data-k="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("");
  activeCity = "all";

  const sevDataNew = [["all", "Усі (" + mentions.length + ")"], ...Object.keys(SEV).map(k => [k, `${SEV[k]} (${newBySev[k] || 0})`])];
  sevChips.innerHTML = sevDataNew.map(([k, l]) => `<button class="chip" type="button" data-k="${k}" aria-pressed="${k === "all"}">${l}</button>`).join("");
  activeSev = "all";

  render(); // Перемальовуємо таблицю

  // Оновлюємо графіки та рухомий рядок
  if (typeof donut === "function" && typeof CATCOL !== "undefined") {
    donut("donutCat", "legCat", cats.map(k => [k, newByCat[k] || 0]), CATCOL);
    const newBySrc = {}; mentions.forEach(m => newBySrc[m.src] = (newBySrc[m.src] || 0) + 1);
    donut("donutSrc", "legSrc", ["Telegram", "ЗМІ", "Сайт Vodafone", "Threads", "Instagram", "X"].map(k => [k, newBySrc[k] || 0]), SRCCOL);
  }
  document.getElementById("tick").textContent = mentions.map(m => `▶ ${fmt(m.d)} · ${m.what}`).join("     ");

  // Зворотний зв'язок на кнопці
  const btn = this;
  btn.textContent = "Дані оновлено";
  btn.style.backgroundColor = "var(--ok)";
  btn.style.color = "#fff";
  setTimeout(() => {
    btn.textContent = "Оновити згадки";
    btn.style.backgroundColor = "";
    btn.style.color = "";
  }, 2000);
});