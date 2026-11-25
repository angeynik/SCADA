// drivers/modbusTcp/transport.js
// Соединение Modbus TCP с одним контроллером поверх modbus-serial.
// Сокет создаётся здесь, а не в библиотеке: так подключение к недоступному адресу
// гарантированно прерывается через connectTimeoutMs, а закрытие уничтожает сокет.
//
// Ошибки нормализуются в ModbusError:
//   kind 'exception' — контроллер ответил кодом исключения Modbus (modbusCode), связь есть;
//   kind 'transport' — таймаут, обрыв, нет соединения.
// Запросы не должны пересекаться: очередь — в device.js.
'use strict';

const net = require('net');
const ModbusRTU = require('modbus-serial');

const EXCEPTIONS = {
  1: 'недопустимая функция',
  2: 'недопустимый адрес',
  3: 'недопустимое значение',
  4: 'отказ устройства',
  6: 'устройство занято',
};

class ModbusError extends Error {
  constructor(kind, message, modbusCode) {
    super(message);
    this.kind = kind;
    if (modbusCode !== undefined) this.modbusCode = modbusCode;
  }
}

function normalize(err) {
  if (err instanceof ModbusError) return err;
  if (err && err.modbusCode !== undefined) {
    const text = EXCEPTIONS[err.modbusCode] || 'исключение';
    return new ModbusError('exception', `исключение Modbus ${err.modbusCode} (${text})`, err.modbusCode);
  }
  const msg = err && err.errno === 'ETIMEDOUT' ? 'нет ответа (таймаут)' : (err && err.message) || String(err);
  return new ModbusError('transport', msg);
}

const READ = {
  coil: 'readCoils',
  discrete: 'readDiscreteInputs',
  holding: 'readHoldingRegisters',
  input: 'readInputRegisters',
};

function createTcpTransport({ host, port, timeoutMs = 1000, connectTimeoutMs = 3000 }) {
  let client = null;
  let socket = null;
  let closeHandler = null;

  function connect() {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new ModbusError('transport', `нет подключения за ${connectTimeoutMs} мс`));
      }, connectTimeoutMs);
      s.once('error', (err) => {
        clearTimeout(timer);
        s.destroy();
        reject(new ModbusError('transport', err.code || err.message));
      });
      s.once('connect', () => {
        clearTimeout(timer);
        s.removeAllListeners('error');
        s.setNoDelay(true);
        const c = new ModbusRTU();
        c.setTimeout(timeoutMs);
        c.connectTCP(host, { port, socket: s })
          .then(() => {
            socket = s;
            client = c;
            // Ошибки сокета после подключения проявятся как обрыв (close)
            s.on('error', () => {});
            c.on('close', () => {
              const wasOpen = client === c;
              client = null;
              socket = null;
              if (wasOpen && closeHandler) closeHandler();
            });
            resolve();
          })
          .catch((err) => {
            s.destroy();
            reject(normalize(err));
          });
      });
    });
  }

  async function call(unitId, fn) {
    if (!client) throw new ModbusError('transport', 'нет соединения');
    client.setID(unitId);
    try {
      return await fn(client);
    } catch (err) {
      throw normalize(err);
    }
  }

  return {
    connect,
    isOpen: () => client !== null,
    onClose: (fn) => { closeHandler = fn; },
    read: (unitId, area, address, length) => call(unitId, async (c) => {
      const res = await c[READ[area]](address, length);
      return res.data.slice(0, length);
    }),
    writeCoil: (unitId, address, state) => call(unitId, (c) => c.writeCoil(address, state)),
    writeRegister: (unitId, address, value) => call(unitId, (c) => c.writeRegister(address, value)),
    writeRegisters: (unitId, address, values) => call(unitId, (c) => c.writeRegisters(address, values)),
    // Закрытие по инициативе сервера: обработчик onClose не вызывается
    close() {
      client = null;
      if (socket) socket.destroy();
      socket = null;
    },
  };
}

module.exports = { createTcpTransport, ModbusError, normalize };
