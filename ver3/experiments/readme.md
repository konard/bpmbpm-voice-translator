# Эксперименты: диагностика Bergamot WASM

Эта папка содержит экспериментальные скрипты для диагностики и воспроизведения проблем с WASM-движком.

## Запуск

Откройте страницу через локальный HTTP-сервер (не через `file://`):

```sh
# Из корня репозитория:
python3 -m http.server 8080
# Затем откройте: http://localhost:8080/ver3/experiments/test-worker-blob.html
```

## Файлы

| Файл | Описание |
|------|----------|
| `test-worker-blob.html` | Проверяет работу `importScripts` из Blob-воркера с абсолютным URL. Воспроизводит проблему с relative URL и демонстрирует исправление через `workerBaseUrl`. |

## Основная проблема (решена в ver3_6c)

Blob-воркер имеет `self.location = blob:http://...`, поэтому все относительные пути
в `importScripts()` разрешаются относительно blob:-URL и не работают.

**Исправление**: передавать абсолютный `workerBaseUrl` через `options.workerBaseUrl`
при вызове `worker.initialize(options)`, и использовать его в `translator-worker.js`
для загрузки `bergamot-translator-worker.wasm` и `bergamot-translator-worker.js`.
