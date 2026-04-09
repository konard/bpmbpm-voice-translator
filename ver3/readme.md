# Голосовой переводчик ver3 — Bergamot WASM (self-hosted)
https://github.com/bpmbpm/voice-translator/pull/6
## Описание

Голосовой переводчик на базе нейросетевого движка **Bergamot** (Mozilla), работающего в браузере через WebAssembly. Перевод выполняется **полностью локально**, без обращения к внешним серверам перевода. Интернет нужен только для первой загрузки модели (~15 МБ), после чего она кэшируется браузером.

## Особенности

- **Self-hosted перевод**: нейросетевая модель запускается в браузере через WASM
- **Без серверной части**: статические файлы, работает на GitHub Pages и локально
- **Конфиденциальность**: переводимый текст не покидает браузер
- **Автономность**: после первой загрузки работает без интернета
- **Резервный режим**: при недоступности WASM-движка используется MyMemory API
- **Поддержка**: Русский ↔ Английский

## Как запустить

### Локально (простейший способ)

```bash
# Python 3
python -m http.server 8000
# открыть http://localhost:8000
```

Или любой другой локальный веб-сервер. Браузер на `localhost` не требует HTTPS для API микрофона.

### На GitHub Pages

Просто разместите файлы папки `ver3/` в репозитории с включёнными GitHub Pages. Заголовки COOP/COEP, необходимые для SharedArrayBuffer, устанавливаются автоматически через `coi-serviceworker.js`.  

#### run 
- github pages https://bpmbpm.github.io/voice-translator/ver3/index.html
- test https://bpmbpm.github.io/voice-translator/ver3/test/index.html

## Структура файлов

```
ver3/
├── index.html              # Главная страница
├── translator.js           # Основная логика (ES-модуль)
├── coi-serviceworker.js    # Установка COOP/COEP через Service Worker (для GitHub Pages)
├── readme.md               # Данный файл
├── architecture_3.md       # Подробная архитектура решения
└── alternatives_3.md       # Альтернативные подходы
```

## Технологии

| Компонент | Технология |
|-----------|-----------|
| Распознавание речи | Web Speech API (SpeechRecognition) |
| Перевод (основной) | Bergamot WASM (@browsermt/bergamot-translator) |
| Перевод (резервный) | MyMemory REST API |
| Синтез речи | Web Speech API (SpeechSynthesis) |
| COOP/COEP headers | coi-serviceworker |
| Хостинг | GitHub Pages / локально |

## Требования к браузеру

- Chrome 88+ или Edge 88+ (для SpeechRecognition)
- Разрешение на использование микрофона
- ~15 МБ свободного места в кэше браузера (на каждое направление)

## Сравнение с предыдущими версиями

| | ver1 (MyMemory) | ver2 (LibreTranslate) | ver3 (Bergamot) |
|-|-|-|-|
| Серверная часть | нет | требуется | нет |
| Конфиденциальность | низкая | средняя | высокая |
| Качество перевода | среднее | высокое | высокое (нейросеть) |
| Работа без интернета | нет | нет | да (после загрузки) |
| GitHub Pages | да | нет | да |
