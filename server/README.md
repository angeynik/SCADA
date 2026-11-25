# Сервер SCADA BMS

Сервер верхнего уровня BMS: Modbus TCP (ОВЕН), BACnet/IP (Metasys N30), OPC UA, архив, тревоги, WebSocket для клиента.

- Правила разработки — [rules.md](rules.md)
- План работ — [PLAN.md](PLAN.md)

## Запуск

Нужен Node.js 22 или новее.

```bash
npm install
cp conf.env.example conf.env   # и поправить под объект
mkdir -p data && cp -r config/example data/config   # конфигурация объекта, формат — docs/model.md
node tools/checkModel.js       # проверка конфигурации без запуска сервера
npm start                      # остановка — Ctrl+C или SIGTERM
npm run dev                    # перезапуск при изменении файлов
```

## Тесты

```bash
npm test                  # весь набор
npm run test:unit         # только юнит-тесты
npm run test:integration  # только интеграционные
```
