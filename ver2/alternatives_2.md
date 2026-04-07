# Альтернативные self-hosted подходы к машинному переводу

В этом документе рассматриваются подходы к получению **self-hosted перевода** — в первую очередь с использованием JavaScript-библиотек — а также разработка собственной JS-библиотеки перевода.

---

## Сравнительная таблица

| Подход                         | Язык/платформа    | Self-hosted | Качество    | Сложность развёртывания | Работает в браузере | Лицензия         |
|-------------------------------|-------------------|-------------|-------------|------------------------|---------------------|------------------|
| **LibreTranslate** (ver2)     | Python + REST API | ✅ Да        | Среднее     | Низкая (Docker)        | ✅ Через API        | AGPLv3            |
| **Argos Translate (JS-биндинг)** | JS/Node.js     | ✅ Да        | Среднее     | Средняя                | ✅ Частично (Wasm) | MIT               |
| **OpenNMT + JS-клиент**       | JS/Node.js        | ✅ Да        | Среднее-Высокое | Высокая            | ✅ Через API        | MIT               |
| **CTranslate2 + REST**        | C++/Python        | ✅ Да        | Высокое     | Средняя                | ✅ Через API        | MIT               |
| **OPUS-MT (Bergamot/Firefox)** | C++ / Wasm       | ✅ Да        | Среднее     | Высокая (Wasm сборка)  | ✅ Нативно (Wasm)  | MPL 2.0          |
| **Собственная JS-библиотека** | Vanilla JS        | ✅ Да        | Зависит от модели | Зависит          | ✅ Да               | По выбору         |

---

## 1. Argos Translate — JS-биндинг через Wasm

[Argos Translate](https://github.com/argosopentech/argos-translate) — Python-движок перевода, лежащий в основе LibreTranslate. Существуют проекты по компиляции его в WebAssembly для запуска прямо в браузере.

### Подход

```
браузер → argos-translate.wasm → перевод без сервера
```

### Реализация (концептуальная)

```html
<!-- Предполагаемый JS-интерфейс Wasm-биндинга -->
<script src="argos-wasm/argos.js"></script>
<script>
  ArgosTranslate.init().then(async (translate) => {
    // Загрузить языковую пару
    await translate.loadPackage("translate-en_ru-1_9.argosmodel");

    // Переводим
    const result = await translate.translate("Hello world", "en", "ru");
    console.log(result); // "Привет мир"
  });
</script>
```

### Готовый пакет: `argos-translate-wasm`

```bash
# Сборка из исходников (для разработчиков)
git clone https://github.com/argosopentech/argos-translate
cd argos-translate
# Требует Emscripten для компиляции в Wasm
```

**Плюсы:**
- Перевод полностью в браузере, без сервера
- Высокая конфиденциальность: данные не покидают браузер

**Минусы:**
- Языковые пакеты весят 50–200 МБ — долгая первая загрузка
- Wasm-биндинг ещё в стадии разработки
- Требует IndexedDB / Cache API для хранения моделей

---

## 2. OpenNMT-js — нейросетевой перевод на Node.js

[OpenNMT](https://opennmt.net/) — фреймворк для нейросетевого машинного перевода. Официальная JS-реализация — [OpenNMT-js](https://github.com/OpenNMT/OpenNMT-js).

### Установка (Node.js сервер)

```bash
npm install opennmt-js
```

### Пример: простой HTTP-сервер перевода

```javascript
// server.js
const http = require("http");
const onmt = require("opennmt-js");

const translator = new onmt.Translator("./models/ru-en", {
  inter_threads: 1,
  intra_threads: 4,
});

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/translate") {
    res.writeHead(404);
    return res.end();
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    const { text } = JSON.parse(body);
    // OpenNMT работает с токенами — нужен токенизатор
    const tokens = text.split(" "); // упрощённо; в реальности нужен SentencePiece
    const results = await translator.translate([tokens], { beam_size: 2 });
    const translated = results[0].hypotheses[0].join(" ");

    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ translatedText: translated }));
  });
});

server.listen(5001, () => console.log("OpenNMT сервер запущен на :5001"));
```

### Загрузка модели OPUS-MT для ru↔en

```bash
# Скачать модель Helsinki-NLP/opus-mt-ru-en (совместима с OpenNMT-py → CTranslate2 → OpenNMT-js)
pip install ctranslate2 sentencepiece
ct2-opus-mt-converter --model Helsinki-NLP/opus-mt-en-ru --output_dir ./models/en-ru
```

**Плюсы:**
- Чистый JavaScript/Node.js — легко встраивается в экосистему
- Поддержка многих языков через модели OPUS-MT

**Минусы:**
- Требует Node.js-сервер (не работает напрямую в браузере)
- Нужен токенизатор (SentencePiece) — дополнительная зависимость
- Более сложная настройка, чем LibreTranslate

---

## 3. CTranslate2 — быстрый вывод с REST API

[CTranslate2](https://github.com/OpenNMT/CTranslate2) — оптимизированный C++ движок для запуска моделей трансформеров (Helsinki-NLP, OPUS-MT, NLLB-200 и др.).

### Запуск через Docker

```bash
docker run -d \
  --name ct2-server \
  -p 5001:5001 \
  -v $(pwd)/models:/models \
  ghcr.io/alisoltaninejad/ctranslate2-rest:latest \
  --model /models/opus-mt-en-ru
```

### JS-клиент для браузера

```javascript
// Универсальный клиент для CTranslate2 REST API
const CT2Client = {
  async translate(text, sourceLang, targetLang) {
    const response = await fetch("http://localhost:5001/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: [text],       // массив предложений
        source: sourceLang,
        target: targetLang,
      }),
    });
    const data = await response.json();
    return data.translations[0];
  },
};
```

**Плюсы:**
- Очень высокая скорость (оптимизировано для CPU и GPU)
- Поддержка моделей NLLB-200 (200 языков)
- Потребляет меньше RAM, чем полный PyTorch-стек

**Минусы:**
- Требует сервер (C++/Python бэкенд)
- Сложнее настроить, чем LibreTranslate
- Готового Docker-образа с REST нет в официальном репозитории (нужен самостоятельный)

---

## 4. Project Bergamot / Firefox Translations (Wasm)

[Bergamot](https://browser.mt/) — проект Mozilla/EU для перевода в браузере без сервера. Используется в Firefox как «Firefox Translations».

### Архитектура

```
браузер
  └── bergamot-translator.wasm
        ├── модель (*.npz) — исходный язык → target
        └── vocabulary (vocab.spm)
```

### JS API (bergamot-translator.js)

```javascript
import { createBergamotTranslator } from "./bergamot-translator.js";

const translator = await createBergamotTranslator({
  // Модели загружаются лениво при первом запросе
  modelRegistry: {
    "en-ru": {
      model: "/models/en-ru/model.npz",
      lex:   "/models/en-ru/lex.50.50.enru.s2t.bin",
      vocab: "/models/en-ru/vocab.spm",
    }
  }
});

const result = await translator.translate("en", "ru", "Hello world");
console.log(result); // "Привет мир"
```

### Загрузка моделей Firefox Translations

```bash
# Модели распространяются через Firefox-репозиторий
# Пример: english → russian
curl -LO "https://storage.googleapis.com/bergamot-models-sandbox/0.4.0/models/prod/eten/model.eten.intgemm.alphas.bin"
# ... (аналогично vocab и lex файлы)
```

**Плюсы:**
- **Полностью в браузере** — не нужен сервер
- Реальный production-проект (используется в Firefox)
- Хорошее качество для европейских языков

**Минусы:**
- Модели весят 15–30 МБ на пару (нужна первая загрузка)
- Wasm-файл ~20 МБ
- Сложная интеграция: нужны SharedArrayBuffer и cross-origin isolation headers
- Ограниченный набор языковых пар (не все языки поддержаны)

### Требования для HTTPS-хостинга

Чтобы использовать SharedArrayBuffer (обязательный для Bergamot), сервер должен отдавать заголовки:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

---

## 5. Разработка собственной JS-библиотеки перевода

Можно создать собственную JS-библиотеку, взяв за основу готовое решение. Ниже описана структура такой библиотеки на примере обёртки над LibreTranslate/CTranslate2.

### Концепция

```
my-translator.js (ваша библиотека)
  ├── TranslatorBackend — абстрактный интерфейс
  ├── LibreTranslateBackend — реализация для LibreTranslate
  ├── BergamotBackend — реализация для Wasm
  └── TranslatorFactory — фабрика, выбирающая бэкенд
```

### Реализация

```javascript
/**
 * my-translator.js — универсальная JS-библиотека self-hosted перевода
 * Поддерживает несколько бэкендов: LibreTranslate, Bergamot (Wasm)
 */

// ---- Абстрактный бэкенд ----
class TranslatorBackend {
  async translate(text, sourceLang, targetLang) {
    throw new Error("Метод translate() должен быть реализован");
  }
  async isAvailable() {
    return false;
  }
}

// ---- LibreTranslate REST API ----
class LibreTranslateBackend extends TranslatorBackend {
  constructor({ url = "http://localhost:5000", apiKey = "" } = {}) {
    super();
    this.url = url.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async translate(text, sourceLang, targetLang) {
    const body = { q: text, source: sourceLang, target: targetLang, format: "text" };
    if (this.apiKey) body.api_key = this.apiKey;

    const response = await fetch(`${this.url}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`LibreTranslate error: ${response.status}`);
    const data = await response.json();
    return data.translatedText;
  }

  async isAvailable() {
    try {
      const r = await fetch(`${this.url}/languages`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }
}

// ---- Заглушка: Bergamot Wasm (для расширения) ----
class BergamotBackend extends TranslatorBackend {
  constructor({ wasmPath = "./bergamot-translator.js", models = {} } = {}) {
    super();
    this.wasmPath = wasmPath;
    this.models = models;
    this._engine = null;
  }

  async _init() {
    if (this._engine) return;
    const { createBergamotTranslator } = await import(this.wasmPath);
    this._engine = await createBergamotTranslator({ modelRegistry: this.models });
  }

  async translate(text, sourceLang, targetLang) {
    await this._init();
    return this._engine.translate(sourceLang, targetLang, text);
  }

  async isAvailable() {
    try {
      await this._init();
      return true;
    } catch {
      return false;
    }
  }
}

// ---- Фабрика с авто-выбором бэкенда ----
class TranslatorFactory {
  /**
   * Создаёт транслятор, автоматически выбирая рабочий бэкенд.
   * @param {TranslatorBackend[]} backends — список бэкендов в порядке приоритета
   * @returns {Promise<TranslatorBackend>}
   */
  static async create(backends) {
    for (const backend of backends) {
      if (await backend.isAvailable()) {
        return backend;
      }
    }
    throw new Error("Ни один бэкенд перевода недоступен");
  }
}

// ---- Публичный API библиотеки ----
const MyTranslator = {
  LibreTranslateBackend,
  BergamotBackend,
  TranslatorFactory,
};

// Экспорт для ES modules
// export { LibreTranslateBackend, BergamotBackend, TranslatorFactory };

// Экспорт для <script> тега
if (typeof window !== "undefined") {
  window.MyTranslator = MyTranslator;
}
```

### Использование библиотеки

```javascript
// Вариант 1: только LibreTranslate
const translator = new MyTranslator.LibreTranslateBackend({
  url: "http://localhost:5000"
});
const text = await translator.translate("Hello world", "en", "ru");

// Вариант 2: с авто-fallback — сначала Bergamot, затем LibreTranslate
const translator = await MyTranslator.TranslatorFactory.create([
  new MyTranslator.BergamotBackend({ wasmPath: "./bergamot.js", models: {...} }),
  new MyTranslator.LibreTranslateBackend({ url: "http://localhost:5000" }),
]);
const text = await translator.translate("Hello world", "en", "ru");
```

### Добавление нового бэкенда

Чтобы добавить поддержку нового движка (например, DeepL или custom model):

```javascript
class MyCustomBackend extends TranslatorBackend {
  async translate(text, source, target) {
    // Ваша логика — вызов локального сервера, Wasm, IndexedDB-кэш и т.д.
    return "переведённый текст";
  }
  async isAvailable() {
    // Проверить доступность движка
    return true;
  }
}
```

---

## Сравнение по ключевым критериям

### Работа без сервера (только браузер)

| Подход                   | Без сервера |
|--------------------------|-------------|
| LibreTranslate (ver2)    | ❌ Нужен сервер |
| Argos Translate Wasm     | ✅ Да (экспериментально) |
| OpenNMT-js               | ❌ Node.js сервер |
| CTranslate2              | ❌ C++/Python сервер |
| Bergamot (Firefox)       | ✅ Да (Wasm) |
| Собственная JS-библиотека | ✅/❌ Зависит от выбранного бэкенда |

### Качество перевода ru↔en

| Подход                   | Качество    | Примечание                          |
|--------------------------|-------------|-------------------------------------|
| LibreTranslate           | Среднее     | Argos-модели                        |
| OpenNMT + OPUS-MT        | Среднее+    | Helsinki-NLP модели                 |
| CTranslate2 + NLLB-200   | Высокое     | Meta NLLB — 200 языков              |
| Bergamot                 | Среднее     | Компактные модели Firefox           |

---

## Рекомендации по выбору подхода

| Задача                                              | Рекомендуется               |
|-----------------------------------------------------|-----------------------------|
| Простой self-hosted с минимальной настройкой        | **LibreTranslate (ver2)**   |
| Перевод полностью в браузере (нет сервера)          | **Bergamot / Argos Wasm**   |
| Высокое качество, много языков                      | **CTranslate2 + NLLB-200**  |
| Node.js-экосистема, кастомные модели                | **OpenNMT-js**              |
| Единый интерфейс с несколькими бэкендами            | **Собственная JS-библиотека** |
