/**
 * Голосовой переводчик — основной JS-модуль (ver2)
 * Использует стандартные браузерные API: SpeechRecognition и SpeechSynthesis
 * Перевод: LibreTranslate (self-hosted) REST API
 */

// ============================================================
// Блок конфигурации (JSON-совместимая структура)
// ============================================================
const config = {
  // URL вашего LibreTranslate-сервера (без финального слеша)
  // Примеры:
  //   "http://localhost:5000"       — локальный Docker-контейнер
  //   "https://translate.mysite.com" — собственный сервер
  libreTranslateUrl: "http://localhost:5000",

  // API-ключ LibreTranslate (пустая строка — если не используется)
  apiKey: "",

  // Направление перевода: "ru-en" (рус→англ) или "en-ru" (англ→рус)
  translationDirection: "ru-en",

  // Предпочтительный пол голоса озвучки: "female" или "male"
  voiceGender: "female",

  // Скорость произношения: 1.0 — нормальная, 0.5 — медленная
  speechRate: 1.0,

  // Пауза (мс) для определения конца блока речи
  pauseDuration: 1500
};

// ============================================================
// Вспомогательные константы
// ============================================================

/** Соответствие направлений перевода языковым кодам */
const LANG_CODES = {
  "ru-en": { source: "ru-RU", target: "en-US", srcCode: "ru", tgtCode: "en" },
  "en-ru": { source: "en-US", target: "ru-RU", srcCode: "en", tgtCode: "ru" }
};

// ============================================================
// Модуль перевода (Translator) — LibreTranslate
// ============================================================
const Translator = {
  /**
   * Переводит текст через LibreTranslate API
   * @param {string} text — исходный текст
   * @param {string} sourceLang — код языка источника (например "ru")
   * @param {string} targetLang — код языка перевода (например "en")
   * @returns {Promise<{translatedText: string}>}
   */
  async translate(text, sourceLang, targetLang) {
    const url = `${config.libreTranslateUrl}/translate`;

    const body = {
      q: text,
      source: sourceLang,
      target: targetLang,
      format: "text"
    };

    // Добавляем API-ключ только если он задан
    if (config.apiKey) {
      body.api_key = config.apiKey;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      let errMsg = `Ошибка сервера: ${response.status}`;
      try {
        const errData = await response.json();
        if (errData.error) errMsg = `Ошибка LibreTranslate: ${errData.error}`;
      } catch (_) {}
      throw new Error(errMsg);
    }

    const data = await response.json();
    if (!data.translatedText) {
      throw new Error("LibreTranslate не вернул перевод");
    }

    return { translatedText: data.translatedText };
  },

  /**
   * Проверяет доступность LibreTranslate-сервера
   * @returns {Promise<boolean>}
   */
  async checkHealth() {
    try {
      const response = await fetch(`${config.libreTranslateUrl}/languages`, {
        method: "GET",
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch (_) {
      return false;
    }
  }
};

// ============================================================
// Модуль синтеза речи (SpeechSynthesizer)
// ============================================================
const SpeechSynthesizer = {
  /**
   * Озвучивает текст с заданными параметрами
   * @param {string} text — текст для озвучки
   * @param {string} lang — языковой код (например "en-US")
   * @param {string} gender — "female" или "male"
   * @param {number} rate — скорость (0.1–10)
   */
  speak(text, lang, gender, rate) {
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;

    const voices = window.speechSynthesis.getVoices();
    const matchingVoices = voices.filter(v => v.lang.startsWith(lang.split("-")[0]));
    const genderKeyword = gender === "female"
      ? ["female", "woman", "женский"]
      : ["male", "man", "мужской"];

    const genderVoice = matchingVoices.find(v =>
      genderKeyword.some(kw => v.name.toLowerCase().includes(kw))
    );
    utterance.voice = genderVoice || matchingVoices[0] || null;

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
          onFinal(blockText);
          finalText = "";
          interimText = "";
        }
      }, pauseDuration);
    };

    recognition.onerror = (event) => {
      if (event.error !== "no-speech") {
        onError(`Ошибка распознавания: ${event.error}`);
      }
    };

    recognition.onend = () => {
      if (isRunning) {
        recognition.start();
      }
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
  }

  return { start, stop };
})();

// ============================================================
// Основной контроллер приложения
// ============================================================
const App = (() => {
  let isActive = false;
  const elements = {};

  function init() {
    elements.startBtn      = document.getElementById("startBtn");
    elements.stopBtn       = document.getElementById("stopBtn");
    elements.statusEl      = document.getElementById("status");
    elements.sourceText    = document.getElementById("sourceText");
    elements.targetText    = document.getElementById("targetText");
    elements.serverUrl     = document.getElementById("serverUrl");
    elements.apiKey        = document.getElementById("apiKey");
    elements.checkBtn      = document.getElementById("checkBtn");
    elements.serverStatus  = document.getElementById("serverStatus");
    elements.dirSelect     = document.getElementById("dirSelect");
    elements.genderSelect  = document.getElementById("genderSelect");
    elements.rateInput     = document.getElementById("rateInput");
    elements.pauseInput    = document.getElementById("pauseInput");
    elements.rateValue     = document.getElementById("rateValue");
    elements.pauseValue    = document.getElementById("pauseValue");

    loadConfigToUI();

    elements.startBtn.addEventListener("click", startTranslation);
    elements.stopBtn.addEventListener("click", stopTranslation);
    elements.checkBtn.addEventListener("click", checkServer);
    document.getElementById("applyConfig").addEventListener("click", applyConfig);

    elements.rateInput.addEventListener("input", () => {
      elements.rateValue.textContent = elements.rateInput.value;
    });
    elements.pauseInput.addEventListener("input", () => {
      elements.pauseValue.textContent = elements.pauseInput.value + " мс";
    });
  }

  function loadConfigToUI() {
    elements.serverUrl.value     = config.libreTranslateUrl;
    elements.apiKey.value        = config.apiKey;
    elements.dirSelect.value     = config.translationDirection;
    elements.genderSelect.value  = config.voiceGender;
    elements.rateInput.value     = config.speechRate;
    elements.rateValue.textContent = config.speechRate;
    elements.pauseInput.value    = config.pauseDuration;
    elements.pauseValue.textContent = config.pauseDuration + " мс";
  }

  function applyConfig() {
    config.libreTranslateUrl   = elements.serverUrl.value.trim().replace(/\/$/, "");
    config.apiKey              = elements.apiKey.value.trim();
    config.translationDirection = elements.dirSelect.value;
    config.voiceGender         = elements.genderSelect.value;
    config.speechRate          = parseFloat(elements.rateInput.value);
    config.pauseDuration       = parseInt(elements.pauseInput.value, 10);

    setStatus("Настройки применены");

    if (isActive) {
      stopTranslation();
      setTimeout(startTranslation, 300);
    }
  }

  async function checkServer() {
    elements.serverStatus.textContent = "Проверка...";
    elements.serverStatus.className = "server-status server-status--checking";
    elements.checkBtn.disabled = true;

    // Применяем текущий URL из поля перед проверкой
    config.libreTranslateUrl = elements.serverUrl.value.trim().replace(/\/$/, "");

    const ok = await Translator.checkHealth();
    elements.checkBtn.disabled = false;

    if (ok) {
      elements.serverStatus.textContent = "✓ Сервер доступен";
      elements.serverStatus.className = "server-status server-status--ok";
    } else {
      elements.serverStatus.textContent = "✗ Сервер недоступен";
      elements.serverStatus.className = "server-status server-status--error";
    }
  }

  function startTranslation() {
    if (isActive) return;
    isActive = true;

    elements.startBtn.disabled = true;
    elements.stopBtn.disabled = false;
    setStatus("Слушаю...");

    const langs = LANG_CODES[config.translationDirection];

    SpeechRecognizer.start({
      lang: langs.source,
      pauseDuration: config.pauseDuration,

      onInterim: (text) => {
        elements.sourceText.textContent = text;
      },

      onFinal: async (text) => {
        elements.sourceText.textContent = text;
        setStatus("Перевожу...");

        try {
          const { translatedText } = await Translator.translate(
            text,
            langs.srcCode,
            langs.tgtCode
          );

          elements.targetText.textContent = translatedText;
          setStatus("Озвучиваю...");

          SpeechSynthesizer.speak(
            translatedText,
            langs.target,
            config.voiceGender,
            config.speechRate
          );

          setStatus("Слушаю...");
        } catch (err) {
          setStatus(`Ошибка: ${err.message}`, true);
        }
      },

      onError: (msg) => {
        setStatus(msg, true);
        stopTranslation();
      }
    });
  }

  function stopTranslation() {
    if (!isActive) return;
    isActive = false;

    SpeechRecognizer.stop();
    window.speechSynthesis.cancel();

    elements.startBtn.disabled = false;
    elements.stopBtn.disabled = true;
    setStatus("Остановлено");
  }

  function setStatus(msg, isError = false) {
    elements.statusEl.textContent = msg;
    elements.statusEl.className = "status" + (isError ? " status--error" : "");
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", App.init);
