/**
 * Голосовой переводчик ver3.5 — основной JS-модуль (ES-модуль)
 *
 * Улучшения по сравнению с ver3:
 *  - Подробный чек-лист инициализации с пошаговым статусом
 *  - Проверка доступа к микрофону до активации кнопки «Старт»
 *  - Детальный журнал каждого этапа загрузки
 *  - Кнопка «Старт» активируется после проверки микрофона и движка
 *
 * Используемые технологии:
 *  - Распознавание речи: Web Speech API (SpeechRecognition)
 *  - Перевод: Bergamot WASM (@browsermt/bergamot-translator) — полностью локально
 *  - Синтез речи: Web Speech API (SpeechSynthesis)
 *
 * Нейросетевые модели предзагружены в папку ../models/ репозитория.
 * При недоступности локальных файлов используется резервная загрузка с S3.
 *
 * Для работы SharedArrayBuffer (требование WASM-движка) нужны заголовки
 * Cross-Origin-Opener-Policy: same-origin и Cross-Origin-Embedder-Policy: require-corp.
 * На GitHub Pages они устанавливаются через coi-serviceworker.js.
 */

// ============================================================
// Конфигурация
// ============================================================
const config = {
  translationDirection: "ru-en",  // "ru-en" или "en-ru"
  voiceGender: "female",           // "female" или "male"
  speechRate: 1.0,
  pauseDuration: 1500              // мс
};

// ============================================================
// Константы
// ============================================================

/** Соответствие направлений языковым кодам */
const LANG_CODES = {
  "ru-en": { source: "ru-RU", target: "en-US", from: "ru", to: "en" },
  "en-ru": { source: "en-US", target: "ru-RU", from: "en", to: "ru" }
};

/**
 * Локальный путь к файлам Bergamot WASM (относительно index.html).
 * Файлы скопированы из @browsermt/bergamot-translator@0.4.9 в папку ../bergamot/.
 */
const BERGAMOT_LOCAL = "../bergamot";

/**
 * Локальные пути к предзагруженным моделям (относительно index.html).
 * Файлы хранятся в репозитории в папке ../models/{direction}/.
 */
const LOCAL_MODEL_BASE = "../models";

/**
 * Резервный URL для моделей (официальный Bergamot S3).
 * Используется если локальные файлы недоступны.
 */
const REMOTE_MODEL_BASE = "https://bergamot.s3.amazonaws.com/models";

/**
 * Описание файлов модели для каждого направления.
 */
const MODEL_FILES = {
  "ruen": [
    { name: "model.ruen.intgemm.alphas.bin", type: "model" },
    { name: "lex.50.50.ruen.s2t.bin",       type: "lex"   },
    { name: "vocab.ruen.spm",               type: "vocab" }
  ],
  "enru": [
    { name: "model.enru.intgemm.alphas.bin", type: "model" },
    { name: "lex.50.50.enru.s2t.bin",       type: "lex"   },
    { name: "vocab.enru.spm",               type: "vocab" }
  ]
};

// ============================================================
// Модуль журнала (Logger)
// ============================================================
const Logger = (() => {
  let logEl = null;

  function init(element) {
    logEl = element;
  }

  function log(msg, level = "info") {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = { info: "ℹ️", warn: "⚠️", error: "❌", success: "✅" }[level] || "ℹ️";
    const line = `[${timestamp}] ${prefix} ${msg}`;

    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);

    if (logEl) {
      const entry = document.createElement("div");
      entry.className = `log-entry log-entry--${level}`;
      entry.textContent = line;
      logEl.appendChild(entry);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }

  return { init, log };
})();

// ============================================================
// Чек-лист инициализации (InitChecklist)
// ============================================================
const InitChecklist = (() => {
  const ICONS = {
    pending: "○",
    loading: "⏳",
    ok:      "✓",
    warn:    "⚠",
    error:   "✗"
  };

  function setItem(id, state, labelOverride) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `check-item check-item--${state}`;
    el.querySelector(".check-item__icon").textContent = ICONS[state] || "○";
    if (labelOverride) {
      el.querySelector(".check-item__label").textContent = labelOverride;
    }
  }

  return { setItem };
})();

// ============================================================
// Загрузка файлов с отслеживанием прогресса
// ============================================================

async function fetchWithProgress(url, onProgress) {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentLength = parseInt(response.headers.get("Content-Length") || "0", 10);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, contentLength || loaded);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

async function fetchLocalOrRemote(localUrl, remoteUrl, onProgress) {
  try {
    const buf = await fetchWithProgress(localUrl, onProgress);
    Logger.log(`Загружен локально: ${localUrl} (${Math.round(buf.byteLength / 1024)} КБ)`, "success");
    return buf;
  } catch (localErr) {
    Logger.log(`Локальный файл недоступен (${localErr.message}). Загружаю с сервера...`, "warn");
    const buf = await fetchWithProgress(remoteUrl, onProgress);
    Logger.log(`Загружен с сервера: ${remoteUrl} (${Math.round(buf.byteLength / 1024)} КБ)`, "success");
    return buf;
  }
}

// ============================================================
// Модуль перевода Bergamot (BergamotTranslator)
// ============================================================
const BergamotTranslator = (() => {
  const bufferCache = {};
  let translatorInstance = null;

  async function preloadBuffers(direction, onProgress) {
    if (bufferCache[direction]) return bufferCache[direction];

    const files = MODEL_FILES[direction];
    const result = {};
    let fileIdx = 0;

    for (const file of files) {
      fileIdx++;
      const label = `Файл ${fileIdx}/${files.length}: ${file.name}`;
      const localUrl  = `${LOCAL_MODEL_BASE}/${direction}/${file.name}`;
      const remoteUrl = `${REMOTE_MODEL_BASE}/${direction}/${file.name}`;

      Logger.log(`Загрузка: ${label}`, "info");
      if (onProgress) onProgress(
        Math.round(((fileIdx - 1) / files.length) * 100),
        label
      );

      result[file.type] = await fetchLocalOrRemote(localUrl, remoteUrl, (loaded, total) => {
        const filePct = total ? Math.round((loaded / total) * 100) : 0;
        if (onProgress) onProgress(
          Math.round(((fileIdx - 1) / files.length + (filePct / 100) / files.length) * 100),
          `${label} (${filePct}%)`
        );
      });
    }

    if (onProgress) onProgress(100, "Буферы модели загружены");
    bufferCache[direction] = result;
    return result;
  }

  async function initTranslator(direction, onProgress) {
    if (translatorInstance) return translatorInstance;

    Logger.log(`Загрузка WASM-модуля Bergamot локально: ${BERGAMOT_LOCAL}/translator.js`, "info");
    if (onProgress) onProgress(0, "Загрузка WASM-движка...");

    const { LatencyOptimisedTranslator, TranslatorBacking } = await import(`${BERGAMOT_LOCAL}/translator.js`);

    Logger.log("WASM-модуль успешно импортирован", "success");
    if (onProgress) onProgress(5, "WASM загружен, загружаем модели...");

    const buffers = await preloadBuffers(direction, (pct, label) => {
      if (onProgress) onProgress(5 + Math.round(pct * 0.90), label);
    });

    Logger.log("Создаём TranslatorBacking с предзагруженными буферами...", "info");

    const backing = new TranslatorBacking({ downloadTimeout: 0 });

    backing.getTranslationModel = async ({ from, to }, _options) => {
      const key = `${from}${to}`;
      const cached = bufferCache[key];
      if (!cached) throw new Error(`Буферы модели для ${from}->${to} не загружены`);
      Logger.log(`Передаём буферы модели ${key} в Bergamot`, "info");
      return {
        model: cached.model,
        shortlist: cached.lex,
        vocabs: [cached.vocab],
        qualityModel: null,
        config: {}
      };
    };

    backing.getModels = async ({ from, to }) => [{ from, to }];

    const workerUrl = `${BERGAMOT_LOCAL}/worker/translator-worker.js`;
    backing.loadWorker = async () => {
      const blob = new Blob(
        [`importScripts(${JSON.stringify(workerUrl)});`],
        { type: "application/javascript" }
      );
      const blobUrl = URL.createObjectURL(blob);
      const worker = new Worker(blobUrl);
      URL.revokeObjectURL(blobUrl);

      let serial = 0;
      const pending = new Map();

      const call = (name, ...args) => new Promise((accept, reject) => {
        const id = ++serial;
        pending.set(id, { accept, reject, callsite: { message: `${name}(${args.map(String).join(", ")})`, stack: new Error().stack } });
        worker.postMessage({ id, name, args });
      });

      worker.addEventListener("message", ({ data: { id, result, error } }) => {
        if (!pending.has(id)) return;
        const { accept, reject } = pending.get(id);
        pending.delete(id);
        if (error) reject(Object.assign(new Error(), error));
        else accept(result);
      });

      worker.addEventListener("error", (e) => {
        Logger.log(`Ошибка воркера Bergamot: ${e.message}`, "error");
      });

      const exports = new Proxy({}, {
        get: (_target, name) => (...args) => call(name, ...args)
      });

      await call("initialize", backing.options);

      return { worker, exports };
    };

    translatorInstance = new LatencyOptimisedTranslator({}, backing);

    Logger.log("Движок Bergamot инициализирован и готов к работе", "success");
    if (onProgress) onProgress(100, "Движок готов!");
    return translatorInstance;
  }

  async function translate(text, direction, onModelProgress) {
    if (!text || !text.trim()) return "";

    const from = direction.slice(0, 2);
    const to   = direction.slice(2, 4);

    Logger.log(`Перевод (${from}→${to}): "${text.substring(0, 60)}${text.length > 60 ? "..." : ""}"`, "info");

    const translator = await initTranslator(direction, onModelProgress);
    const response = await translator.translate({ from, to, text, html: false });

    const result = response.target.text;
    Logger.log(`Результат: "${result.substring(0, 60)}${result.length > 60 ? "..." : ""}"`, "success");
    return result;
  }

  function reset() {
    translatorInstance = null;
    Logger.log("Состояние движка сброшено", "info");
  }

  return { translate, reset };
})();

// ============================================================
// Резервный переводчик через MyMemory API (fallback)
// ============================================================
const FallbackTranslator = {
  async translate(text, langPair) {
    Logger.log(`MyMemory API: "${text.substring(0, 40)}..." (${langPair})`, "warn");
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data.responseStatus !== 200) throw new Error(data.responseDetails);
    const result = data.responseData.translatedText;
    Logger.log(`MyMemory результат: "${result.substring(0, 40)}..."`, "info");
    return result;
  }
};

// ============================================================
// Модуль синтеза речи (SpeechSynthesizer)
// ============================================================
const SpeechSynthesizer = {
  speak(text, lang, gender, rate) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;

    const voices = window.speechSynthesis.getVoices();
    const matching = voices.filter(v => v.lang.startsWith(lang.split("-")[0]));
    const keywords = gender === "female"
      ? ["female", "woman", "женский"]
      : ["male", "man", "мужской"];
    const genderVoice = matching.find(v =>
      keywords.some(kw => v.name.toLowerCase().includes(kw))
    );
    utterance.voice = genderVoice || matching[0] || null;

    Logger.log(`Озвучка (${lang}): "${text.substring(0, 40)}..."`, "info");
    window.speechSynthesis.speak(utterance);
  }
};

// ============================================================
// Модуль распознавания речи (SpeechRecognizer)
// ============================================================
const SpeechRecognizer = (() => {
  let recognition = null;
  let pauseTimer = null;
  let interimText = "";
  let finalText = "";
  let isRunning = false;

  function start({ lang, pauseDuration, onInterim, onFinal, onError }) {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      onError("SpeechRecognition не поддерживается. Используйте Chrome или Edge.");
      return;
    }

    recognition = new SpeechRecognitionAPI();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    finalText = "";
    interimText = "";
    isRunning = true;

    Logger.log(`Распознавание речи запущено (${lang})`, "info");

    recognition.onresult = (event) => {
      interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      onInterim(finalText + interimText);

      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        const blockText = (finalText + interimText).trim();
        if (blockText) {
          Logger.log(`Блок речи зафиксирован: "${blockText.substring(0, 60)}..."`, "info");
          onFinal(blockText);
          finalText = "";
          interimText = "";
        }
      }, pauseDuration);
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech") {
        Logger.log(`Ошибка распознавания: ${event.error}`, "error");
        onError(`Ошибка распознавания: ${event.error}`);
      }
    };

    recognition.onend = () => {
      if (isRunning) recognition.start();
    };

    recognition.start();
  }

  function stop() {
    isRunning = false;
    clearTimeout(pauseTimer);
    if (recognition) {
      recognition.stop();
      recognition = null;
    }
    Logger.log("Распознавание речи остановлено", "info");
  }

  return { start, stop };
})();

// ============================================================
// Основной контроллер приложения
// ============================================================
const App = (() => {
  let isActive = false;
  let bergamotReady = false;
  let microphoneReady = false;
  const el = {};

  function getModelDirection() {
    return config.translationDirection.replace("-", "");  // "ru-en" → "ruen"
  }

  async function init() {
    el.startBtn           = document.getElementById("startBtn");
    el.stopBtn            = document.getElementById("stopBtn");
    el.statusEl           = document.getElementById("status");
    el.sourceText         = document.getElementById("sourceText");
    el.targetText         = document.getElementById("targetText");
    el.sourceLang         = document.getElementById("sourceLangLabel");
    el.targetLang         = document.getElementById("targetLangLabel");
    el.dirSelect          = document.getElementById("dirSelect");
    el.genderSelect       = document.getElementById("genderSelect");
    el.rateInput          = document.getElementById("rateInput");
    el.pauseInput         = document.getElementById("pauseInput");
    el.rateValue          = document.getElementById("rateValue");
    el.pauseValue         = document.getElementById("pauseValue");
    el.modelProgress      = document.getElementById("modelProgress");
    el.modelProgressBar   = document.getElementById("modelProgressBar");
    el.modelProgressLabel = document.getElementById("modelProgressLabel");
    el.logPanel           = document.getElementById("logPanel");

    Logger.init(el.logPanel);
    Logger.log("=== Голосовой переводчик ver3.5 запускается ===", "info");

    loadConfigToUI();

    el.startBtn.addEventListener("click", startTranslation);
    el.stopBtn.addEventListener("click", stopTranslation);

    el.rateInput.addEventListener("input", () => {
      el.rateValue.textContent = el.rateInput.value;
    });
    el.pauseInput.addEventListener("input", () => {
      el.pauseValue.textContent = el.pauseInput.value + " мс";
    });

    document.getElementById("applyConfig").addEventListener("click", applyConfig);
    document.getElementById("clearLogBtn").addEventListener("click", () => {
      el.logPanel.innerHTML = "";
      Logger.log("Журнал очищен", "info");
    });

    // Последовательная проверка всех компонентов
    await runInitChecks();
  }

  // ----------------------------------------------------------
  // Пошаговая инициализация с чек-листом
  // ----------------------------------------------------------
  async function runInitChecks() {
    // Шаг 1: Совместимость браузера
    setStatus("Проверка браузера...", "loading");
    InitChecklist.setItem("chk-browser", "loading", "Проверка браузера...");
    Logger.log("Шаг 1/5: Проверка совместимости браузера", "info");

    const hasSpeechRecognition = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const hasSpeechSynthesis   = !!window.speechSynthesis;
    const hasWorker            = !!window.Worker;

    if (!hasSpeechRecognition) {
      Logger.log("SpeechRecognition не поддерживается! Требуется Chrome или Edge.", "error");
      InitChecklist.setItem("chk-browser", "error", "SpeechRecognition не поддерживается (нужен Chrome/Edge)");
      setStatus("Браузер не поддерживается. Используйте Chrome или Edge.", "error");
      return;
    }

    Logger.log(`SpeechRecognition: ✓ (${window.SpeechRecognition ? "стандарт" : "webkit-префикс"})`, "success");
    Logger.log(`SpeechSynthesis: ${hasSpeechSynthesis ? "✓" : "✗ (озвучка недоступна)"}`, hasSpeechSynthesis ? "success" : "warn");
    Logger.log(`Web Worker: ${hasWorker ? "✓" : "✗ (WASM-движок недоступен)"}`, hasWorker ? "success" : "warn");
    InitChecklist.setItem("chk-browser", "ok", `Браузер совместим (${navigator.userAgent.split(" ").pop()})`);

    // Шаг 2: SharedArrayBuffer / COOP+COEP
    setStatus("Проверка SharedArrayBuffer...", "loading");
    InitChecklist.setItem("chk-sab", "loading", "Проверка SharedArrayBuffer (COOP/COEP)...");
    Logger.log("Шаг 2/5: Проверка SharedArrayBuffer", "info");

    const hasSAB = typeof SharedArrayBuffer !== "undefined";
    if (hasSAB) {
      Logger.log("SharedArrayBuffer: ✓ (COOP/COEP заголовки установлены)", "success");
      InitChecklist.setItem("chk-sab", "ok", "SharedArrayBuffer доступен (COOP/COEP ✓)");
    } else {
      Logger.log("SharedArrayBuffer недоступен — COOP/COEP заголовки не установлены. WASM-движок может не работать.", "warn");
      InitChecklist.setItem("chk-sab", "warn", "SharedArrayBuffer недоступен (COOP/COEP не установлены)");
    }

    // Шаг 3: Доступ к микрофону
    setStatus("Запрос доступа к микрофону...", "loading");
    InitChecklist.setItem("chk-mic", "loading", "Запрашиваем доступ к микрофону...");
    Logger.log("Шаг 3/5: Проверка доступа к микрофону", "info");

    microphoneReady = await checkMicrophone();

    // Шаг 4: Загрузка WASM-движка Bergamot
    setStatus("Загрузка WASM-движка...", "loading");
    InitChecklist.setItem("chk-wasm", "loading", "Загрузка WASM-движка Bergamot...");
    Logger.log("Шаг 4/5: Загрузка WASM-движка Bergamot", "info");

    // Шаг 5: Загрузка модели перевода
    await preloadModel();
  }

  /**
   * Проверяет доступ к микрофону через getUserMedia.
   * Запрашивает разрешение, проверяет наличие треков и закрывает поток.
   * @returns {Promise<boolean>} true если микрофон доступен
   */
  async function checkMicrophone() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      Logger.log("navigator.mediaDevices.getUserMedia недоступен в этом браузере/протоколе", "warn");
      InitChecklist.setItem("chk-mic", "warn", "Микрофон: API недоступен (нужен HTTPS)");
      return false;
    }

    try {
      Logger.log("Запрашиваем доступ к микрофону...", "info");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) {
        Logger.log("Микрофон: разрешение получено, но аудио-трек не найден", "warn");
        InitChecklist.setItem("chk-mic", "warn", "Микрофон: трек не найден");
        stream.getTracks().forEach(t => t.stop());
        return false;
      }

      const trackLabel = tracks[0].label || "неизвестное устройство";
      Logger.log(`Микрофон доступен: "${trackLabel}" (треков: ${tracks.length})`, "success");
      InitChecklist.setItem("chk-mic", "ok", `Микрофон подключён: ${trackLabel}`);

      // Закрываем тестовый поток — он нам не нужен до нажатия Старт
      stream.getTracks().forEach(t => t.stop());
      Logger.log("Тестовый поток микрофона закрыт", "info");
      return true;

    } catch (err) {
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        Logger.log(`Доступ к микрофону запрещён пользователем: ${err.message}`, "error");
        InitChecklist.setItem("chk-mic", "error", "Доступ к микрофону запрещён (разрешите в браузере)");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        Logger.log(`Микрофон не найден: ${err.message}`, "error");
        InitChecklist.setItem("chk-mic", "error", "Микрофон не найден");
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        Logger.log(`Микрофон занят другим приложением: ${err.message}. Закройте другие вкладки браузера или приложения, использующие микрофон (видеозвонки, Zoom, Teams, Discord, OBS и др.), и перезагрузите страницу.`, "warn");
        InitChecklist.setItem("chk-mic", "warn", "Микрофон занят (закройте приложения с микрофоном и обновите страницу)");
      } else {
        Logger.log(`Ошибка доступа к микрофону (${err.name}): ${err.message}`, "warn");
        InitChecklist.setItem("chk-mic", "warn", `Микрофон: ${err.name}`);
      }
      return false;
    }
  }

  async function preloadModel() {
    const direction = getModelDirection();
    InitChecklist.setItem("chk-model", "loading", "Загрузка модели перевода...");
    showProgress(true);
    Logger.log(`Шаг 5/5: Загрузка модели для направления: ${direction}`, "info");

    try {
      // Тестовый перевод инициализирует движок и модель
      Logger.log("Запуск тестового перевода для прогрева движка...", "info");
      await BergamotTranslator.translate("тест", direction, (pct, label) => {
        updateProgress(pct, label);
        if (pct < 10) {
          InitChecklist.setItem("chk-wasm", "loading", `WASM: ${label}`);
        } else {
          InitChecklist.setItem("chk-wasm", "ok", "WASM-движок Bergamot загружен ✓");
          InitChecklist.setItem("chk-model", "loading", label);
        }
        updateProgress(pct, label);
      });

      bergamotReady = true;
      InitChecklist.setItem("chk-wasm", "ok", "WASM-движок Bergamot загружен ✓");
      InitChecklist.setItem("chk-model", "ok", `Модель ${direction} загружена ✓`);
      showProgress(false);

      Logger.log("=== Инициализация завершена успешно ===", "success");
      Logger.log(`Bergamot: ✓ | Микрофон: ${microphoneReady ? "✓" : "⚠ (ограниченный режим)"}`, "info");

      if (microphoneReady) {
        setStatus("Готов. Нажмите «Старт» для начала перевода.", "ready");
      } else {
        setStatus("Движок готов, но микрофон недоступен. Проверьте разрешения.", "warn");
      }
      el.startBtn.disabled = false;

    } catch (err) {
      Logger.log(`Bergamot недоступен: ${err.message}`, "error");
      Logger.log("Переключаемся на резервный переводчик MyMemory API", "warn");

      InitChecklist.setItem("chk-wasm", "warn", "WASM-движок недоступен → резервный MyMemory API");
      InitChecklist.setItem("chk-model", "warn", "Локальная модель не загружена → MyMemory API");

      bergamotReady = false;
      showProgress(false);

      Logger.log("=== Инициализация завершена (резервный режим) ===", "warn");

      if (microphoneReady) {
        setStatus("Локальный движок недоступен → MyMemory API. Нажмите «Старт».", "warn");
      } else {
        setStatus("Движок и микрофон недоступны. Проверьте разрешения.", "warn");
      }
      el.startBtn.disabled = false;
    }
  }

  function loadConfigToUI() {
    el.dirSelect.value        = config.translationDirection;
    el.genderSelect.value     = config.voiceGender;
    el.rateInput.value        = config.speechRate;
    el.rateValue.textContent  = config.speechRate;
    el.pauseInput.value       = config.pauseDuration;
    el.pauseValue.textContent = config.pauseDuration + " мс";
    updateLangLabels();
  }

  function updateLangLabels() {
    const labels = {
      "ru-en": { source: "Русский",    target: "Английский" },
      "en-ru": { source: "Английский", target: "Русский"    }
    };
    const l = labels[config.translationDirection];
    el.sourceLang.textContent = l.source;
    el.targetLang.textContent = l.target;
  }

  function applyConfig() {
    const prevDirection = config.translationDirection;
    config.translationDirection = el.dirSelect.value;
    config.voiceGender          = el.genderSelect.value;
    config.speechRate           = parseFloat(el.rateInput.value);
    config.pauseDuration        = parseInt(el.pauseInput.value, 10);

    updateLangLabels();
    setStatus("Настройки применены", "ready");
    Logger.log(`Настройки: направление=${config.translationDirection}, скорость=${config.speechRate}`, "info");

    if (config.translationDirection !== prevDirection) {
      bergamotReady = false;
      BergamotTranslator.reset();
      if (isActive) stopTranslation();
      preloadModel();
      return;
    }

    if (isActive) {
      stopTranslation();
      setTimeout(startTranslation, 300);
    }
  }

  function startTranslation() {
    if (isActive) return;
    isActive = true;

    el.startBtn.disabled = true;
    el.stopBtn.disabled  = false;
    setStatus("Слушаю...");
    Logger.log("=== Сеанс перевода начат ===", "success");

    const langs = LANG_CODES[config.translationDirection];

    SpeechRecognizer.start({
      lang: langs.source,
      pauseDuration: config.pauseDuration,

      onInterim: (text) => {
        el.sourceText.textContent = text;
      },

      onFinal: async (text) => {
        el.sourceText.textContent = text;
        setStatus("Перевожу...");

        try {
          let translatedText;

          if (bergamotReady) {
            translatedText = await BergamotTranslator.translate(text, getModelDirection());
          } else {
            const [src, tgt] = config.translationDirection.split("-");
            translatedText = await FallbackTranslator.translate(text, `${src}|${tgt}`);
          }

          el.targetText.textContent = translatedText;
          setStatus("Озвучиваю...");
          SpeechSynthesizer.speak(translatedText, langs.target, config.voiceGender, config.speechRate);
          setStatus("Слушаю...");

        } catch (err) {
          Logger.log(`Ошибка перевода: ${err.message}`, "error");
          setStatus(`Ошибка перевода: ${err.message}`, "error");
        }
      },

      onError: (msg) => {
        Logger.log(`Ошибка: ${msg}`, "error");
        setStatus(msg, "error");
        stopTranslation();
      }
    });
  }

  function stopTranslation() {
    if (!isActive) return;
    isActive = false;

    SpeechRecognizer.stop();
    window.speechSynthesis.cancel();

    el.startBtn.disabled = false;
    el.stopBtn.disabled  = true;
    setStatus("Остановлено");
    Logger.log("=== Сеанс перевода завершён ===", "info");
  }

  function setStatus(msg, type = "") {
    el.statusEl.textContent = msg;
    el.statusEl.className   = "status" + (type ? ` status--${type}` : "");
  }

  function showProgress(visible) {
    el.modelProgress.classList.toggle("visible", visible);
  }

  function updateProgress(pct, label) {
    el.modelProgressBar.style.width   = pct + "%";
    el.modelProgressLabel.textContent = label;
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
