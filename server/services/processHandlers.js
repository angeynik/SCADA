// services/processHandlers.js
// Реакция процесса на сигналы и необработанные ошибки:
//   SIGTERM, SIGINT     — корректная остановка через lifecycle, код выхода 0 (1 — если
//                         остановка с ошибкой или по таймауту); повторный сигнал во время
//                         остановки — немедленный выход с кодом 1;
//   unhandledRejection  — запись в лог, процесс продолжает работу;
//   uncaughtException   — запись в лог, остановка и выход с кодом 1 (перезапуск — systemd);
//                         повторная во время остановки — немедленный выход с кодом 1.
// proc и exit передаются параметрами, чтобы проверять поведение без настоящего процесса.
'use strict';

const SIGNALS = ['SIGTERM', 'SIGINT'];

function installProcessHandlers({ proc = process, lifecycle, logger, exit = (code) => proc.exit(code) }) {
  let exiting = false;

  function shutdown(reason, failCode) {
    if (exiting) return;
    exiting = true;
    lifecycle.stop(reason)
      .then((res) => exit(failCode || (res && res.ok ? 0 : 1)))
      .catch((err) => {
        logger.logErrorMessage('[Process] - shutdown - ошибка остановки:', err);
        exit(1);
      });
  }

  const onSignal = (signal) => {
    if (exiting) {
      logger.logErrorMessage(`[Process] - signal - повторный ${signal}, принудительный выход`);
      exit(1);
      return;
    }
    shutdown(signal, 0);
  };

  const onRejection = (reason) => {
    logger.logErrorMessage('[Process] - unhandledRejection -', reason instanceof Error ? reason.stack : reason);
  };

  // Повторная фатальная ошибка во время остановки — немедленный выход: иначе ошибка,
  // возникающая на каждом шаге остановки, держала бы процесс живым бесконечно
  let fatal = false;
  const onException = (err) => {
    if (fatal) {
      exit(1);
      return;
    }
    fatal = true;
    logger.logErrorMessage('[Process] - uncaughtException -', err && err.stack ? err.stack : err);
    shutdown('uncaughtException', 1);
  };

  const handlers = SIGNALS.map((s) => [s, onSignal]);
  handlers.push(['unhandledRejection', onRejection], ['uncaughtException', onException]);
  for (const [event, fn] of handlers) proc.on(event, fn);

  // Снять обработчики (для тестов)
  return () => {
    for (const [event, fn] of handlers) proc.removeListener(event, fn);
  };
}

module.exports = { installProcessHandlers };
