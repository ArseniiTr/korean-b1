# Серверная часть на Cloudflare Workers + D1

Замена Supabase Edge Function `tutor`: тот же JSON-API и те же коды ошибок, сайт меняет только константу `API` в `index.html`.
Бесплатный тариф Cloudflare: воркер не засыпает, 100 000 запросов в день, D1 — 5 ГБ и 5 млн чтений в день. Для одного ученика этого хватает с большим запасом.

## Где живут данные
База — Cloudflare D1 `korean-b1` (SQLite), схема в `schema.sql`:
- `app_config` — хеш кода доступа (`pin_hash`) и ключ Anthropic (`anthropic_api_key`), который пользователь вводит один раз в приложении;
- `sessions` — токены входа (180 дней);
- `progress` — состояние учебника одним JSON (id = `me`);
- `progress_backup` — снимки `progress` перед перезаписью (действие `save`: не чаще раза в час или при резком уменьшении данных; хранятся последние 60; действия `backups` и `restore`);
- `attempts` — журнал ответов на упражнения;
- `ai_calls` — учёт токенов запросов к Anthropic.

Ключ Anthropic можно хранить и секретом воркера (`npx wrangler secret put ANTHROPIC_API_KEY`) — тогда он имеет приоритет над `app_config`.

## Первый деплой (делает владелец аккаунта Cloudflare)
Нужен Node.js (есть в Homebrew: `brew install node`). Все команды — из папки `worker`.

```bash
npm install
npx wrangler login                 # откроет браузер, войти в Cloudflare
npx wrangler d1 create korean-b1   # в выводе будет database_id — вставить в wrangler.toml
```

После вставки `database_id` в `wrangler.toml`:

```bash
npm run db:schema                  # создать таблицы
npm run db:import                  # перенести данные из Supabase (файл migration/data.sql, он не в git)
npm run deploy                     # напечатает адрес вида https://korean-b1-tutor.<аккаунт>.workers.dev
```

Проверка: `curl https://korean-b1-tutor.<аккаунт>.workers.dev` должен вернуть `{"service":"korean-b1 tutor API",...,"ai":true}`.
Затем адрес подставляется в константу `API` в `index.html`.

## Обновление воркера
`npm run deploy` из папки `worker`. Проверка типов: `npm run typecheck`. Локальный запуск с локальной D1: `npm run db:schema:local`, затем `npm run dev`.

## Миграция данных из Supabase
`migration/data.sql` — выгрузка таблиц старого проекта Supabase (`fdrsevvkkzogljgelcrv`) в виде `INSERT OR REPLACE`. Файл содержит хеш кода, токены сессий и ключ Anthropic, поэтому исключён из git (`.gitignore`); после импорта его можно удалить. Старый проект Supabase можно удалить после того, как сайт заработал через воркер.
