# Проблема: таймаут WASM translator.translate() в Bergamot

## Симптом

После успешной инициализации всех компонентов (браузер, SharedArrayBuffer, микрофон, WASM-движок, модели) вызов `translator.translate()` зависает и через 15 секунд прерывается по таймауту:

```
[21:05:28] ✅ Движок Bergamot инициализирован и готов к работе
[21:05:28] ℹ️ Вызов WASM translator.translate() для "тест"...
[21:05:43] ❌ Bergamot недоступен: Превышен таймаут 15000 мс: translator.translate(ru→en)
[21:05:43] ⚠️ Переключаемся на резервный переводчик MyMemory API
```

## История попыток

Было предпринято более 10 попыток исправить проблему. Ключевые итерации:

- **ver3_5**: базовая реализация Bergamot WASM через Blob-воркер
- **ver3_5b**: исправлен URL воркера — теперь используется абсолютный URL через `document.baseURI`
- **ver3_6**: добавлено модальное окно теста микрофона, чек-лист инициализации
- **ver3_6b**: детальный лог значка микрофона, увеличен таймаут, добавлен тест-сюит

Ни одна из попыток не устранила зависание `translate()`, потому что причина находилась глубже —
в механизме загрузки WASM внутри воркера.

## Архитектура загрузки (как это должно работать)

```
translator.js (главный поток)
  └─ BergamotTranslator.initTranslator()
       ├─ import bergamot/translator.js          → LatencyOptimisedTranslator
       ├─ preloadBuffers()                        → загружает модели из models/ (fetch)
       ├─ backing.getTranslationModel()           → возвращает предзагруженные буферы
       ├─ backing.loadWorker()                    → запускает Web Worker
       │    ├─ new Worker(blobUrl)                ← Blob-воркер с importScripts(workerUrl)
       │    └─ call("initialize", options)        → worker.initialize(options)
       └─ new LatencyOptimisedTranslator(...)
            └─ translate({from, to, text})
                 └─ worker.exports.translate(...)
                      └─ service.translate(...)   ← ЗДЕСЬ ЗАВИСАЕТ
```

## Корневая причина

### Проблема с Blob-воркером и relative importScripts

В `translator.js` функция `loadWorker` создаёт Blob-воркер:

```js
const blob = new Blob(
  [`importScripts(${JSON.stringify(workerUrl)});`],
  { type: "application/javascript" }
);
const worker = new Worker(URL.createObjectURL(blob));
```

Внутри Blob-воркера `self.location` — это `blob:http://...`, а не URL страницы.

Когда исполняется `importScripts(workerUrl)` и загружается `translator-worker.js`,
этот файл содержит строку (строка 266):

```js
self.importScripts('bergamot-translator-worker.js');
```

Это **относительный путь**. Он разрешается относительно `self.location` воркера —
то есть относительно `blob:` URL, а не пути страницы. В результате браузер не может
найти файл `bergamot-translator-worker.js`, бросает ошибку, но она не отображается
в интерфейсе, а вместо этого вызов `translate()` просто зависает навсегда.

Аналогично строка 243 в `translator-worker.js`:

```js
const response = await self.fetch(new URL('./bergamot-translator-worker.wasm', self.location));
```

Здесь `self.location` — URL самого воркера. После `importScripts(workerUrl)` внутри
Blob-воркера `self.location` остаётся blob URL, и `./bergamot-translator-worker.wasm`
не разрешается в правильный абсолютный путь.

### Почему инициализация проходила успешно

`call("initialize", options)` в `loadWorker` вызывает `worker.initialize(options)`,
который запускает `loadModule()`. Внутри `loadModule()`:

1. `self.fetch(new URL('./bergamot-translator-worker.wasm', self.location))` — если
   `self.location` = blob URL, то URL `.wasm` файла неверен.
2. `self.importScripts('bergamot-translator-worker.js')` — относительный путь не работает.

Но `initialize()` не падает — ошибка подавляется или `Module.onRuntimeInitialized`
вызывается частично. WASM-модуль инициализируется неправильно, `BlockingService`
создаётся, но внутри он нерабочий. Поэтому `call("initialize")` возвращает успех.

Когда позже вызывается `translate()`, Worker пытается выполнить реальный перевод через
сломанный `BlockingService` и зависает (или падает без ответа).

## Решение

Передать **абсолютный базовый URL** директории воркера через `options.workerBaseUrl`,
чтобы `translator-worker.js` мог сформировать правильные абсолютные пути:

1. В `translator.js`: вычислить базовый URL и добавить в `options.workerBaseUrl`.
2. В `translator-worker.js`: использовать `this.options.workerBaseUrl` вместо относительных
   путей при загрузке `.wasm` и `.js` файлов.

Это позволяет Blob-воркеру загрузить все нужные файлы независимо от `self.location`.

## Связанные файлы

| Файл | Роль |
|------|------|
| `ver3/translator.js` | Главный JS-модуль приложения. Содержит `BergamotTranslator` с кастомным `loadWorker`. |
| `ver3/bergamot/translator.js` | JS-обёртка из npm `@browsermt/bergamot-translator@0.4.9`. Содержит `TranslatorBacking`, `LatencyOptimisedTranslator`. |
| `ver3/bergamot/worker/translator-worker.js` | Код Web Worker: загружает WASM и выполняет перевод. |
| `ver3/bergamot/worker/bergamot-translator-worker.wasm` | Скомпилированный движок Marian NMT (~5 МБ). |
| `ver3/bergamot/worker/bergamot-translator-worker.js` | Emscripten glue-код для WASM (загружается через importScripts). |

## Почему два translator.js

- `ver3/translator.js` — **главный модуль приложения** (ES-модуль, 989 строк). Содержит
  весь UI-логику: чек-лист инициализации, распознавание речи, синтез речи, тест микрофона,
  основной контроллер App.
- `ver3/bergamot/translator.js` — **библиотека Bergamot** из npm-пакета
  `@browsermt/bergamot-translator@0.4.9` (скопирована в репозиторий). Содержит
  `TranslatorBacking`, `LatencyOptimisedTranslator`, `BatchTranslator`.

Это **не дубликаты** — это разные файлы с разными ролями. Первый использует второй.
