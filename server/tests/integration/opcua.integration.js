// OPC UA-сервер (opcua/) с настоящим клиентом node-opcua по TCP на 127.0.0.1:
// модель, значения, подписка, безопасность, доверие сертификатам (tools/opcuaPki).
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const opcua = require('node-opcua');
const { loadModel } = require('../../core/modelLoader');
const { createTagStore } = require('../../core/tagStore');
const { createOpcUaServer } = require('../../opcua');
const { main: pkiMain } = require('../../tools/opcuaPki');
const { createFakeLogger } = require('../helpers/fakeLogger');
const { createFakeUserStore } = require('../helpers/fakeUserStore');
const { createAuthService } = require('../../services/auth');
const { createCommandGateway } = require('../../services/commandGateway');
const fx = require('../helpers/modelFixture');

const {
  OPCUAClient, OPCUACertificateManager, MessageSecurityMode, SecurityPolicy, UserTokenType,
  AttributeIds, DataType, StatusCodes, TimestampsToReturn, ClientSubscription, ClientMonitoredItem,
} = opcua;
const NS_URI = 'urn:scada-bms:model';

async function freeTcpPort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > until) throw new Error('условие не выполнилось');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const model = loadModel({ dir: fx.EXAMPLE_DIR });

describe('OPC UA-сервер', () => {
  let dir;
  let server;
  let store;
  let logger;
  let port;
  const clients = [];

  async function startServer(options = {}, extra = {}) {
    port = await freeTcpPort();
    logger = createFakeLogger();
    store = createTagStore({ tags: model.tags, logger });
    server = createOpcUaServer({
      model,
      tagStore: store,
      logger,
      version: { VERSION: '0.0.0.1', COMMIT: 'abc1234' },
      options: { port, host: '127.0.0.1', hostname: 'localhost', namespaceUri: NS_URI, pkiDir: path.join(dir, 'pki'), ...options },
      ...extra,
    });
    await server.start();
  }

  function client(options = {}) {
    const c = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 0 }, requestedSessionTimeout: 10000, ...options });
    clients.push(c);
    return c;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-opcua-'));
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.disconnect();
    if (server) await server.stop();
    server = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('режим разработки (OPCUA_ALLOW_INSECURE)', () => {
    let session;
    let ns;

    beforeEach(async () => {
      await startServer({ allowInsecure: true });
      const c = client();
      await c.connect(`opc.tcp://localhost:${port}`);
      session = await c.createSession();
      ns = (await session.readNamespaceArray()).indexOf(NS_URI);
    });

    test('модель здания: объект, установки, теги и тип', async () => {
      expect(ns).toBeGreaterThan(0);
      const objects = await session.browse('ns=0;i=85');
      expect(objects.references.map((r) => r.nodeId.toString())).toContain(`ns=${ns};s=B1`);
      const site = await session.browse(`ns=${ns};s=B1`);
      expect(site.references.map((r) => r.browseName.name)).toEqual(['AHU-01', 'AHU-02', 'AHU-17']);
      expect(site.references.every((r) => r.typeDefinition.toString() === `ns=${ns};s=type:AhuType`)).toBe(true);
      const ahu = await session.browse(`ns=${ns};s=B1/AHU-17`);
      expect(ahu.references.filter((r) => r.nodeClass === opcua.NodeClass.Variable)).toHaveLength(19);
      const desc = await session.read({ nodeId: `ns=${ns};s=B1/AHU-17/SupplyTempSp`, attributeId: AttributeIds.Description });
      expect(desc.value.value.text).toBe('Уставка температуры притока');
      expect(server.status()).toMatchObject({ running: true, namespaceIndex: ns, variables: 58, sessions: 1 });
      expect(server.status().endpoints).toEqual([`opc.tcp://localhost:${port}`]);
    });

    test('значения, качество и подписка', async () => {
      const id = `ns=${ns};s=B1/AHU-01/SupplyTemp`;
      expect((await session.read({ nodeId: id })).statusCode).toBe(StatusCodes.BadNotConnected);
      store.update('B1/AHU-01/SupplyTemp', 20.5);
      const dv = await session.read({ nodeId: id });
      expect(dv.statusCode).toBe(StatusCodes.Good);
      expect(dv.value).toMatchObject({ dataType: DataType.Float, value: 20.5 });

      const sub = ClientSubscription.create(session, { requestedPublishingInterval: 50, publishingEnabled: true });
      const item = ClientMonitoredItem.create(sub, { nodeId: id, attributeId: AttributeIds.Value },
        { samplingInterval: 0, queueSize: 10, discardOldest: true }, TimestampsToReturn.Both);
      const seen = [];
      item.on('changed', (v) => seen.push([v.value.value, v.statusCode.name]));
      await waitFor(() => seen.length >= 1);
      store.update('B1/AHU-01/SupplyTemp', 21.7);
      store.setQuality('B1/AHU-01/SupplyTemp', 'bad', 'COMM_ERROR');
      await waitFor(() => seen.length >= 3);
      expect(seen.slice(0, 3)).toEqual([[20.5, 'Good'], [expect.closeTo(21.7, 5), 'Good'], [expect.closeTo(21.7, 5), 'BadCommunicationError']]);
      await sub.terminate();
    });

    test('запись на этапе 4 запрещена', async () => {
      const res = await session.write({
        nodeId: `ns=${ns};s=B1/AHU-01/SupplyTempSp`,
        attributeId: AttributeIds.Value,
        value: { value: { dataType: DataType.Float, value: 22 } },
      });
      expect(res).toBe(StatusCodes.BadNotWritable);
      expect(store.get('B1/AHU-01/SupplyTempSp').value).toBeNull();
    });

    test('предупреждение о небезопасном режиме и сведения о сервере', async () => {
      expect(logger.lines.error.join('\n')).toMatch(/ВНИМАНИЕ: OPCUA_ALLOW_INSECURE=true/);
      expect(logger.lines.info.join('\n')).toMatch(/типов 1, установок 3, переменных 58/);
      const build = await session.read({ nodeId: 'ns=0;i=2260' }); // ServerStatus.BuildInfo
      expect(build.value.value).toMatchObject({ productName: 'SCADA BMS', softwareVersion: '0.0.0.1', buildNumber: 'abc1234' });
    });
  });

  describe('рабочий режим', () => {
    let clientPki;

    async function secureClient() {
      clientPki = clientPki || new OPCUACertificateManager({ rootFolder: path.join(dir, 'client-pki'), automaticallyAcceptUnknownCertificate: true });
      await clientPki.initialize();
      return client({
        securityMode: MessageSecurityMode.SignAndEncrypt,
        securityPolicy: SecurityPolicy.Basic256Sha256,
        clientCertificateManager: clientPki,
        applicationName: 'ScadaTestClient',
        applicationUri: 'urn:test:scada-client',
      });
    }

    afterEach(async () => {
      if (clientPki) await clientPki.dispose();
      clientPki = null;
    });

    test('только Sign/SignAndEncrypt и вход по имени и паролю', async () => {
      await startServer({ allowInsecure: false });
      const c = client();
      await c.connect(`opc.tcp://localhost:${port}`);
      const endpoints = await c.getEndpoints();
      expect(new Set(endpoints.map((e) => MessageSecurityMode[e.securityMode]))).toEqual(new Set(['Sign', 'SignAndEncrypt']));
      expect(endpoints.every((e) => e.userIdentityTokens.every((t) => t.tokenType === UserTokenType.UserName))).toBe(true);
      expect(new Set(endpoints.map((e) => e.securityPolicyUri.split('#')[1])))
        .toEqual(new Set(['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss']));
      await c.disconnect();
      // Без шифрования подключиться нельзя
      await expect(client().connect(`opc.tcp://localhost:${port}`).then(() => null)).resolves.toBeNull();
      const plain = clients[clients.length - 1];
      await expect(plain.createSession()).rejects.toThrow();
      expect(logger.lines.info.join('\n')).toMatch(/пользователи не подключены \(PG_URL\)/);
    });

    test('новый клиент не допущен, после доверия — вход по паролю', async () => {
      const userStore = createFakeUserStore({ operator: { password: 'secret', role: 'operator' } });
      await startServer({ allowInsecure: false }, { auth: createAuthService({ userStore, logger: createFakeLogger() }) });
      const pki = path.join(dir, 'pki');

      const first = await secureClient();
      await expect(first.connect(`opc.tcp://localhost:${port}`)).rejects.toThrow(/BadSecurityChecksFailed|rejected/);
      expect(logger.lines.info.join('\n')).toMatch(/клиент не допущен \(BadCertificateUntrusted\): ScadaTestClient@\S+ \[[0-9a-f]{40}\]/);

      const out = [];
      expect(pkiMain(['n', 't', 'list', '--pki', pki], (s) => out.push(s))).toBe(0);
      const listing = out.join('');
      expect(listing).toMatch(/Сертификат сервера: 1/);
      expect(listing).toMatch(/Отклонённые \(ждут решения\): 1\n {2}[0-9a-f]{40} {2}ScadaTestClient@\S+ {2}urn:test:scada-client/);
      const thumb = listing.match(/Отклонённые[^\n]*\n {2}([0-9a-f]{40})/)[1];
      out.length = 0;
      expect(pkiMain(['n', 't', 'trust', thumb.slice(0, 8), '--pki', pki], (s) => out.push(s))).toBe(0);
      expect(out.join('')).toMatch(new RegExp(`Доверен: ${thumb}`));

      const second = await secureClient();
      await waitFor(async () => {
        try {
          await second.connect(`opc.tcp://localhost:${port}`);
          return true;
        } catch {
          return false;
        }
      }, 10000);
      await expect(second.createSession()).rejects.toThrow(); // анонимно нельзя
      await expect(second.createSession({ type: UserTokenType.UserName, userName: 'operator', password: 'bad' }))
        .rejects.toThrow(/BadUserAccessDenied/);
      const session = await second.createSession({ type: UserTokenType.UserName, userName: 'operator', password: 'secret' });
      store.update('B1/AHU-17/SupplyTemp', 18.25);
      const ns = (await session.readNamespaceArray()).indexOf(NS_URI);
      expect((await session.read({ nodeId: `ns=${ns};s=B1/AHU-17/SupplyTemp` })).value.value).toBe(18.25);
      await session.close();

      // Отзыв доверия
      out.length = 0;
      expect(pkiMain(['n', 't', 'untrust', thumb, '--pki', pki], (s) => out.push(s))).toBe(0);
      expect(out.join('')).toMatch(/Отозван/);
    });
  });

  describe('запись и методы через commandGateway', () => {
    let userStore;
    let driverCalls;
    let journalEntries;
    let ns;

    const ID = (id) => `ns=${ns};s=${id}`;

    beforeEach(async () => {
      userStore = createFakeUserStore({
        viewer: { password: 'viewer-pass', role: 'viewer' },
        oper: { password: 'oper-pass', role: 'operator' },
        eng: { password: 'eng-pass', role: 'engineer' },
      });
      driverCalls = [];
      journalEntries = [];
      // Драйвер-подделка: «контроллер» подтверждает записанное значение через tagStore
      const fakeDriver = {
        async write(tagId, value) {
          driverCalls.push([tagId, value]);
          store.update(tagId, value);
          return { ok: true, value };
        },
      };
      const lazyStore = { tag: (id) => store.tag(id), get: (id) => store.get(id) };
      const gateway = createCommandGateway({
        tagStore: lazyStore,
        drivers: new Map([['modbus', fakeDriver], ['bacnet', fakeDriver]]),
        journal: { record: async (e) => { journalEntries.push(e); } },
        logger: createFakeLogger(),
      });
      await startServer({ allowInsecure: true }, { auth: createAuthService({ userStore, logger: createFakeLogger() }), gateway });
    });

    async function login(userName, password) {
      const c = client();
      await c.connect(`opc.tcp://localhost:${port}`);
      const session = await c.createSession(userName ? { type: UserTokenType.UserName, userName, password } : undefined);
      ns = (await session.readNamespaceArray()).indexOf(NS_URI);
      return session;
    }

    const write = (session, id, dataType, value) => session.write({
      nodeId: ID(id), attributeId: AttributeIds.Value, value: { value: { dataType, value } },
    });

    test('права по уровню, диапазон, тип, журнал', async () => {
      const oper = await login('oper', 'oper-pass');
      expect(await write(oper, 'B1/AHU-01/Command', DataType.Boolean, true)).toBe(StatusCodes.Good);
      expect((await oper.read({ nodeId: ID('B1/AHU-01/Command') })).value.value).toBe(true);
      // Уставка — уровень 3, у оператора 2
      expect(await write(oper, 'B1/AHU-01/SupplyTempSp', DataType.Float, 22)).toBe(StatusCodes.BadUserAccessDenied);
      expect(await write(oper, 'B1/AHU-01/SupplyTemp', DataType.Float, 22)).toBe(StatusCodes.BadNotWritable);

      const eng = await login('eng', 'eng-pass');
      expect(await write(eng, 'B1/AHU-01/SupplyTempSp', DataType.Float, 22.1)).toBe(StatusCodes.Good);
      expect(store.get('B1/AHU-01/SupplyTempSp').value).toBe(22.1); // float32 → 7 знаков
      expect(await write(eng, 'B1/AHU-02/SupplyTempSp', DataType.Float, 25)).toBe(StatusCodes.BadOutOfRange); // у AHU-02 max 24
      expect(await write(eng, 'B1/AHU-01/SupplyTempSp', DataType.Double, 22)).toBe(StatusCodes.BadTypeMismatch);
      expect(await write(eng, 'B1/AHU-01/Season', DataType.UInt16, 7)).toBe(StatusCodes.BadOutOfRange);
      expect(await write(eng, 'B1/AHU-01/Season', DataType.UInt16, 2)).toBe(StatusCodes.Good);

      const anon = await login();
      expect(await write(anon, 'B1/AHU-01/Command', DataType.Boolean, false)).toBe(StatusCodes.BadUserAccessDenied);

      expect(driverCalls).toEqual([['B1/AHU-01/Command', true], ['B1/AHU-01/SupplyTempSp', 22.1], ['B1/AHU-01/Season', 2]]);
      expect(journalEntries.map((e) => [e.username, e.tagId, e.ok, e.code])).toEqual([
        ['oper', 'B1/AHU-01/Command', true, null],
        ['oper', 'B1/AHU-01/SupplyTempSp', false, 'FORBIDDEN'],
        ['eng', 'B1/AHU-01/SupplyTempSp', true, null],
        ['eng', 'B1/AHU-02/SupplyTempSp', false, 'OUT_OF_RANGE'],
        ['eng', 'B1/AHU-01/Season', false, 'OUT_OF_RANGE'],
        ['eng', 'B1/AHU-01/Season', true, null],
        [null, 'B1/AHU-01/Command', false, 'FORBIDDEN'],
      ]);
      expect(journalEntries[0].source).toMatch(/^opcua\//);
    });

    test('методы Пуск и Стоп', async () => {
      const viewer = await login('viewer', 'viewer-pass');
      const call = (session, name) => session.call({ objectId: ID('B1/AHU-17'), methodId: ID(`B1/AHU-17/${name}`), inputArguments: [] });
      expect((await call(viewer, 'Start')).statusCode).toBe(StatusCodes.BadUserAccessDenied);
      const oper = await login('oper', 'oper-pass');
      expect((await call(oper, 'Start')).statusCode).toBe(StatusCodes.Good);
      expect((await call(oper, 'Stop')).statusCode).toBe(StatusCodes.Good);
      expect(driverCalls).toEqual([['B1/AHU-17/Command', true], ['B1/AHU-17/Command', false]]);
      expect(journalEntries.map((e) => e.source.split(':').pop())).toEqual(['Start', 'Start', 'Stop']);
    });

    test('смена роли закрывает сессии пользователя, другие остаются', async () => {
      const oper = await login('oper', 'oper-pass');
      await login('eng', 'eng-pass');
      expect(server.status().users.sort()).toEqual(['eng', 'oper']);
      userStore.change('oper', { role: 'viewer' });
      await waitFor(() => !server.status().users.includes('oper'));
      expect(server.status().users).toEqual(['eng']);
      expect(logger.lines.info.join('\n')).toMatch(/закрыта сессия oper: учётная запись изменена/);
      // Клиент может сам войти заново с тем же паролем — но уже с новой ролью: запись запрещена
      const status = await write(oper, 'B1/AHU-01/Command', DataType.Boolean, true).catch(() => StatusCodes.BadSessionClosed);
      expect([StatusCodes.BadUserAccessDenied, StatusCodes.BadSessionClosed, StatusCodes.BadSessionIdInvalid]).toContain(status);
      expect(driverCalls).toEqual([]);
    });

    test('после переподключения к БД проверяются все сессии', async () => {
      await login('oper', 'oper-pass');
      await login('eng', 'eng-pass');
      // Пароль eng изменён, пока уведомления не доходили
      userStore.change('eng', { password: 'new-pass-123' }, { notify: false });
      userStore.emit(null);
      await waitFor(() => !server.status().users.includes('eng'));
      expect(server.status().users).toEqual(['oper']);
    });
  });

  test('занятый порт — понятная ошибка запуска', async () => {
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    try {
      logger = createFakeLogger();
      server = createOpcUaServer({
        model,
        tagStore: createTagStore({ tags: model.tags, logger }),
        logger,
        options: { port: blocker.address().port, host: '127.0.0.1', namespaceUri: NS_URI, pkiDir: path.join(dir, 'pki') },
      });
      await expect(server.start()).rejects.toThrow(`порт TCP ${blocker.address().port} занят (OPCUA_PORT)`);
    } finally {
      blocker.close();
    }
  });
});

describe('tools/opcuaPki: аргументы', () => {
  test('неверные аргументы и неизвестный отпечаток', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scada-pki-'));
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(pkiMain(['n', 't'], () => {})).toBe(2);
      expect(pkiMain(['n', 't', 'trust', 'ab', '--pki', dir], () => {})).toBe(2);
      expect(pkiMain(['n', 't', 'trust', 'abcdef12', '--pki', dir], () => {})).toBe(1);
      expect(err.mock.calls.join('')).toMatch(/нет сертификата с отпечатком abcdef12/);
      const out = [];
      expect(pkiMain(['n', 't', 'list', '--pki', dir], (s) => out.push(s))).toBe(0);
      expect(out.join('')).toMatch(/Доверенные клиенты: 0/);
    } finally {
      err.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
