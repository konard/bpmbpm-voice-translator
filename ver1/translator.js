/**
 * Голосовой переводчик — основной JS-модуль
 * Использует стандартные браузерные API: SpeechRecognition и SpeechSynthesis
 * Перевод: MyMemory REST API (бесплатно, без ключа)
 */

// ============================================================
// Блок конфигурации (JSON-совместимая структура)
// ============================================================
const config = {
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

/** Соответствие направлений перевода языковым кодам для SpeechRecognition */
const LANG_CODES = {
  "ru-en": { source: "ru-RU", target: "en-US" },
  "en-ru": { source: "en-US", target: "ru-RU" }
};

/** URL MyMemory API */
const MYMEMORY_API = "https://api.mymemory.translated.net/get";

// ============================================================
// Модуль перевода (Translator)
// ============================================================
const Translator = {
  /**
   * Переводит текст через MyMemory API
   * @param {string} text — исходный текст
   * @param {string} langPair — языковая пара, например "ru|en"
   * @returns {Promise<{translatedText: string, transcription: string}>}
   */
  async translate(text, langPair) {
    const url = `${MYMEMORY_API}?q=${encodeURIComponent(text)}&langpair=${langPair}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Ошибка сети: ${response.status}`);
    }
    const data = await response.json();
    if (data.responseStatus !== 200) {
      throw new Error(`Ошибка перевода: ${data.responseDetails}`);
    }
    const translatedText = data.responseData.translatedText;
    // Транскрипция возвращается в matches[0].translation при наличии
    const transcription = data.matches?.[0]?.translation || "";
    return { translatedText, transcription };
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
    // Прерываем текущее воспроизведение, если оно идёт
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = rate;

    // Ищем голос нужного пола и языка
    const voices = window.speechSynthesis.getVoices();
    const matchingVoices = voices.filter(v => v.lang.startsWith(lang.split("-")[0]));
    const genderKeyword = gender === "female"
      ? ["female", "woman", "женский", "female"]
      : ["male", "man", "мужской"];

    // Эвристический поиск голоса по полу через имя
    const genderVoice = matchingVoices.find(v =>
      genderKeyword.some(kw => v.name.toLowerCase().includes(kw))
    );
    // Если подходящий голос не найден — используем первый доступный для языка
    utterance.voice = genderVoice || matchingVoices[0] || null;

    window.speechSynthesis.speak(utterance);
  }
};

// ============================================================
// Модуль распознавания речи (SpeechRecognizer)
// ============================================================
const SpeechRecognizer = (() => {
  let recognition = null;   // Объект SpeechRecognition
  let pauseTimer = null;    // Таймер паузы
  let interimText = "";     // Промежуточный текст
  let finalText = "";       // Финальный накопленный текст блока
  let isRunning = false;    // Флаг активного распознавания

  /**
   * Инициализирует и запускает распознавание
   * @param {object} opts — параметры: lang, pauseDuration, onInterim, onFinal, onError
   */
  function start({ lang, pauseDuration, onInterim, onFinal, onError }) {
    const SpeechRecognitionAPI =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      onError("SpeechRecognition не поддерживается в вашем браузере. Используйте Chrome или Edge.");
      return;
    }

    recognition = new SpeechRecognitionAPI();
    recognition.lang = lang;
    recognition.continuous = true;      // Не останавливаемся после первой фразы
    recognition.interimResults = true;  // Получаем промежуточные результаты

    finalText = "";
    interimText = "";
    isRunning = true;

    // Обработка результатов распознавания
    recognition.onresult = (event) => {
      interimText = "";
      // Перебираем результаты, начиная с нового
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interimText += result[0].transcript;
        }
      }
      // Передаём промежуточный текст в UI
      onInterim(finalText + interimText);

      // Сбрасываем таймер паузы при каждом новом слове
      clearTimeout(pauseTimer);
      pauseTimer = setTimeout(() => {
        // По паузе — финализируем блок речи
        const blockText = (finalText + interimText).trim();
        if (blockText) {
          onFinal(blockText);
          finalText = "";
          interimText = "";
        }
      }, pauseDuration);
    };

    recognition.onerror = (event) => {
      // Игнорируем "no-speech" — это штатная ситуация
      if (event.error !== "no-speech") {
        onError(`Ошибка распознавания: ${event.error}`);
      }
    };

    // При автоматической остановке — перезапускаем, если ещё активны
    recognition.onend = () => {
      if (isRunning) {
        recognition.start();
      }
    };

    recognition.start();
  }

  /** Останавливает распознавание */
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
  let isActive = false;  // Приложение активно?

  // Ссылки на элементы DOM
  const elements = {};

  /** Инициализация приложения после загрузки DOM */
  function init() {
    elements.startBtn    = document.getElementById("startBtn");
    elements.stopBtn     = document.getElementById("stopBtn");
    elements.statusEl    = document.getElementById("status");
    elements.sourceText  = document.getElementById("sourceText");
    elements.targetText  = document.getElementById("targetText");
    elements.transcription = document.getElementById("transcription");
    elements.configPanel = document.getElementById("configPanel");
    elements.dirSelect   = document.getElementById("dirSelect");
    elements.genderSelect = document.getElementById("genderSelect");
    elements.rateInput   = document.getElementById("rateInput");
    elements.pauseInput  = document.getElementById("pauseInput");
    elements.rateValue   = document.getElementById("rateValue");
    elements.pauseValue  = document.getElementById("pauseValue");

    // Загрузить текущую конфигурацию в UI
    loadConfigToUI();

    // Обработчики событий
    elements.startBtn.addEventListener("click", startTranslation);
    elements.stopBtn.addEventListener("click", stopTranslation);

    // Обновление значений конфигурации при изменении ползунков
    elements.rateInput.addEventListener("input", () => {
      elements.rateValue.textContent = elements.rateInput.value;
    });
    elements.pauseInput.addEventListener("input", () => {
      elements.pauseValue.textContent = elements.pauseInput.value + " мс";
    });

    // Применение конфигурации
    document.getElementById("applyConfig").addEventListener("click", applyConfig);
  }

  /** Загружает config в элементы управления */
  function loadConfigToUI() {
    elements.dirSelect.value = config.translationDirection;
    elements.genderSelect.value = config.voiceGender;
    elements.rateInput.value = config.speechRate;
    elements.rateValue.textContent = config.speechRate;
    elements.pauseInput.value = config.pauseDuration;
    elements.pauseValue.textContent = config.pauseDuration + " мс";
  }

  /** Применяет настройки из UI в config */
  function applyConfig() {
    config.translationDirection = elements.dirSelect.value;
    config.voiceGender = elements.genderSelect.value;
    config.speechRate = parseFloat(elements.rateInput.value);
    config.pauseDuration = parseInt(elements.pauseInput.value, 10);

    setStatus("Настройки применены");

    // Если перевод активен — перезапускаем с новыми настройками
    if (isActive) {
      stopTranslation();
      setTimeout(startTranslation, 300);
    }
  }

  /** Запуск перевода */
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

      // Промежуточный текст — отображаем сразу
      onInterim: (text) => {
        elements.sourceText.textContent = text;
      },

      // Финальный блок речи — переводим
      onFinal: async (text) => {
        elements.sourceText.textContent = text;
        setStatus("Перевожу...");

        // Формируем языковую пару для MyMemory
        const [srcLang, tgtLang] = config.translationDirection.split("-");
        const langPair = `${srcLang}|${tgtLang}`;

        try {
          const { translatedText, transcription } = await Translator.translate(text, langPair);

          elements.targetText.textContent = translatedText;
          elements.transcription.textContent = transcription
            ? `[${transcription}]`
            : "";

          setStatus("Озвучиваю...");

          // Озвучиваем перевод
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

  /** Остановка перевода */
  function stopTranslation() {
    if (!isActive) return;
    isActive = false;

    SpeechRecognizer.stop();
    window.speechSynthesis.cancel();

    elements.startBtn.disabled = false;
    elements.stopBtn.disabled = true;
    setStatus("Остановлено");
  }

  /**
   * Обновляет строку статуса
   * @param {string} msg — текст статуса
   * @param {boolean} isError — выделить как ошибку
   */
  function setStatus(msg, isError = false) {
    elements.statusEl.textContent = msg;
    elements.statusEl.className = "status" + (isError ? " status--error" : "");
  }

  return { init };
})();

// Запуск после загрузки DOM
document.addEventListener("DOMContentLoaded", App.init);
