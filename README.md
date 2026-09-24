# Forja Launcher

Кроссплатформенный (Windows / macOS / Linux) лаунчер **Minecraft: Java Edition** на Electron.
Готовы **фаза 1 — ядро** (установка любой версии из официальных источников Mojang, загрузка
нужной Java, запуск игры), **фаза 2 — профили, настройки и новый интерфейс**, **фаза 3 — загрузчики
модов, Modrinth, модпаки** и **фаза 5 — сборка установщиков, CI и автообновление**.

Репозиторий: <https://github.com/zhekanisher7-rgb/Forja-launcher> ·
Скачать: <https://github.com/zhekanisher7-rgb/Forja-launcher/releases>

> «Forja Launcher» — временное название. Переименовать можно в одном файле: `src/main/config.js`
> (плюс `productName`/`appId` в `scripts/builder-config.js` для сборки).

Лаунчер легальный: всё скачивается только с официальных серверов Mojang
(`piston-meta.mojang.com`, `libraries.minecraft.net`, `resources.download.minecraft.net`,
Mojang Java runtime manifest; Adoptium — только как запасной вариант для Java).
Логотипы Mojang/Minecraft не используются. Для игры нужна лицензия Minecraft: Java Edition.

## Что работает (фаза 1)

- Список версий из манифеста Mojang с кэшем (работает и без сети по кэшу): фильтры
  релизы / снапшоты / старые (beta/alpha), поиск.
- Установка версии:
  - описание версии (JSON) с проверкой SHA1, поддержка `inheritsFrom` (задел для модлоадеров);
  - клиентский jar, библиотеки с учётом `rules` (ОС, архитектура, версия ОС, features);
  - natives: старый формат (`natives` + `classifiers`, `${arch}`, `extract.exclude`)
    и новый (natives как обычные библиотеки `…:natives-linux`, с фильтром по архитектуре);
  - asset index + объекты; legacy-форматы: `virtual` (1.6.x) и `map_to_resources` (до 1.6);
  - конфиг логирования log4j (XML-логи игры разбираются в читаемые строки).
- Загрузчик: параллельно (8–16 потоков), проверка SHA1 и размера, повторы с backoff,
  докачка `.part` через HTTP Range, пропуск уже валидных файлов, отмена, прогресс.
- Java: нужная версия берётся из `javaVersion` в JSON версии (по умолчанию Java 8),
  скачивается официальный Mojang runtime для текущей платформы
  (`windows-x64/x86/arm64`, `mac-os`, `mac-os-arm64`, `linux`, `linux-i386`),
  проверяется SHA1, выставляются права на исполнение и символические ссылки (unix),
  проверка через `java -version`. Для платформ без Mojang runtime (например, Linux arm64) —
  Adoptium с проверкой SHA256.
- Запуск: classpath с правильным разделителем (`;` на Windows, `:` на unix),
  JVM- и игровые аргументы из нового формата `arguments` и старого `minecraftArguments`,
  подстановка всех плейсхолдеров (`${auth_player_name}`, `${version_name}`, `${game_directory}`,
  `${assets_root}`, `${game_assets}`, `${assets_index_name}`, `${auth_uuid}`, `${auth_access_token}`,
  `${user_type}`, `${version_type}`, `${natives_directory}`, `${launcher_name}`, `${launcher_version}`,
  `${classpath}`, `${classpath_separator}`, `${library_directory}`, `${resolution_width/height}`…),
  память `-Xms/-Xmx`, вывод stdout/stderr игры в журнал интерфейса.
- **Офлайн (тест)** — только режим разработки/тестирования: локальное имя игрока,
  UUID как в vanilla (UUID v3 от `OfflinePlayer:<имя>`). Никакой авторизации не выполняется,
  на online-mode серверы зайти нельзя. Модуль входа через Microsoft подключается в фазе 4
  (`src/main/auth/microsoft.js` — заглушка с описанием потока).

## Что добавлено в фазе 2

- **Профили (инстансы)**: создание, изменение, дублирование (с копированием папки), удаление
  (по желанию — вместе с папкой; последний профиль удалить нельзя). У профиля есть имя, значок
  (12 встроенных простых значков или буква + цвет), версия Minecraft, своя игровая папка
  `instances/<id>/`, своя память, JVM-аргументы (с кавычками), разрешение / полный экран,
  Java (как в настройках или свой путь, с проверкой), время последнего запуска.
  Хранятся в `profiles.json` (`schemaVersion`, атомарная запись tmp → fsync → rename, копия `.bak`,
  повреждённый файл сохраняется как `.corrupt-*` и восстанавливается из `.bak`).
  Старая `instances/default` и настройки фазы 1 автоматически переносятся в профиль «Default».
- **Natives на каждый запуск**: распаковка во временную папку `tmp/natives/<версия>-XXXX`,
  удаление после выхода игры; при старте лаунчера удаляются брошенные папки (процесс-владелец мёртв).
  Решает проблему блокировки файлов на Windows при двух запусках одной версии.
- **Настройки**: язык (ru/en, переключается сразу), память и Java по умолчанию, число
  одновременных загрузок (1–32), что делать при запуске игры (оставить / скрыть / закрыть лаунчер),
  показ снапшотов/старых версий по умолчанию, папка данных (путь + «Открыть»),
  «Проверить и восстановить» для профиля (SHA1 всех файлов версии, ресурсов и Java, перекачка испорченных).
- **Интерфейс**: боковая панель с профилями (значки, бейджи «запущено»/«установка», мини-прогресс),
  большая карточка выбранного профиля с кнопкой «Играть», прогресс со скоростью и оставшимся временем,
  вкладки «Профили / Настройки / Журнал» (журнал с фильтром по профилю), тёмная тема, анимации,
  клавиатура (стрелки по вкладкам, Ctrl+1/2/3, Ctrl+N — новый профиль, Esc, ловушка фокуса в окнах),
  всплывающие уведомления и понятные русские сообщения об ошибках (нет сети, мало места на диске —
  проверка свободного места до загрузки, нет прав, неверная Java и т. д.).
- **Несколько запущенных игр** (по одной на профиль), «Закрыть игру» для каждой; при падении
  (ненулевой код выхода) — окно с последними ~50 строками журнала, «Копировать» и
  «Открыть папку crash-reports».
- **Иконка приложения** (наковальня и пламя, своя графика): `src/assets/icon.svg`, `build/icon.png` (512),
  `build/icon-256.png`, `build/icon-512.png`, `build/icon-1024.png`, `build/icon.ico`, `build/icon.icns`
  (генерация: `npx electron scripts/render-icon.js`).

Проверено на Linux x64 (см. `docs/TEST-REPORT.md`): установлены и запущены 1.20.1, 1.8.9,
1.12.2, 1.16.5 (установка + отмена), 1.6.4, 1.5.2 и 26.3 — игра доходит до главного меню;
в фазе 2 два профиля (1.20.1 и 1.8.9) запущены из интерфейса одновременно с разными игровыми папками.

![Профили](docs/phase2-profiles.png)

## Что добавлено в фазе 3

- **Загрузчики модов в профиле**: в редакторе профиля — загрузчик (vanilla / Fabric / Quilt / Forge /
  NeoForge) и его версия; по умолчанию «последняя стабильная» (для Forge — recommended из
  `promotions_slim.json`), при первом запуске версия закрепляется в профиле.
  - **Fabric** — официальный meta `https://meta.fabricmc.net/v2/`, **Quilt** — `https://meta.quiltmc.org/v3/`
    (JSON профиля версии → `versions/<id>/<id>.json`).
  - **Forge** — официальный установщик с `https://maven.minecraftforge.net/`. Современные (1.13+):
    разбор `install_profile.json`, загрузка библиотек, распаковка встроенных `maven/`, запуск
    процессоров (только `client`) с подстановкой `{DATA}`, `[maven-координат]`, `{MINECRAFT_JAR}`,
    `{SIDE}` и т. д., проверка SHA1 выходных файлов (если выходы уже верны — процессор пропускается).
    Старые (<1.13): `versionInfo` из `install_profile.json` + universal jar.
  - **NeoForge** — `https://maven.neoforged.net/`, тем же кодом процессоров.
  - Общий механизм **`inheritsFrom`** (`core/loaders/inherit.js`): библиотеки (дочерние первыми,
    без дублей), аргументы (склейка), `mainClass`/`minecraftArguments` (дочерние важнее).
  - Реестр установленных загрузчиков — `loaders.json` (какие файлы относятся к установке).
  - Установщик Forge в `_comment_` просит поддержать проект — в редакторе показана подсказка со ссылкой.
- **Modrinth** (API v2, User-Agent `ForjaLauncher/<версия> (contact: …)`), вкладка **«Моды»**:
  - поиск модов / ресурспаков / шейдеров с фильтром по версии игры и загрузчику профиля,
    категории, сортировке, постранично; страница проекта (описание, значок, загрузки, версии);
  - установка с автоматической установкой **обязательных зависимостей** (рекурсивно; отсутствующие
    или несовместимые — сообщаются), проверка **SHA-1 и SHA-512**;
  - список установленного: включить/выключить (`.jar` ⇄ `.jar.disabled`), удалить,
    «Проверить обновления» (опознание файлов по хэшу через `/version_files`) и «Обновить все»;
  - ресурспаки → `resourcepacks/`, шейдеры → `shaderpacks/` (нужен шейдерный мод, например Iris);
  - **модпаки `.mrpack`**: из поиска Modrinth (с выбором версии) или из локального файла
    (кнопка «Импорт .mrpack») → новый профиль. Разбор `modrinth.index.json`, загрузка с проверкой
    хэшей, только разрешённые https-хосты, фильтр `env.client`, `overrides/` затем
    `client-overrides/`, защита от выхода за папку профиля, загрузчик из `dependencies`,
    откат при ошибке.
- **Место на диске** (Настройки): объём версий, библиотек, ресурсов, Java и профилей;
  «Найти неиспользуемое» → список → «Удалить неиспользуемое». Удаляется только то, на что не
  ссылается ни один профиль (с учётом цепочек `inheritsFrom`, файлов загрузчиков и Java по
  `javaVersion`); если какую-то версию прочитать не удалось — библиотеки/Java/ресурсы не трогаются;
  во время игры или установки очистка запрещена; перед удалением план пересчитывается.

![Моды](docs/phase3-installed-mods.png)

## Установка

Готовые файлы — на странице [Releases](https://github.com/zhekanisher7-rgb/Forja-launcher/releases)
(`<версия>` — например `0.3.0`). Сборки пока **не подписаны** — это нормально, но система
предупредит при первом запуске.

| ОС | Файл | Как установить |
|---|---|---|
| Windows 10/11 x64 | `Forja-Launcher-<версия>-win-x64-setup.exe` | Запустить установщик (язык — русский/английский, установка для текущего пользователя без прав администратора, ярлыки на рабочем столе и в «Пуске»). |
| Windows (без установки) | `Forja-Launcher-<версия>-win-x64.zip`, `…-win-arm64.zip` | Распаковать и запустить `Forja Launcher.exe`. Автообновления в portable-версии нет. |
| macOS Apple Silicon (M1…) | `Forja-Launcher-<версия>-mac-arm64.dmg` | Открыть dmg, перетащить в «Программы». |
| macOS Intel | `Forja-Launcher-<версия>-mac-x64.dmg` | То же. (Есть и `.zip`-варианты.) |
| Linux (любой) | `Forja-Launcher-<версия>-linux-x86_64.AppImage` | `chmod +x Forja-Launcher-*.AppImage && ./Forja-Launcher-*.AppImage` (нужен `libfuse2`; без него — `--appimage-extract-and-run`). Автообновление работает. |
| Debian/Ubuntu | `Forja-Launcher-<версия>-linux-amd64.deb` | `sudo apt install ./Forja-Launcher-*-linux-amd64.deb` — зависимости (`libegl1`, `libgl1`, `libgtk-3-0`, `libnss3`, …) подтянутся сами; рекомендуются `libopenal1`, `x11-xserver-utils` (xrandr для Minecraft ≤ 1.12.2). |
| Linux (архив) | `Forja-Launcher-<версия>-linux-x64.tar.gz` | Распаковать, запустить `forja-launcher`. |

**Предупреждения о неподписанном приложении:**

- **Windows SmartScreen** («Система Windows защитила ваш компьютер»): нажмите **«Подробнее» → «Выполнить в любом случае»**.
- **macOS Gatekeeper** («не удаётся проверить разработчика» / «приложение повреждено»):
  в Finder **правый клик по приложению → «Открыть» → «Открыть»** (один раз). Если macOS пишет,
  что приложение повреждено, снимите карантин в Терминале:
  `xattr -dr com.apple.quarantine "/Applications/Forja Launcher.app"`.
  Начиная с macOS 15 может понадобиться «Системные настройки → Конфиденциальность и безопасность → Всё равно открыть».
- **Linux**: предупреждений нет; для AppImage нужен `libfuse2` (Ubuntu 22.04+: `sudo apt install libfuse2`,
  Ubuntu 24.04+: `libfuse2t64`).

Данные лаунчера (версии, миры, моды) при удалении программы **не удаляются** — см. «Где хранятся данные».

## Автообновление

Лаунчер сам проверяет новые версии в GitHub Releases (при запуске и каждые 6 часов), скачивает их
в фоне и предлагает «Перезапустить и обновить» (Настройки → «Обновления лаунчера»; пока запущена игра,
обновление не ставится). Работает для: Windows-установщика (NSIS), AppImage и **подписанной** сборки macOS.
Отключено (с пояснением в настройках): при запуске из исходников, в portable-zip, deb/tar.gz,
в неподписанной macOS-сборке (Squirrel.Mac не принимает неподписанные обновления) и если
`FORJA_DISABLE_UPDATES=1`.

**Репозиторий обновлений задаётся в одном месте** — `package.json`:

```json
"forja": { "updates": { "owner": "zhekanisher7-rgb", "repo": "Forja-launcher" } }
```

Сборка в CI автоматически подставляет репозиторий, в котором она запущена (`FORJA_UPDATE_REPO`),
так что форк будет обновляться из своих релизов. Пустые значения или `OWNER` отключают автообновление.

## Сборка установщиков

Требуется Node.js 20 и `npm ci`. Каждая ОС собирается на своей системе (так же делает CI):

```bash
npm ci
npm run dist:linux   # AppImage + deb + tar.gz        → dist/
npm run dist:win     # NSIS x64 + zip x64/arm64        (на Windows)
npm run dist:mac     # dmg + zip x64 и arm64           (на macOS)
```

- Конфигурация — `electron-builder.config.js` → `scripts/builder-config.js` (appId `io.github.forja.launcher`,
  имена файлов `Forja-Launcher-<версия>-<ОС>-<арх>.<расширение>`, версия берётся из `package.json`).
- Иконки: `build/icon.ico` (Windows), `build/icon.icns` (macOS), `build/icons/*.png` (Linux, 16–1024 px).
- **Подпись (необязательно)** — только через переменные окружения, без них сборка просто не подписана:
  - macOS: `CSC_LINK` (сертификат Developer ID `.p12`, путь или base64) + `CSC_KEY_PASSWORD`;
    нотаризация — `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.
    Без сертификата приложение получает ad-hoc подпись (`scripts/after-pack.js`) — иначе Apple Silicon его не запустит.
    Hardened runtime включён, entitlements минимальные (`build/entitlements.mac.plist`: JIT для V8).
  - Windows: `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`.
- Сборка Windows из Linux требует `wine` (для rcedit/иконки exe) — проще собирать в CI.
- `npm run smoke` — быстрая проверка ядра для текущей ОС без игры (манифест, библиотеки и natives,
  аргументы запуска, Java runtime, цепочка Fabric); `node scripts/ci-smoke.js --as win32/x64` —
  имитация другой ОС.

## Публикация через GitHub

Workflow `.github/workflows/build.yml` (секреты не нужны):

1. На каждый push/PR: тесты + `ci-smoke` на Ubuntu, Windows, macOS arm64 (`macos-latest`) и
   macOS x64 (`macos-15-intel`), затем сборка Linux / Windows / macOS; установщики доступны
   во вкладке **Actions → запуск → Artifacts** (14 дней).
2. **Релиз:** поднимите версию в `package.json` (например `0.3.0`), закоммитьте и поставьте тег:

   ```bash
   git remote add origin https://github.com/zhekanisher7-rgb/Forja-launcher.git   # один раз
   git push -u origin main
   git tag v0.3.0
   git push origin v0.3.0
   ```

   Workflow проверит, что тег совпадает с версией, соберёт всё и создаст **GitHub Release**
   `Forja Launcher v0.3.0` со всеми установщиками и файлами `latest*.yml` / `*.blockmap`
   (их читает автообновление). Теги с дефисом (`v0.4.0-beta.1`) публикуются как pre-release.
3. Для подписи добавьте секреты репозитория `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` —
   workflow подхватит их сам.

## Что не проверено вживую

- Установщики Windows и macOS **собраны только в CI** (на машине разработки их не собирали и не запускали);
  их установка, ярлыки, язык установщика, SmartScreen/Gatekeeper, автообновление — не проверены.
- Модульные тесты и `ci-smoke` на Windows/macOS впервые запустятся в CI.
- Автообновление не проверено end-to-end (нужны два опубликованных релиза).
- deb не устанавливался через `apt` на чистой системе (проверены метаданные `dpkg-deb -I`).
- Linux arm64 не собирается: Mojang не выпускает natives LWJGL и Java для linux-arm64.
- Подробнее — `docs/TEST-REPORT.md`.

## Запуск (разработка)

Требуется Node.js ≥ 18.17 (проверено на 20.x).

```bash
npm ci
npm start          # запустить лаунчер
npm test           # модульные тесты (без сети)
npm run test:integration   # интеграционный тест: реальная установка 1.20.1 и 1.8.9 во временную папку (~1 ГБ)
node scripts/headless-launch.js 1.20.1 Tester --timeout 60   # установка и запуск без Electron
node scripts/headless-launch.js 1.20.1 Tester --loader forge   # то же с загрузчиком (fabric|quilt|forge|neoforge[:версия])
```

Параметры для разработки (переменные окружения):

- `FORJA_DATA_DIR=/путь` — другая папка данных лаунчера;
- `FORJA_IT_DIR`, `FORJA_IT_VERSIONS=1.20.1,1.8.9` — для интеграционного теста.

Если Electron не стартует в контейнере/виртуалке без sandbox, запускайте локально
`npx electron . --no-sandbox` — этот флаг **не** добавлен в код и в сборку намеренно.

## Где хранятся данные

Отдельно от стандартной `.minecraft`:

| ОС      | Папка |
|---------|-------|
| Windows | `%APPDATA%\Forja Launcher` |
| macOS   | `~/Library/Application Support/Forja Launcher` |
| Linux   | `$XDG_DATA_HOME/forja-launcher` или `~/.local/share/forja-launcher` |

Внутри: `versions/`, `libraries/`, `assets/` (indexes, objects, virtual, log_configs),
`runtime/` (Java), `instances/<id профиля>/` (игровые папки), `tmp/natives/` (временные natives),
`cache/`, `settings.json`, `profiles.json`, `loaders.json` (реестр загрузчиков).
В игровой папке профиля: `mods/`, `resourcepacks/`, `shaderpacks/`, `.forja/content.json` (кэш хэшей).

## Структура проекта

```
src/
  main/
    main.js            — главный процесс Electron, IPC
    config.js          — название лаунчера, официальные адреса, репозиторий обновлений
    updater.js         — автообновление (electron-updater, GitHub Releases)
    auth/
      index.js         — реестр провайдеров входа (единый формат сессии)
      offline.js       — «Офлайн (тест)», offline UUID
      microsoft.js     — заглушка под фазу 4
    core/              — ядро, обычные Node-модули без Electron (тестируются отдельно)
      paths.js         — папка данных по ОС и раскладка каталогов
      platform.js      — имя ОС/архитектура в терминах Mojang, разделитель classpath
      rules.js         — вычисление rules (os/arch/version/features)
      library.js       — maven-пути, разрешение библиотек и natives
      http.js          — fetch с User-Agent и повторами
      download.js      — параллельный загрузчик (SHA1, повторы, докачка, отмена)
      versions.js      — манифест версий, кэш, фильтры
      install.js       — установка версии (jar, библиотеки, natives, ресурсы, логирование)
      java.js          — Mojang Java runtime / Adoptium
      launch.js        — сборка аргументов и запуск процесса
      log4j.js         — разбор XML-логов игры
      launcher.js      — оркестрация: установка → Java → natives → запуск → очистка
      atomic.js        — атомарная запись JSON, чтение с откатом на .bak
      settings.js      — глобальные настройки (settings.json, схема v2, миграция v1)
      profiles.js      — профили (profiles.json), CRUD, миграция instances/default
      natives.js       — временные папки natives на запуск, очистка, уборка брошенных
      games.js         — менеджер запущенных игр (состояния, журналы, kill, crash)
      errors.js        — классификация ошибок → коды для понятных сообщений
      repair.js        — «Проверить и восстановить»
      loaders/
        inherit.js     — слияние версий по inheritsFrom
        meta.js        — Fabric / Quilt (meta API)
        forge.js       — Forge / NeoForge: версии, установщик, процессоры
        index.js       — выбор загрузчика, реестр loaders.json, ensureLoader
      modrinth.js      — клиент Modrinth API v2 (кэш, 429, facets)
      content.js       — моды/ресурспаки/шейдеры профиля: список, вкл/выкл, зависимости, обновления
      mrpack.js        — модпаки .mrpack
      storage.js       — место на диске и безопасная очистка
  preload/preload.js   — узкий API через contextBridge
  renderer/            — интерфейс (HTML/CSS/JS без фреймворков): index.html, styles.css, app.js,
                         mods.js (вкладка «Моды»), icons.js (значки), i18n/ru.json, i18n/en.json
  assets/              — иконка приложения (svg/png)
build/                 — иконки для сборки (ico/icns, icons/ для Linux), entitlements.mac.plist
scripts/render-icon.js — рендер иконки из SVG
test/unit/             — модульные тесты (node:test)
test/integration/      — интеграционный тест установки
scripts/headless-launch.js — установка и запуск без Electron
scripts/check-deps.js  — проверка node_modules перед тестами
scripts/ci-smoke.js    — smoke-проверка ядра для текущей ОС (CI)
scripts/verify-profiles.js — проверка файлов всех профилей по SHA1
scripts/builder-config.js, electron-builder.config.js — конфигурация сборки
scripts/after-pack.js  — ad-hoc подпись macOS без сертификата
.github/workflows/build.yml — CI: тесты, сборка, релиз по тегу v*
docs/                  — скриншоты и отчёт о тестировании
```

Безопасность Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
строгий CSP, запрет навигации и новых окон; рендерер общается с ядром только через
перечисленные в `preload.js` методы.

## Дорожная карта

- ~~Фаза 1 — ядро~~ ✅
- ~~Фаза 2 — профили/инстансы, настройки, новый интерфейс, natives на запуск, окно сбоя, иконка~~ ✅
- ~~Фаза 3 — Fabric, Quilt, Forge, NeoForge, Modrinth (моды, ресурспаки, шейдеры, модпаки .mrpack),
  очистка диска~~ ✅ (CurseForge не подключён: его API требует ключ, который нельзя хранить в клиенте.)
- **Фаза 4 — аккаунты Microsoft:** вход через OAuth 2.0 → Xbox Live → XSTS → Minecraft Services,
  проверка владения игрой, несколько аккаунтов, безопасное хранение токенов (OS keychain через `safeStorage`).
- ~~Фаза 5 — релиз: установщики (NSIS, dmg/zip, AppImage/deb/tar.gz), CI с релизом по тегу,
  автообновление~~ ✅ (подпись/нотаризация — по желанию через секреты; см. «Сборка установщиков»).
- **Фаза 4 — аккаунты Microsoft** — следующая (см. ниже).

### Важно про вход через Microsoft

Для входа через Microsoft нужно **зарегистрировать приложение в Azure (Microsoft Entra ID)** и получить
Client ID, а затем **подать заявку Mojang на доступ к Minecraft API** для этого приложения
(новые Azure-приложения без одобрения получают отказ от `api.minecraftservices.com`).
Client ID будет храниться в конфигурации, а не в коде; секреты в клиентском приложении не используются
(публичный клиент, device code или auth code + PKCE).

## Известные ограничения

См. `docs/TEST-REPORT.md` → «Известные проблемы».
