// Пространство адресов OPC UA из модели примера — без сервера и сети:
// отдельный AddressSpace node-opcua со стандартным набором узлов.
'use strict';

const opcua = require('node-opcua');
const { loadModel } = require('../../core/modelLoader');
const { createTagStore } = require('../../core/tagStore');
const { buildAddressSpace } = require('../../opcua/addressSpace');
const { bindValues } = require('../../opcua/values');
const { createFakeLogger } = require('../helpers/fakeLogger');
const fx = require('../helpers/modelFixture');

const { AddressSpace, generateAddressSpace, nodesets, StatusCodes, DataType, AttributeIds, SessionContext } = opcua;

describe('opcua/addressSpace и values', () => {
  let addressSpace;
  let ns;
  let model;
  let built;
  let store;
  let logger;

  beforeAll(async () => {
    addressSpace = AddressSpace.create();
    await generateAddressSpace(addressSpace, [nodesets.standard]);
    ns = addressSpace.registerNamespace('urn:test:model');
    model = loadModel({ dir: fx.EXAMPLE_DIR });
    built = buildAddressSpace({ addressSpace, ns, model });
  });

  afterAll(() => addressSpace.dispose());

  beforeEach(() => {
    logger = createFakeLogger();
    store = createTagStore({ tags: model.tags, logger });
  });

  const node = (id) => addressSpace.findNode(`ns=${ns.index};s=${id}`);
  const read = (id, attr = AttributeIds.Value) => node(id).readAttribute(SessionContext.defaultContext, attr);
  const prop = (id, name) => node(id).getPropertyByName(name);

  test('объект, установки и переменные с NodeId = идентификатор тега', () => {
    expect(built).toMatchObject({ types: 1, instances: 3 });
    expect(built.variables.size).toBe(model.tags.size);
    const folder = node('B1');
    expect(folder.typeDefinitionObj.browseName.name).toBe('FolderType');
    expect(folder.description.text).toBe('Здание 1 (пример)');
    expect(addressSpace.rootFolder.objects.getFolderElementByName('B1', ns.index)).toBe(folder);

    const ahu = node('B1/AHU-17');
    expect(ahu.typeDefinition.toString()).toBe(`ns=${ns.index};s=type:AhuType`);
    expect(ahu.description.text).toBe('П17/В17 Склад (ещё на N30)');
    // Исключённый параметр не создаётся
    expect(node('B1/AHU-17/Humidity')).toBeNull();
    expect(node('B1/AHU-01/Humidity')).not.toBeNull();
    for (const id of model.tags.keys()) expect(node(id).nodeId.value).toBe(id);
  });

  test('тип данных, описание и только чтение', () => {
    const v = node('B1/AHU-01/SupplyTemp');
    expect(v.browseName.toString()).toBe(`${ns.index}:SupplyTemp`);
    expect(v.description.text).toBe('Температура приточного воздуха');
    expect(addressSpace.findNode(v.dataType).browseName.name).toBe('Float');
    expect(addressSpace.findNode(node('B1/AHU-01/Command').dataType).browseName.name).toBe('Boolean');
    expect(addressSpace.findNode(node('B1/AHU-01/RunHours').dataType).browseName.name).toBe('UInt32');
    for (const id of ['B1/AHU-01/SupplyTempSp', 'B1/AHU-01/Command', 'B1/AHU-01/Season']) {
      expect(node(id).accessLevel).toBe(opcua.AccessLevelFlag.CurrentRead);
      expect(node(id).userAccessLevel).toBe(opcua.AccessLevelFlag.CurrentRead);
    }
  });

  test('аналоговые: единицы UNECE и EURange из min/max экземпляра', () => {
    const sp = node('B1/AHU-02/SupplyTempSp');
    expect(sp.typeDefinitionObj.browseName.name).toBe('BaseAnalogType');
    expect(prop('B1/AHU-02/SupplyTempSp', 'EURange').readValue().value.value).toMatchObject({ low: 16, high: 24 });
    expect(prop('B1/AHU-01/SupplyTempSp', 'EURange').readValue().value.value).toMatchObject({ low: 10, high: 30 });
    const eu = prop('B1/AHU-01/SupplyTemp', 'EngineeringUnits').readValue().value.value;
    expect(eu).toMatchObject({ unitId: 4408652, namespaceUri: 'http://www.opcfoundation.org/UA/units/un/cefact' });
    expect(eu.displayName.text).toBe('°C');
    expect(prop('B1/AHU-01/SupplyTemp', 'EURange')).toBeNull();
    expect(prop('B1/AHU-01/RunHours', 'EngineeringUnits').readValue().value.value.displayName.text).toBe('ч');
    // У параметра без единиц свойства нет
    expect(prop('B1/AHU-01/Command', 'EngineeringUnits')).toBeNull();
  });

  test('состояния: MultiStateValueDiscrete с текстами', () => {
    const season = node('B1/AHU-01/Season');
    expect(season.typeDefinitionObj.browseName.name).toBe('MultiStateValueDiscreteType');
    const enumValues = prop('B1/AHU-01/Season', 'EnumValues').readValue().value.value;
    expect(enumValues.map((e) => [Number(e.value[1]), e.displayName.text])).toEqual([[0, 'Авто'], [1, 'Зима'], [2, 'Лето']]);
  });

  test('тип установки: компоненты с правилом Optional', () => {
    const type = addressSpace.findNode(`ns=${ns.index};s=type:AhuType`);
    expect(type.nodeClass).toBe(opcua.NodeClass.ObjectType);
    const comps = type.getComponents();
    expect(comps.filter((c) => c.nodeClass === opcua.NodeClass.Variable)).toHaveLength(20);
    expect(comps.filter((c) => c.nodeClass === opcua.NodeClass.Method).map((c) => c.browseName.name)).toEqual(['Start', 'Stop']);
    expect(comps.every((c) => c.modellingRule === 'Optional')).toBe(true);
    expect(addressSpace.findNode(`ns=${ns.index};s=type:AhuType/SupplyTempSp`).getPropertyByName('EURange').modellingRule).toBe('Mandatory');
  });

  test('значения и качество из tagStore', () => {
    const id = 'B1/AHU-01/SupplyTemp';
    expect(read(id).statusCode).toBe(StatusCodes.BadNotConnected);
    const unbind = bindValues({ variables: built.variables, tagStore: store, logger });
    try {
      store.update(id, 21.5, { sourceTs: Date.UTC(2026, 10, 25, 10, 0, 0) });
      let dv = read(id);
      expect(dv.statusCode).toBe(StatusCodes.Good);
      expect(dv.value).toMatchObject({ dataType: DataType.Float, value: 21.5 });
      expect(dv.sourceTimestamp.toISOString()).toBe('2026-11-25T10:00:00.000Z');

      // Потеря связи: значение сохраняется, качество плохое
      store.setQuality(id, 'bad', 'COMM_ERROR');
      dv = read(id);
      expect(dv.statusCode).toBe(StatusCodes.BadCommunicationError);
      expect(dv.value.value).toBe(21.5);

      store.update('B1/AHU-17/Season', 2, { quality: 'uncertain', code: 'OUT_OF_SERVICE' });
      expect(read('B1/AHU-17/Season').statusCode).toBe(StatusCodes.UncertainSubstituteValue);
      expect(prop('B1/AHU-17/Season', 'ValueAsText').readValue().value.value.text).toBe('Лето');

      store.update('B1/AHU-17/Command', true);
      expect(read('B1/AHU-17/Command').value).toMatchObject({ dataType: DataType.Boolean, value: true });
      store.update('B1/AHU-17/RunHours', 1200);
      expect(read('B1/AHU-17/RunHours').value).toMatchObject({ dataType: DataType.UInt32, value: 1200 });
    } finally {
      unbind();
    }
    // После отписки значения не меняются
    store.update(id, 30);
    expect(read(id).value.value).toBe(21.5);
  });

  test('без onWrite нет методов у установок', () => {
    expect(built).toMatchObject({ writable: 0, methods: 0 });
    expect(node('B1/AHU-01/Start')).toBeNull();
  });

  test('с onWrite: переменные rw пишутся через обработчик, методы вызывают onCall', async () => {
    const ns2 = addressSpace.registerNamespace('urn:test:model-rw');
    const writes = [];
    const calls = [];
    const b = buildAddressSpace({
      addressSpace,
      ns: ns2,
      model,
      onWrite: async (tag, dv) => { writes.push([tag.id, dv.value.value]); return StatusCodes.Good; },
      onCall: async (m) => { calls.push([m.name, m.tagId, m.value]); return StatusCodes.BadUserAccessDenied; },
    });
    const rw = model.instances.flatMap((i) => i.tagIds).filter((id) => model.tags.get(id).access === 'rw');
    expect(b.writable).toBe(rw.length);
    expect(b.methods).toBe(6);
    const n2 = (id) => addressSpace.findNode(`ns=${ns2.index};s=${id}`);
    const rwFlags = opcua.AccessLevelFlag.CurrentRead | opcua.AccessLevelFlag.CurrentWrite;
    expect(n2('B1/AHU-01/SupplyTempSp').accessLevel).toBe(rwFlags);
    expect(n2('B1/AHU-01/SupplyTemp').accessLevel).toBe(opcua.AccessLevelFlag.CurrentRead);

    const status = await new Promise((resolve, reject) => {
      n2('B1/AHU-01/SupplyTempSp').writeValue(SessionContext.defaultContext,
        new opcua.DataValue({ value: { dataType: DataType.Float, value: 22 } }), (err, sc) => (err ? reject(err) : resolve(sc)));
    });
    expect(status).toBe(StatusCodes.Good);
    expect(writes).toEqual([['B1/AHU-01/SupplyTempSp', 22]]);
    // Значение узла не меняется само: его кладёт values.js из tagStore после подтверждения
    expect(n2('B1/AHU-01/SupplyTempSp').readValue().statusCode).toBe(StatusCodes.BadNotConnected);

    const start = n2('B1/AHU-17/Start');
    expect(start.nodeClass).toBe(opcua.NodeClass.Method);
    expect(start.description.text).toBe('Пуск');
    const res = await start.execute(null, [], SessionContext.defaultContext);
    expect(res.statusCode).toBe(StatusCodes.BadUserAccessDenied);
    expect(calls).toEqual([['Start', 'B1/AHU-17/Command', true]]);
  });

  test('при подключении переносятся текущие значения', () => {
    store.update('B1/AHU-02/OutdoorTemp', -7.5);
    const unbind = bindValues({ variables: built.variables, tagStore: store, logger });
    unbind();
    expect(read('B1/AHU-02/OutdoorTemp').value.value).toBe(-7.5);
    expect(logger.lines.error).toEqual([]);
  });
});
