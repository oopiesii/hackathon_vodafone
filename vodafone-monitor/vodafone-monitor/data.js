// ============================================================
// ДАНІ ДАШБОРДУ. Редагуйте тут, index.html чіпати не треба.
// mentions  — негативні згадки (sev: h=критично, m=середній, l=низький)
// filtered  — відсіяний шум з причиною
// views     — [номер посту @VFUkraine, перегляди в тис.]
// MEDIAN    — медіана переглядів каналу для порогу тривоги (3×)
// Знімок: 19.09.2026
// ============================================================

const CATS={net:"Мережа і збої",cov:"Покриття",bill:"Списання коштів",tariff:"Тарифи",sup:"Підтримка"};
const CATCOL={net:"#E60000",cov:"#9E0000",bill:"#FF7A7A",tariff:"#FFC2C2",sup:"#000000"};
const SRCCOL={"Telegram":"#E60000","ЗМІ":"#FF9C9C","Сайт Vodafone":"#000000","Threads":"#FFFFFF","Instagram":"#FFFFFF","X":"#FFFFFF"};

// Дата, на яку зібрано весь знімок. Використовується і в текстах, і в AI-аналітику
// для розрахунку "останньої доби" — це не поточна дата відвідувача.
const SNAPSHOT_DATE="2026-09-19";

const mentions=[
 // status: "open"/"resolved" — лише там, де це явно зафіксовано в тексті знімка (розділ "Найкритичніша ситуація" / "Що зараз").
 // Немає status → у знімку немає підтвердженого закриття; це невідоме, а не "вирішено за замовчуванням".
 {d:"2026-09-16",sev:"m",cat:"cov",src:"Сайт Vodafone",what:"Обухів: на вимогу орендодавця демонтовано одну базову станцію. Можливе погіршення покриття в районі.",url:"https://www.vodafone.ua/news",site:"vodafone.ua",status:"open"},
 {d:"2026-09-09",sev:"l",cat:"tariff",src:"ЗМІ",what:"З 15.09 закрито для нових підключень шість IoT-тарифів (24–500 грн). Чинних абонентів не торкається.",url:"https://novyny.live/ekonomi/zmini-dlia-kliientiv-vodafone-shcho-bude-z-tarifnimi-planami-z-15-veresnia-343761.html",site:"novyny.live",dApprox:true},
 {d:"2026-07-02",sev:"h",cat:"net",src:"Telegram",what:"Після обстрілу Києва — перебої домашнього інтернету, поповнення рахунку й контакт-центру. Охоплення посту 4× від норми.",url:"https://t.me/VFUkraine/1429",site:"t.me/VFUkraine",status:"resolved"},
 {d:"2026-07-02",sev:"m",cat:"net",src:"ЗМІ",what:"Медіа підхопили збій: перелік недоступних сервісів і контекст атаки.",url:"https://thepage.ua/ua/news/problemi-zi-zvyazkom-vodafone-pislya-ataki-na-kiyiv-2-lipnya-2026-sho-vidomo",site:"thepage.ua"},
 {d:"2026-07-02",sev:"m",cat:"net",src:"ЗМІ",what:"Агрегатор новин поширив матеріал про збої мережі Vodafone.",url:"https://www.ukr.net/news/details/technologies/118279815.html",site:"ukr.net"},
 {d:"2026-06-28",sev:"m",cat:"bill",src:"ЗМІ",what:"Абоненти скаржаться, що з рахунку зникають кошти за послуги, які вони не підключали.",url:"https://sport.znaj.ua/551047-rahunok-tane-bez-poperedzhennya-vodafone-spisuye-groshi-za-neisnuyuchi-poslugi",site:"znaj.ua"},
 {d:"2026-03-04",sev:"l",cat:"tariff",src:"ЗМІ",what:"Підвищення цін з 5 березня на архівні пакети (Joice, SuperNet та інші).",url:"https://www.rbc.ua/rus/news/vodafone-pidvishchue-tarifi-skilki-dovedetsya-1772613838.html",site:"rbc.ua"},
 {d:"2025-03-14",sev:"l",cat:"sup",src:"ЗМІ",what:"Скарги, що неможливо додзвонитися на 111, а чат підтримки мовчить. Старе (понад 6 міс.) — лише як фон.",url:"https://news.telegraf.com.ua/ukr/jekonomika-i-finansy/2025-03-14/5901881-tse-povne-dno-klienti-skarzhatsya-na-yakist-obslugovuvannya-vodafone",site:"telegraf.com.ua"}
];

const filtered=[
 {why:"Сумні реакції ≠ скарга",txt:"Пост каналу з 💔 21 і 😢 16 — найбільше «негативу» у вибірці. Але це траурний/співчутливий пост, а не претензія до оператора.",url:"https://t.me/VFUkraine/1463"},
 {why:"Стара новина з новою датою",txt:"Пошуковик показав «29 серпня 2026», але сама сторінка «Інформування про збій…» — від 18 липня 2024 (глобальний ІТ-збій).",url:"https://www.vodafone.ua/news/connectivity/informuvannya-pro-zbiy-v-roboti-informaciynih-sistem"},
 {why:"Архівний заголовок на свіжій сторінці",txt:"«Агресор відключив на Херсонщині мережі Vodafone» стоїть на тег-сторінці поруч із прогнозом погоди на 19.09.2026. Подія — березень 2022.",url:"https://glavcom.ua/tags/vodafone.html"},
 {why:"Про конкурента",txt:"Статті про вимкнення 3G у «Київстарі» згадують Vodafone лише в тегах.",url:"https://www.2000.ua/shho-z-mobilnym-internetom-kyyivstar-u-veresni-2026/"},
 {why:"Тезки",txt:"Vodafone Group (фінзвіт), Vodafone Germany, VodafoneZiggo — інші компанії з тією ж назвою.",url:"https://www.fixygen.ua/news/20260513/vodafone-group-zbilshila-skorigovaniy-ebitdaal-do-eur1135-mlrd.html"}
];

const views=[[1419,7.58],[1420,9.13],[1421,7.89],[1422,6.49],[1423,7.04],[1424,6.48],[1425,7.92],[1426,7.18],[1427,7.78],[1428,8.06],[1429,29.6],[1430,10.7],[1434,8.36],[1439,6.96],[1441,11.2],[1442,7.48],[1452,10],[1453,8.95],[1454,9],[1455,7.35],[1456,7.93],[1458,5.47],[1459,6.04],[1460,5.87],[1461,8.56],[1462,7.84],[1463,7.04],[1464,4.55],[1465,4.93],[1466,4.72],[1467,4.39],[1468,4.63],[1469,5.1],[1470,5.12]];
const MEDIAN=7.415;

