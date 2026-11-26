// services/commandGateway.js
// Единственный путь записи в контроллеры: OPC UA, WebSocket, расписания, сценарии.
//
// createCommandGateway({ tagStore, drivers, journal, logger, isPrimary })
//   drivers — Map: имя драйвера ('modbus' | 'bacnet') → драйвер (контракт rules.md);
//     драйвера нет (выключен) — команда получает NOT_CONNECTED;
//   isPrimary() — роль узла (services/redundancy, этап 9); по умолчанию узел основной.
//
// execute({ tagId, value, user, source }) → { ok: true, value } | { ok: false, code, message }
// release({ tagId, user, source }) — снятие команды (BACnet: NULL в свой приоритет).
//   user — { username, role, level } из auth или null (анонимно — запись запрещена).
//
// Порядок проверки (rules.md, «Команды и запись»):
//   тег есть (NOT_FOUND) и access rw (READ_ONLY) → уровень пользователя ≥ writeLevel (FORBIDDEN)
//   → тип (TYPE_MISMATCH), min/max и states (OUT_OF_RANGE) → узел основной (NOT_PRIMARY)
//   → драйвер: запись и подтверждение чтением (NOT_CONNECTED, OUT_OF_RANGE, WRITE_FAILED)
//   → журнал. tagStore обновляет драйвер значением из подтверждения, поэтому клиенты видят
//   то, что реально в контроллере, а при отказе значение не меняется.
// Каждая попытка, в том числе отклонённая, попадает в журнал.
// После stop() (остановка сервера) команды не принимаются: NOT_CONNECTED.
'use strict';

const { fitsType } = require('../core/tagStore');

function createCommandGateway({ tagStore, drivers = new Map(), journal, logger, isPrimary = () => true }) {
  let accepting = true;
  let inFlight = 0;

  function check(tagId, value, user, { release = false } = {}) {
    const tag = tagStore.tag(tagId);
    if (!tag) return { code: 'NOT_FOUND', message: `тег ${tagId} не найден` };
    if (tag.access !== 'rw') return { code: 'READ_ONLY', message: `${tagId} только для чтения` };
    if (!user) return { code: 'FORBIDDEN', message: 'запись разрешена только после входа' };
    if (!(user.level >= tag.writeLevel)) {
      return { code: 'FORBIDDEN', message: `недостаточно прав: нужен уровень ${tag.writeLevel}, у ${user.username} — ${user.level}` };
    }
    if (!release) {
      if (!fitsType(tag.dataType, value)) return { code: 'TYPE_MISMATCH', message: `значение ${JSON.stringify(value)} не подходит к типу ${tag.dataType}` };
      if (tag.states && !(String(value) in tag.states)) {
        return { code: 'OUT_OF_RANGE', message: `нет состояния ${value}, допустимо: ${Object.keys(tag.states).join(', ')}` };
      }
      if (tag.min !== undefined && value < tag.min) return { code: 'OUT_OF_RANGE', message: `${value} меньше ${tag.min}` };
      if (tag.max !== undefined && value > tag.max) return { code: 'OUT_OF_RANGE', message: `${value} больше ${tag.max}` };
    }
    if (!isPrimary()) return { code: 'NOT_PRIMARY', message: 'узел резервный, команды принимает основной' };
    const driver = drivers.get(tag.source.driver);
    if (!driver) return { code: 'NOT_CONNECTED', message: `драйвер ${tag.source.driver} выключен` };
    if (release && typeof driver.release !== 'function') {
      return { code: 'NOT_SUPPORTED', message: `снятие команды не поддерживается драйвером ${tag.source.driver}` };
    }
    return { driver };
  }

  async function run(action, { tagId, value, user = null, source = '?' }) {
    const release = action === 'release';
    const prev = tagStore.get(tagId);
    let result;
    if (!accepting) {
      result = { ok: false, code: 'NOT_CONNECTED', message: 'сервер останавливается' };
    } else {
      const c = check(tagId, value, user, { release });
      if (!c.driver) {
        result = { ok: false, code: c.code, message: c.message };
      } else {
        inFlight += 1;
        try {
          result = await (release ? c.driver.release(tagId) : c.driver.write(tagId, value));
        } catch (err) {
          logger.logErrorMessage(`[CommandGateway] - ${action} - ${tagId}:`, err);
          result = { ok: false, code: 'WRITE_FAILED', message: err.message };
        } finally {
          inFlight -= 1;
        }
      }
    }
    await journal.record({
      username: user && user.username,
      source,
      action,
      tagId,
      oldValue: prev ? prev.value : null,
      newValue: release ? null : value,
      ok: result.ok,
      code: result.ok ? null : result.code,
      message: result.ok ? (result.value !== value && !release ? `подтверждено ${JSON.stringify(result.value)}` : null) : result.message,
    });
    return result.ok ? { ok: true, value: result.value } : { ok: false, code: result.code, message: result.message };
  }

  return {
    execute: (cmd) => run('write', cmd),
    release: (cmd) => run('release', cmd),
    // Проверка без записи: можно ли пользователю писать тег (для UserAccessLevel и интерфейса)
    canWrite(tagId, user) {
      const tag = tagStore.tag(tagId);
      return Boolean(tag && tag.access === 'rw' && user && user.level >= tag.writeLevel);
    },
    start() {
      accepting = true;
    },
    // Остановка: новые команды отклоняются, начатые дожидаются (не дольше таймаута lifecycle)
    async stop() {
      accepting = false;
      while (inFlight > 0) await new Promise((r) => setTimeout(r, 20));
    },
    status: () => ({ accepting, inFlight }),
  };
}

module.exports = { createCommandGateway };
