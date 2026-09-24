# Отчёт о тестировании — фаза 1

Машина: Linux x86_64 (Debian 13, Mesa llvmpipe, без GPU и звука), Node 20.19, Electron 31.

## Модульные тесты — `npm test`

37 тестов, 37 пройдено: rules (os/arch/version/features, «последнее правило решает»),
maven-пути и разрешение библиотек (artifact, без downloads, legacy classifiers с `${arch}`,
фильтр natives по архитектуре), аргументы (modern/legacy, порядок, `-Xms/-Xmx`, разделители
classpath для Windows/unix, `-XstartOnFirstThread` на macOS, custom resolution, log4j, `${game_assets}`),
подстановка плейсхолдеров, offline UUID (сверено с `java.util.UUID.nameUUIDFromBytes` на Java 17:
Notch → `b50ad385-829d-3141-a216-7e7d7539ba7f`), пути данных по ОС, маппинг платформ Java runtime,
фильтр версий, `inheritsFrom`, загрузчик (параллельность, SHA1, пропуск, повтор после 500,
повторная загрузка испорченного файла, 404, отмена, докачка через Range), парсер XML-логов.

## Интеграционный тест — `npm run test:integration`

Чистая временная папка, только core-модули (без Electron), затем независимая перепроверка SHA1 каждого файла.

| Версия | Проверено файлов | Объём | Библиотеки+клиент | Ресурсы | Java | Время установки |
|---|---|---|---|---|---|---|
| 1.20.1 | 3652, ошибок SHA1: 0 | 697.8 МБ | 54 файла, 77.3 МБ | 3575 файлов, 620.2 МБ | 17.0.15 (Mojang), 133 файла, 95.2 МБ | 35.5 с + Java 3.7 с |
| 1.8.9 | 769, ошибок SHA1: 0 | 131.4 МБ | 35 файлов, 21.8 МБ | 722 файла (187 новых, 8.3 МБ; остальные общие с 1.20.1) | 8u202 (Mojang), 300 файлов, 224.2 МБ | 5.2 с + Java 4.5 с |

Итого тест ~51 с. Также проверено: natives распакованы (`.so`), все элементы classpath существуют,
в аргументах нет нераскрытых `${…}`, мажорная версия Java совпадает с требуемой.

## Реальный запуск игры

`DISPLAY=:3 LIBGL_ALWAYS_SOFTWARE=1`, режим «Офлайн (тест)». Ни в одном запуске нет
`ClassNotFoundException`, `NoClassDefFoundError` или `UnsatisfiedLinkError`.

| Версия | Как запускали | Результат |
|---|---|---|
| 1.20.1 | `scripts/headless-launch.js` | `Setting user`, `Backend library: LWJGL version 3.3.1`, атласы текстур, главное меню — `screenshot-game.png` |
| 1.8.9 | headless (legacy `minecraftArguments` + natives classifiers, Java 8) | `LWJGL Version: 2.9.4`, главное меню — `screenshot-game-1.8.9.png` |
| 1.12.2 | **через интерфейс Electron** (установка с нуля + запуск) | главное меню — `screenshot-ui-progress.png`, `screenshot-ui-game-running.png`, `screenshot-ui.png` |
| 1.16.5 | через интерфейс: установка, затем «Отмена» | загрузка остановлена, статус «Отменено» |
| 1.6.4 | headless (virtual/legacy assets) | `Setting user`, LWJGL 2.9.0 |
| 1.5.2 | headless (`map_to_resources`, launchwrapper), отдельная игровая папка | главное меню — `screenshot-game-1.5.2.png` |
| 26.3 (последний релиз) | headless (Java 25, SDL3) | OpenGL 4.5 (Mesa), главное меню — `screenshot-game-26.3.png` (понадобился системный `libegl1`, см. ниже) |

Ошибки в логах, связанные со средой, а не с лаунчером: нет звуковой карты (ALSA/OpenAL →
игра переходит в режим без звука); `401 Failed to verify authentication` / `Failed to fetch user properties` /
Realms `Failed to parse into SignedJWT` — ожидаемо для офлайн-режима без токена.

## Известные проблемы / что не проверено

1. **Windows и macOS не тестировались вживую.** Код учитывает: `javaw.exe`, `jre.bundle/Contents/Home/bin/java`,
   `-XstartOnFirstThread`, разделитель `;`, `%APPDATA%`, симлинки Java runtime (на Windows пропускаются — в Windows-runtime Mojang их нет).
2. **Общая игровая папка** `instances/default` для всех версий (как `.minecraft` у vanilla). Старые версии могут падать
   на `options.txt` от новых (например, 1.5.2 с `lang:en_us` → NPE). В headless-скрипте есть `--game-dir`;
   полноценные профили с отдельными папками — фаза 2.
3. **Linux:** для новых версий на SDL3 (26.x) нужен системный `libEGL` (`libegl1`), иначе «Couldn't find matching GLX visual».
   Надо описать в требованиях / deb-зависимостях (фаза 5).
4. **Linux arm64 / прочие архитектуры:** Mojang runtime нет → Adoptium (код есть, вживую не проверялся);
   у старых версий нет arm64-natives в JSON.
5. Правила `os.version` сверяются с `os.release()` (на macOS это версия ядра Darwin, а не macOS). Затрагивает только
   очень старые правила (`^10\.5\.\d$`).
6. Natives распаковываются в `versions/<id>/natives` заново при каждом запуске; если та же версия уже запущена,
   на Windows возможна ошибка блокировки файлов. Позже стоит перейти на временную папку для каждого запуска.
7. При каждом запуске ресурсы перепроверяются по SHA1 (~1–3 с на 700 МБ с тёплым кэшем ФС); Java runtime после
   первой проверки сверяется только по размеру.
8. Нет иконки приложения (`build/` пуст), автообновления и подписи — фаза 5.
9. `--no-sandbox` использовался только для запуска Electron на тестовой машине; в код и сборку он не добавлен.
