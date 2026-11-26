# Сервер SCADA BMS

Сервер верхнего уровня BMS: Modbus TCP (ОВЕН), BACnet/IP (Metasys N30), OPC UA, архив, тревоги, WebSocket для клиента.

- Правила разработки — [rules.md](rules.md)
- План работ — [PLAN.md](PLAN.md)

## Запуск

Нужен Node.js 24.9 или новее (LTS 24).

```bash
npm install
cp conf.env.example conf.env   # и поправить под объект
mkdir -p data && cp -r config/example data/config   # конфигурация объекта, формат — docs/model.md
node tools/checkModel.js       # проверка конфигурации без запуска сервера
npm start                      # остановка — Ctrl+C или SIGTERM
npm run dev                    # перезапуск при изменении файлов
```

## Работа без контроллеров

```bash
node tools/modbusEmulator.js --map owen-ahu-v1 --count 80 --write-instances data/config/instances/emu.json
node tools/modbusDiag.js --instance EMU-01     # проверка одной установки
```

Подробно — [docs/modbus-tcp.md](docs/modbus-tcp.md), BACnet — [docs/bacnet.md](docs/bacnet.md).

## OPC UA

Сервер слушает `opc.tcp://<имя машины>:4840`. Новый клиент сначала отклоняется, доверие — вручную:

```bash
node tools/opcuaPki.js list            # отклонённые клиенты с отпечатками
node tools/opcuaPki.js trust <отпечаток>
```

Вход — по имени и паролю пользователей сервера. Подробно — [docs/opcua.md](docs/opcua.md).

## Пользователи

Нужен PostgreSQL: `PG_URL` в `conf.env` (без пароля; пароль — `PGPASSWORD` или `~/.pgpass`). Таблицы сервер создаёт сам. Для разработки — эмулятор: `npm run pg:start` печатает `PG_URL`, `npm run test:pg` — тесты вместе с БД.

```bash
node tools/userAdmin.js add admin --role admin     # первый администратор
node tools/userAdmin.js list
```

Роли, журнал и путь записи — [docs/users.md](docs/users.md).

## Тесты

```bash
npm test                  # весь набор (не npx jest: нужен флаг для node-opcua)
npm run test:pg           # вместе с тестами PostgreSQL (эмулятор, docs/users.md)
npm run test:unit         # только юнит-тесты
npm run test:integration  # только интеграционные
```
