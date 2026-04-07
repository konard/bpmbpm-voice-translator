# Развёртывание LibreTranslate (self-hosted)

## Обзор

[LibreTranslate](https://github.com/LibreTranslate/LibreTranslate) — свободный и открытый движок машинного перевода. В отличие от облачных API, он работает полностью на вашем сервере: данные не передаются третьим лицам.

Данное руководство охватывает три способа развёртывания:

1. **Docker** — рекомендуется для большинства случаев
2. **Python / pip** — подходит, если Docker недоступен
3. **Docker Compose** — удобно для production с автозапуском

---

## Системные требования

| Компонент     | Минимум              | Рекомендуется        |
|---------------|----------------------|----------------------|
| CPU           | 2 ядра               | 4+ ядра              |
| RAM           | 2 ГБ (только en↔ru)  | 4+ ГБ (все языки)    |
| Диск          | 1 ГБ на языковую пару | SSD, 5–10 ГБ        |
| ОС            | Linux, macOS, Windows (WSL2) | Ubuntu 22.04 LTS |
| Docker        | 20.10+               | последняя версия     |
| Python        | 3.8+                 | 3.11+               |

---

## Способ 1: Docker (рекомендуется)

### Установка Docker

**Ubuntu / Debian:**
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
  sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER   # чтобы не использовать sudo каждый раз
```

**macOS:**
Установите [Docker Desktop](https://www.docker.com/products/docker-desktop/).

**Windows:**
Установите [Docker Desktop с WSL2](https://docs.docker.com/desktop/install/windows-install/).

---

### Запуск LibreTranslate

**Быстрый старт — только русский и английский языки:**
```bash
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  -e LT_LOAD_ONLY=en,ru \
  libretranslate/libretranslate
```

> Первый запуск скачивает языковые модели (~300 МБ для en+ru). Это занимает 1–3 минуты в зависимости от скорости интернета.

**Запуск со всеми языками:**
```bash
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  libretranslate/libretranslate
```

**Запуск с сохранением моделей между перезапусками:**
```bash
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  -v libretranslate_data:/home/libretranslate/.local \
  -e LT_LOAD_ONLY=en,ru \
  libretranslate/libretranslate
```

---

### Управление контейнером

```bash
# Проверить статус
docker ps

# Посмотреть логи (в т.ч. прогресс загрузки моделей)
docker logs -f libretranslate

# Остановить
docker stop libretranslate

# Запустить снова
docker start libretranslate

# Удалить контейнер
docker rm -f libretranslate
```

---

### Проверка работы

После запуска откройте в браузере:
```
http://localhost:5000
```

Или проверьте через curl:
```bash
curl -s http://localhost:5000/languages | python3 -m json.tool
```

Тест перевода:
```bash
curl -s -X POST http://localhost:5000/translate \
  -H "Content-Type: application/json" \
  -d '{"q":"Hello world","source":"en","target":"ru","format":"text"}' | \
  python3 -m json.tool
```

Ожидаемый ответ:
```json
{
  "translatedText": "Привет мир"
}
```

---

## Способ 2: Python / pip

Если Docker недоступен, можно установить LibreTranslate через pip.

### Установка

```bash
# Создать виртуальное окружение (рекомендуется)
python3 -m venv venv
source venv/bin/activate   # Linux/macOS
# venv\Scripts\activate     # Windows

# Установить LibreTranslate
pip install libretranslate
```

### Запуск

```bash
# Только английский и русский:
libretranslate --load-only en,ru

# Все языки:
libretranslate

# На другом порту:
libretranslate --load-only en,ru --port 5001
```

> При первом запуске автоматически скачаются языковые модели.

### Запуск как фоновый процесс

```bash
nohup libretranslate --load-only en,ru > libretranslate.log 2>&1 &
echo $! > libretranslate.pid   # сохранить PID для последующей остановки

# Остановить:
kill $(cat libretranslate.pid)
```

---

## Способ 3: Docker Compose (production)

Docker Compose позволяет легко управлять конфигурацией и автоматически перезапускать сервис.

### Создание `docker-compose.yml`

```yaml
version: "3.8"

services:
  libretranslate:
    image: libretranslate/libretranslate:latest
    container_name: libretranslate
    restart: unless-stopped
    ports:
      - "5000:5000"
    volumes:
      - libretranslate_data:/home/libretranslate/.local
    environment:
      # Загружать только нужные языки (экономит RAM и диск)
      LT_LOAD_ONLY: "en,ru"
      # Отключить лимит запросов (для локального использования)
      LT_REQ_LIMIT: "0"
      # Включить API-ключ (раскомментируйте и укажите ключ при необходимости)
      # LT_API_KEYS: "true"

volumes:
  libretranslate_data:
```

### Запуск

```bash
# Запуск в фоне
docker compose up -d

# Просмотр логов
docker compose logs -f

# Остановка
docker compose down

# Обновление образа
docker compose pull && docker compose up -d
```

---

## Подключение к приложению (ver2)

После запуска LibreTranslate откройте `index.html` из папки `ver2` в браузере.

В блоке **Настройки → LibreTranslate сервер** укажите URL:

| Сценарий                             | URL                          |
|--------------------------------------|------------------------------|
| Локальный (Docker/pip на той же машине) | `http://localhost:5000`   |
| Другой ПК в локальной сети           | `http://192.168.1.X:5000`    |
| Удалённый сервер с HTTPS             | `https://translate.example.com` |

Нажмите **«Проверить»** — должно появиться сообщение «✓ Сервер доступен».

> **Важно:** Если приложение открыто по `https://`, браузер заблокирует запросы к `http://`. В этом случае LibreTranslate тоже должен работать по HTTPS (с SSL-сертификатом).

---

## Настройка HTTPS с Nginx (для production)

Если LibreTranslate нужен с HTTPS:

### Установка Nginx и Certbot

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### Конфигурация Nginx (`/etc/nginx/sites-available/libretranslate`)

```nginx
server {
    listen 80;
    server_name translate.example.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # CORS — разрешить запросы из браузера
        add_header Access-Control-Allow-Origin "*";
        add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
        add_header Access-Control-Allow-Headers "Content-Type, Authorization";
        if ($request_method = OPTIONS) {
            return 204;
        }
    }
}
```

### Активация и SSL

```bash
sudo ln -s /etc/nginx/sites-available/libretranslate /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Получить SSL-сертификат Let's Encrypt
sudo certbot --nginx -d translate.example.com
```

---

## Настройка API-ключей (опционально)

По умолчанию LibreTranslate работает без аутентификации. Чтобы ограничить доступ:

**Docker:**
```bash
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  -e LT_LOAD_ONLY=en,ru \
  -e LT_API_KEYS=true \
  libretranslate/libretranslate
```

**Создание API-ключа:**
```bash
docker exec libretranslate ltmanage keys add 120   # 120 req/min
```

Команда выведет сгенерированный ключ — скопируйте его и укажите в поле **«API-ключ»** в настройках приложения.

---

## Решение типичных проблем

### Сервер не отвечает

```bash
# Проверить, запущен ли контейнер
docker ps | grep libretranslate

# Проверить, занят ли порт
sudo lsof -i :5000

# Проверить логи на ошибки
docker logs libretranslate | tail -50
```

### Ошибка CORS в браузере

LibreTranslate по умолчанию отправляет заголовки CORS. Если возникла ошибка CORS:

- Убедитесь, что запросы идут к правильному URL (без опечаток)
- Если используется Nginx-прокси, проверьте наличие заголовков `Access-Control-Allow-Origin` в конфиге

### Модели ещё не загружены

Сервер доступен, но перевод не работает — посмотрите логи:
```bash
docker logs -f libretranslate
```
Дождитесь появления сообщения `Running on http://0.0.0.0:5000`.

### Мало RAM

Если контейнер вылетает из-за нехватки памяти:
```bash
# Ограничить загрузку языков только en и ru
docker run -d \
  --name libretranslate \
  -p 5000:5000 \
  -e LT_LOAD_ONLY=en,ru \
  -m 2g \
  libretranslate/libretranslate
```

### Медленный перевод

- Убедитесь, что сервер запущен на одной машине с браузером
- Рассмотрите запуск с GPU (если есть поддержка CUDA): добавьте `--gpus all` к команде docker

---

## Переменные окружения LibreTranslate

| Переменная           | Значение по умолчанию | Описание                                      |
|----------------------|-----------------------|-----------------------------------------------|
| `LT_LOAD_ONLY`       | все языки             | Загрузить только указанные языки (напр. `en,ru`) |
| `LT_PORT`            | `5000`                | Порт HTTP-сервера                             |
| `LT_HOST`            | `0.0.0.0`             | Адрес для прослушивания                       |
| `LT_API_KEYS`        | `false`               | Включить обязательную аутентификацию по ключу |
| `LT_REQ_LIMIT`       | `500`                 | Лимит запросов в сутки (0 = без лимита)       |
| `LT_THREADS`         | `4`                   | Число потоков перевода                        |
| `LT_SUGGESTIONS`     | `false`               | Разрешить пользователям предлагать исправления |

---

## Структура файлов ver2

```
ver2/
├── index.html          # Веб-интерфейс голосового переводчика
├── translator.js       # JS-логика: LibreTranslate API + Speech API
├── install.md          # Данное руководство по установке
└── alternatives_2.md   # Обзор self-hosted подходов с JS-библиотеками
```
