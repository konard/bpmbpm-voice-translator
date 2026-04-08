# Архитектура голосового переводчика ver3_6a (Bergamot WASM)

## Обзор решения

Голосовой переводчик ver3 — браузерное веб-приложение на чистом JavaScript (ES-модули),
работающее **без серверной части**. Перевод выполняется **локально в браузере** с помощью
нейросетевого движка Bergamot (Mozilla Firefox Translations) через WebAssembly (WASM).

Весь код выполняется на стороне клиента. Серверная часть не нужна ни для перевода,
ни для распознавания речи, ни для синтеза речи — только для раздачи статических файлов.

---

## Выбор технологии перевода

### Почему Bergamot, а не Argos Translate

| Критерий | Bergamot | Argos Translate |
|----------|----------|-----------------|
| Браузерный JS / WASM | **Да** — официальный WASM-порт | Нет — только Python |
| Работа без сервера | **Да** | Нет |
| GitHub Pages | **Да** (с workaround) | Нет |
| Качество (ru↔en) | Высокое (Marian NMT) | Высокое (OpenNMT) |
| CDN-доступность | **Да** (jsDelivr) | Нет |

Argos Translate существует только в виде Python-библиотеки и требует серверной части
(LibreTranslate). Bergamot имеет официальный WASM-порт, разработанный Mozilla для
встройки в Firefox — именно он используется в функции «Translate Page» в Firefox.

Подробнее о Bergamot: https://browser.mt/  
Репозиторий WASM-порта: https://github.com/browsermt/bergamot-translator  
npm-пакет: https://www.npmjs.com/package/@browsermt/bergamot-translator

---

## Компоненты системы

### 1. Модуль конфигурации (`config`)
Объект JS с параметрами:
- `translationDirection` — `"ru-en"` или `"en-ru"`
- `voiceGender` — `"female"` / `"male"`
- `speechRate` — скорость синтеза речи
- `pauseDuration` — пауза (мс) для определения конца блока речи

---

### 2. WASM-движок перевода Bergamot (`BergamotTranslator`)

**Используемый пакет:** `@browsermt/bergamot-translator@0.4.9`  
**CDN:** `https://cdn.jsdelivr.net/npm/@browsermt/bergamot-translator@0.4.9/`

Подкомпоненты:
- **`translator.js`** — JavaScript API-обёртка (~79 КБ)
- **`translator-worker.js`** — Web Worker (~17 КБ), выполняет WASM-код в отдельном потоке
- **`bergamot-translator-worker.wasm`** — скомпилированный движок Marian NMT (~5 МБ)

#### Зачем Web Worker?

WebAssembly в браузере по умолчанию выполняется в основном потоке, что блокирует UI.
Bergamot запускает WASM внутри [Web Worker](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API) —
отдельного потока, изолированного от DOM. Это позволяет переводить текст, не замораживая интерфейс.

Обмен данными между основным потоком и воркером происходит через `postMessage()` и
`SharedArrayBuffer` — специальную разделяемую память, доступную одновременно из нескольких потоков.

---

### 3. Нейросетевые модели (Marian NMT)

Модели хранятся в папке `models/` репозитория. Они предзагружены, чтобы приложение
работало без обращения к внешним серверам после первого запуска.

| Направление | Файл модели | Файл лексики | Файл словаря | Суммарно |
|-------------|-------------|--------------|--------------|---------|
| ru→en (ruen) | `model.ruen.intgemm.alphas.bin` ~16 МБ | `lex.50.50.ruen.s2t.bin` ~5 МБ | `vocab.ruen.spm` ~1 МБ | ~22 МБ |
| en→ru (enru) | `model.enru.intgemm.alphas.bin` ~16 МБ | `lex.50.50.enru.s2t.bin` ~3 МБ | `vocab.enru.spm` ~1 МБ | ~20 МБ |

Модели скачаны с официального Bergamot S3 Mozilla: `https://bergamot.s3.amazonaws.com/models/`

При недоступности локальных файлов (например, при первом запуске без кэша) происходит
автоматическая загрузка с S3. Модели кэшируются браузером — повторные запуски мгновенны.

#### Алгоритм перевода внутри WASM

```
Входной текст
     │
     ▼
1. Токенизация (SentencePiece)
   Текст разбивается на подслова (subword units), а не на целые слова.
   Например: "переводчик" → ["перевод", "чик"].
   Это позволяет работать с редкими и составными словами.
   Подробнее: https://github.com/google/sentencepiece
     │
     ▼
2. Encoder (трансформер)
   Последовательность токенов кодируется в набор векторов —
   числовых представлений значения каждого слова в контексте.
   Архитектура трансформера: https://arxiv.org/abs/1706.03762
     │
     ▼
3. Decoder (трансформер) с Beam search
   Авторегрессивно генерирует токены целевого языка.
   Beam search (ширина луча = 4) одновременно отслеживает
   несколько лучших гипотез перевода и выбирает оптимальную.
   Подробнее о beam search: https://en.wikipedia.org/wiki/Beam_search
     │
     ▼
4. INT8-квантизация (INTGEMM)
   [см. раздел ниже]
     │
     ▼
5. Детокенизация
   Токены целевого языка собираются обратно в текст.
     │
     ▼
Переведённый текст
```

#### Что такое INT8-квантизация (INTGEMM)?

Нейросетевые модели хранят веса в формате float32 (32-битные числа с плавающей точкой).
При выполнении матричных умножений (основная операция трансформера) float32 требует много
памяти и вычислений.

**Квантизация** — это преобразование весов из float32 в int8 (8-битные целые числа).
Это уменьшает размер модели в ~4 раза и ускоряет вычисления в 4–8× без значительной потери качества.

**INTGEMM** (Integer Matrix Multiplication) — оптимизированная библиотека Mozilla для
выполнения матричных умножений с целыми числами, использующая SIMD-инструкции процессора
(SSE2, AVX2, AVX512 на x86; NEON на ARM). Встроена в WASM-движок Bergamot.

Суффикс `.intgemm.alphas.bin` в имени файла модели означает, что модель уже квантизована
в формат int8 с сохранёнными коэффициентами масштабирования (`alphas`) для каждого слоя.

Подробнее об INTGEMM: https://github.com/kpu/intgemm  
Подробнее о квантизации нейросетей: https://arxiv.org/abs/1712.05877

---

### 4. Service Worker для COOP/COEP (`coi-serviceworker.js`)

#### Проблема: SharedArrayBuffer и заголовки безопасности

`SharedArrayBuffer` — разделяемая память между потоками браузера — был временно отключён
во всех браузерах в 2018 году из-за уязвимостей [Spectre/Meltdown](https://meltdownattack.com/).
В 2020 году его вернули, но теперь он требует специальных HTTP-заголовков безопасности:

- `Cross-Origin-Opener-Policy: same-origin` (COOP) — изолирует окно браузера от других вкладок
- `Cross-Origin-Embedder-Policy: require-corp` (COEP) — запрещает загрузку ресурсов без явного разрешения

Без этих заголовков `typeof SharedArrayBuffer === "undefined"` — WASM-движок не работает.

Подробнее: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer#security_requirements

#### Проблема: GitHub Pages не поддерживает произвольные HTTP-заголовки

GitHub Pages — статический хостинг. Нельзя настроить заголовки ответа сервера.
Это означает, что COOP/COEP нельзя установить стандартным способом.

#### Решение: coi-serviceworker

[`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker) (автор: Guido Zuidhof, лицензия MIT) —
Service Worker, который **перехватывает все ответы** браузера и программно добавляет
заголовки COOP/COEP к каждому ответу.

#### Как работает Service Worker

[Service Worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API) — это
скрипт, который браузер регистрирует один раз и запускает в фоне, отдельно от страницы.
Он перехватывает все сетевые запросы страницы (через `fetch` event) и может изменять ответы.

```
Браузер запрашивает ресурс (JS, WASM, модели...)
         │
         ▼
  Service Worker (coi-serviceworker.js)
  перехватывает запрос через fetch-событие
         │
         ▼
  Запрос уходит на сервер (GitHub Pages / localhost)
         │
         ▼
  Ответ возвращается в Service Worker
         │
         ▼
  SW добавляет заголовки:
    Cross-Origin-Opener-Policy: same-origin
    Cross-Origin-Embedder-Policy: require-corp
         │
         ▼
  Изменённый ответ возвращается браузеру
         │
         ▼
  SharedArrayBuffer становится доступен ✓
```

#### Особенность первого запуска

При первом открытии страницы Service Worker ещё не зарегистрирован. Поэтому:
1. Страница загружается без нужных заголовков
2. `coi-serviceworker.js` регистрирует Service Worker
3. Страница **автоматически перезагружается**
4. При второй загрузке SW уже активен и добавляет заголовки
5. `SharedArrayBuffer` теперь доступен

Этот процесс прозрачен для пользователя (перезагрузка мгновенная).

#### Где запускается coi-serviceworker.js?

`coi-serviceworker.js` подключается **в `<head>` страницы** как обычный тег `<script>`:
```html
<script src="coi-serviceworker.js"></script>
```

Код скрипта выполняется в контексте **основной страницы** (не в воркере), где:
1. Регистрирует Service Worker: `navigator.serviceWorker.register('coi-serviceworker.js')`
2. Service Worker загружается браузером отдельно и начинает перехватывать запросы
3. Сам `coi-serviceworker.js` — это **и страничный скрипт, и Service Worker в одном файле**
   (определяет `self.registration` для различения контекста)

---

### 5. Запуск локально: зачем нужен `http://localhost:8000`

#### Почему нельзя открыть HTML-файл напрямую

При открытии `index.html` двойным кликом (протокол `file://`):
- Service Worker **не работает** (требует HTTPS или localhost с HTTP/S)
- `fetch()` к другим файлам (`./models/...`, `./bergamot/...`) **блокируется** политикой CORS
- Некоторые браузеры ограничивают Web Workers на `file://`

**Нужен HTTP-сервер**, даже простейший, для корректной работы всех API.

#### Почему `localhost` является исключением для HTTPS

Браузеры считают `localhost` «безопасным контекстом» (secure context) несмотря на отсутствие HTTPS:
- Разрешены: `getUserMedia` (микрофон), Service Worker, `SharedArrayBuffer`
- Это стандартное поведение, описанное в спецификации W3C: https://www.w3.org/TR/secure-contexts/

#### Как запустить локальный сервер

Любой из способов:

```bash
# Python 3 (встроен в большинство систем)
cd ver3/
python3 -m http.server 8000
# Открыть: http://localhost:8000

# Node.js (если установлен)
npx serve ver3/
# Открыть: http://localhost:3000

# VS Code расширение Live Server
# Нажать «Go Live» в правом нижнем углу — откроет автоматически
```

`http://localhost:8000` — это адрес локального сервера:
- `localhost` — специальное имя хоста, указывающее на ваш компьютер (127.0.0.1)
- `8000` — номер порта (можно выбрать любой свободный)

---

### 6. GitHub Pages: развёртывание без серверной части

#### Что такое GitHub Pages

[GitHub Pages](https://pages.github.com/) — бесплатный статический хостинг от GitHub.
Он раздаёт файлы репозитория напрямую через CDN Fastly. **Никакого серверного кода нет** —
только раздача статических файлов (HTML, JS, WASM, бинарных моделей).

Адрес: `https://bpmbpm.github.io/voice-translator/ver3/`

#### Что происходит при открытии страницы на GitHub Pages

```
Пользователь открывает https://bpmbpm.github.io/voice-translator/ver3/
         │
         ▼
GitHub Pages отдаёт index.html (статический файл)
         │
         ▼
Браузер загружает coi-serviceworker.js → регистрирует SW → перезагрузка
         │
         ▼
SW активен, добавляет COOP/COEP заголовки ко всем ответам
         │
         ▼
Браузер загружает translator.js (ES-модуль)
         │
         ▼
translator.js загружает bergamot/translator.js
translator.js загружает models/ruen/*.bin (предзагруженные модели из репозитория)
         │
         ▼
WASM инициализируется в Web Worker → движок готов
         │
         ▼
Пользователь нажимает «Старт» → работает полностью в браузере
```

Серверная часть **не разворачивается**. GitHub Pages лишь раздаёт статические файлы.
Все вычисления (распознавание, перевод, синтез) происходят **в браузере пользователя**.

#### Почему модели хранятся в репозитории (а не загружаются с CDN)

Модели (~40 МБ суммарно) включены прямо в репозиторий в папку `models/`. Это сделано
намеренно, чтобы:
1. Приложение работало **полностью офлайн** после первой загрузки страницы
2. Не зависеть от доступности CDN Mozilla S3 при каждом запуске

Резервная загрузка с S3 (`https://bergamot.s3.amazonaws.com/models/`) происходит
автоматически, если локальные файлы по каким-то причинам недоступны.

---

### 7. Резервный переводчик (`FallbackTranslator`)

При недоступности Bergamot (например, WASM не поддерживается браузером или не загрузился)
автоматически используется [MyMemory REST API](https://mymemory.translated.net/doc/spec.php)
(как в ver1). Обеспечивает базовую работоспособность в любых условиях.

Ограничения MyMemory: лимит 5000 знаков в сутки для анонимных запросов, требует интернет,
перевод уходит на внешний сервер (меньше конфиденциальности).

---

### 8. Модуль распознавания речи (`SpeechRecognizer`)

[Web Speech API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Speech_API) — браузерный API
для работы с голосом. `SpeechRecognition` в Chrome/Edge использует Google Cloud Speech-to-Text
на серверах Google (аудио отправляется для распознавания, но не для перевода).

Режимы работы:
- `continuous: true` — не останавливается после первой фразы
- `interimResults: true` — возвращает промежуточные (незавершённые) результаты для real-time отображения

**Обработка ошибок микрофона:**
- `no-speech` — тишина, игнорируется
- `audio-capture` — микрофон временно недоступен (занят другим приложением); генерируется предупреждение, но сессия не прерывается — после `onend` распознавание перезапускается автоматически
- прочие ошибки — выводятся и останавливают сессию

---

### 9. Модуль синтеза речи (`SpeechSynthesizer`)

[SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) — браузерный API
для синтеза речи. Использует голоса операционной системы (Microsoft — Windows, Apple — macOS/iOS,
Google — Android/ChromeOS). Работает **локально**, без отправки текста на серверы.

---

### 10. Модуль проверки микрофона (`MicTester`)

Использует [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API):
- `getUserMedia` → `AudioContext` → `MediaStreamSourceNode` → `GainNode` → `AnalyserNode`
- `AnalyserNode.getByteFrequencyData()` — частотный анализ (FFT) для определения уровня сигнала
- `GainNode` позволяет усилить слабый сигнал (ползунок «Чувствительность»)

**Важно:** MicTester и SpeechRecognizer используют микрофон независимо.
`getUserMedia` в MicTester не влияет на работу `SpeechRecognition`.

---

## Диаграмма компонентов

```
┌──────────────────────────────────────────────────────────────────────┐
│                           Браузер                                    │
│                                                                      │
│  ┌──────────────┐    ┌────────────────────┐    ┌────────────────┐   │
│  │SpeechRecog-  │    │  BergamotTransla-  │    │SpeechSynthesis │   │
│  │nizer         │───▶│  tor (WASM)        │───▶│(TTS)           │   │
│  │(Web API,     │    │                    │    │(Web API,       │   │
│  │ Google STT)  │    │ ┌────────────────┐ │    │ локально)      │   │
│  └──────────────┘    │ │translator.js   │ │    └────────────────┘   │
│       │              │ │  (JS API)      │ │                         │
│       │              │ └──────┬─────────┘ │           │             │
│       │              │        │           │           │             │
│       ▼              │ ┌──────▼─────────┐ │           ▼             │
│  ┌──────────┐        │ │Web Worker      │ │    ┌────────────────┐   │
│  │   UI     │◀───────│ │(translator-    │ │    │   Пользо-      │   │
│  │(HTML/CSS)│        │ │worker.js +     │ │───▶│   ватель       │   │
│  └──────────┘        │ │.wasm ~5 МБ)    │ │    └────────────────┘   │
│                      │ └────────────────┘ │                         │
│                      └────────────────────┘                         │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ coi-serviceworker.js                                         │    │
│  │ Service Worker: добавляет COOP/COEP заголовки               │    │
│  │ → разблокирует SharedArrayBuffer для Web Worker + WASM       │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
        │                      │                      │
        ▼                      ▼                      ▼
  Микрофон            models/ в репозитории    (опционально)
  (локально)          или Mozilla S3           MyMemory API
                      (первая загрузка)        (fallback)
```

---

## Диаграмма потока данных

```
Пользователь говорит
        │
        ▼
SpeechRecognition (Chrome/Edge → Google STT серверы)
        │  промежуточные результаты
        ├──────────────────────────▶ UI: отображение sourceText
        │
        │  пауза > pauseDuration мс (конец блока речи)
        ▼
  Текст блока речи
        │
        ├── если bergamotReady ──▶ BergamotTranslator.translate()
        │                                    │
        │                           Web Worker (отдельный поток)
        │                           SentencePiece токенизация
        │                           Marian NMT encoder-decoder
        │                           INT8 квантизация (INTGEMM)
        │                           Beam search (ширина = 4)
        │                           Детокенизация
        │                                    │
        └── иначе (fallback) ──▶ MyMemory API (fetch → сервер)
                                             │
                                             ▼
                                    Переведённый текст
                                             │
                          ┌──────────────────┴──────────┐
                          ▼                             ▼
                 UI: отображение                SpeechSynthesis
                  targetText                   (OS TTS, локально)
```

---

## Диаграмма состояний приложения

```
[Загрузка страницы]
        │
        ▼
  [Инициализация]
        │  чек-лист: браузер → SAB → микрофон → WASM → модель
        │
        ├── успех ──▶ bergamotReady = true ──▶ [Ready] (чек-лист скрывается)
        │
        └── ошибка ─▶ bergamotReady = false ─▶ [Ready + fallback MyMemory]

[Ready]  ←  кнопка «Старт» разблокирована независимо от статуса микрофона
        │  кнопка "Старт"
        ▼
  [Listening] ──────────────────────────────────────────┐
        │  пауза обнаружена                             │
        ▼                                               │
  [Translating] ─── ошибка ──▶ статус ошибки ─────────▶│
        │  перевод получен                              │
        ▼                                               │
  [Speaking] ─── озвучка завершена ──────────────────▶[Listening]
        │
        │  кнопка "Стоп"
        ▼
     [Stopped]
```

---

## Диаграмма инициализации чек-листа

```
Шаг 1/5: Проверка браузера
  Проверяет: SpeechRecognition, SpeechSynthesis, Web Worker
  При отсутствии SpeechRecognition → остановка (нужен Chrome/Edge)

Шаг 2/5: Проверка SharedArrayBuffer
  Проверяет: typeof SharedArrayBuffer !== "undefined"
  При отсутствии → предупреждение, продолжаем (WASM попробует без SAB)

Шаг 3/5: Проверка доступа к микрофону (getUserMedia)
  При ошибке → предупреждение, НЕ блокирует дальнейшую инициализацию
  SpeechRecognition работает независимо от getUserMedia

Шаг 4/5: Загрузка WASM-движка (translator.js + translator-worker.js + .wasm)

Шаг 5/5: Загрузка модели перевода (3 файла из models/)
  После завершения: кнопка «Старт» разблокируется
                    чек-лист скрывается через 1.5 с
```

---

## Структура файлов

```
ver3/
├── index.html              # Разметка и встроенные стили
├── translator.js           # Основная логика ver3_6a (ES-модуль)
├── coi-serviceworker.js    # Service Worker для COOP/COEP (GitHub Pages / localhost)
├── readme.md               # Описание и инструкция по запуску
├── architecture_3.md       # Предыдущая версия архитектуры
├── architecture_4.md       # Данный файл
├── alternatives_3.md       # Альтернативные self-hosted подходы
├── bergamot/               # Bergamot WASM из @browsermt/bergamot-translator@0.4.9
│   ├── translator.js       # JS API-обёртка
│   └── worker/
│       ├── translator-worker.js        # Web Worker
│       └── bergamot-translator-worker.wasm  # Скомпилированный движок (~5 МБ)
└── models/                 # Предзагруженные нейросетевые модели
    ├── ruen/               # Русский → Английский (~22 МБ)
    │   ├── model.ruen.intgemm.alphas.bin
    │   ├── lex.50.50.ruen.s2t.bin
    │   └── vocab.ruen.spm
    └── enru/               # Английский → Русский (~20 МБ)
        ├── model.enru.intgemm.alphas.bin
        ├── lex.50.50.enru.s2t.bin
        └── vocab.enru.spm
```

---

## Технологический стек

| Компонент | Технология | Версия | Подробнее |
|-----------|-----------|--------|-----------|
| Распознавание речи | Web Speech API (SpeechRecognition) | браузерный стандарт | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition) |
| WASM-движок перевода | @browsermt/bergamot-translator | 0.4.9 | [npm](https://www.npmjs.com/package/@browsermt/bergamot-translator) |
| Нейросетевые модели | Marian NMT (ruen / enru) | Mozilla S3 | [Marian NMT](https://marian-nmt.github.io/) |
| NMT-квантизация | INTGEMM (INT8) | встроено в WASM | [intgemm](https://github.com/kpu/intgemm) |
| Токенизация | SentencePiece | встроено в WASM | [sentencepiece](https://github.com/google/sentencepiece) |
| COOP/COEP workaround | coi-serviceworker | 0.1.7 | [GitHub](https://github.com/gzuidhof/coi-serviceworker) |
| Синтез речи | Web Speech API (SpeechSynthesis) | браузерный стандарт | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis) |
| Резервный перевод | MyMemory REST API | бесплатный | [Docs](https://mymemory.translated.net/doc/spec.php) |
| Тест микрофона | Web Audio API | браузерный стандарт | [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) |
| Интерфейс | HTML5 + CSS3 + Vanilla JS (ES-модули) | — | — |
| Хостинг | GitHub Pages / localhost | — | [GitHub Pages](https://pages.github.com/) |

---

## Ограничения

### Первая загрузка
- Модель для каждого направления (~15–22 МБ) скачивается при первом запуске
- Последующие запуски используют кэш браузера (Cache API / HTTP-кэш)

### Браузерная совместимость
- SpeechRecognition: только Chrome / Edge (Firefox не поддерживает Web Speech API)
- SharedArrayBuffer: требует COOP/COEP заголовков (обеспечивается coi-serviceworker)
- WASM: поддерживается всеми современными браузерами (Chrome 57+, Firefox 52+, Safari 11+)
- На Firefox кнопка «Старт» будет недоступна (нет SpeechRecognition), но загрузка движка произойдёт

### Микрофон
- При ошибке `NotReadableError` (микрофон занят другим приложением через USB) `getUserMedia` в
  шаге инициализации может завершиться с ошибкой, но это **не блокирует** работу приложения.
  `SpeechRecognition` имеет собственный доступ к микрофону и может работать независимо.
- При ошибке `audio-capture` во время сессии перевода система выводит предупреждение и
  автоматически продолжает работу (не останавливает сессию).

### Качество перевода
- Bergamot использует те же модели, что Firefox Translations — качество хорошее,
  но ниже GPT-4/DeepL уровня
- Отдельные редкие слова и специализированная терминология могут переводиться неточно

### Производительность
- Перевод на CPU занимает 0.5–2 с для обычных фраз (зависит от железа)
- INT8 квантизация ускоряет работу, но на мобильных устройствах может быть медленнее
