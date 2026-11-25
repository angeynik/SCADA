'use strict';

const nodes = require('../../opcua/nodes');

describe('opcua/nodes: соответствие модели и OPC UA', () => {
  test('NodeId типов и свойств', () => {
    expect(nodes.typeNodeId('AhuType')).toBe('type:AhuType');
    expect(nodes.typeParamNodeId('AhuType', 'SupplyTemp')).toBe('type:AhuType/SupplyTemp');
    expect(nodes.propertyNodeId('B1/AHU-17/SupplyTemp', 'EURange')).toBe('B1/AHU-17/SupplyTemp-EURange');
  });

  test('состояния → EnumValues по возрастанию', () => {
    expect(nodes.enumValuesOf({ 2: 'Лето', 0: 'Авто', 1: 'Зима' })).toEqual([
      { value: 0, text: 'Авто' }, { value: 1, text: 'Зима' }, { value: 2, text: 'Лето' },
    ]);
    expect(nodes.enumValuesOf({ '-1': 'Нет', 3: 'Да' }).map((e) => e.value)).toEqual([-1, 3]);
    expect(nodes.enumValuesOf(undefined)).toBeNull();
    expect(nodes.enumValuesOf({})).toBeNull();
  });

  test.each([
    [{ dataType: 'UInt16', states: { 0: 'Стоп' } }, 'multiState'],
    [{ dataType: 'Int32', states: { 1: 'А' } }, 'multiState'],
    [{ dataType: 'Float', states: { 1: 'А' } }, 'analog'],
    [{ dataType: 'UInt32' }, 'analog'],
    [{ dataType: 'Double' }, 'analog'],
    [{ dataType: 'Boolean' }, 'plain'],
    [{ dataType: 'String' }, 'plain'],
  ])('вид переменной %o → %s', (param, kind) => {
    expect(nodes.variableKind(param)).toBe(kind);
  });

  test('единицы измерения: известные — код UNECE, прочие — без кода', () => {
    expect(nodes.euInformation('°C')).toEqual({ code: 'CEL', displayName: '°C', description: 'градус Цельсия' });
    expect(nodes.euInformation('%').code).toBe('P1');
    expect(nodes.euInformation('ч').code).toBe('HUR');
    expect(nodes.euInformation('м3/ч').code).toBe(nodes.euInformation('м³/ч').code);
    expect(nodes.euInformation('ед.')).toEqual({ code: null, displayName: 'ед.', description: 'ед.' });
    expect(nodes.euInformation(undefined)).toBeNull();
  });

  test('EURange только при заданных min и max', () => {
    expect(nodes.euRange({ min: 10, max: 30 })).toEqual({ low: 10, high: 30 });
    expect(nodes.euRange({ min: 0 })).toBeNull();
    expect(nodes.euRange({})).toBeNull();
  });

  test('описание: заголовок и пояснение', () => {
    expect(nodes.describe({ title: 'Уставка' })).toBe('Уставка');
    expect(nodes.describe({ title: 'Уставка', description: 'Зимой' })).toBe('Уставка. Зимой');
  });

  test('безопасность: рабочий режим без None и анонимного входа', () => {
    expect(nodes.securitySettings({ allowInsecure: false })).toEqual({
      modes: ['Sign', 'SignAndEncrypt'],
      policies: ['Basic256Sha256', 'Aes128_Sha256_RsaOaep', 'Aes256_Sha256_RsaPss'],
      userTokens: ['UserName'],
      allowAnonymous: false,
    });
    const dev = nodes.securitySettings({ allowInsecure: true });
    expect(dev.modes).toContain('None');
    expect(dev.policies).toContain('None');
    expect(dev.userTokens).toEqual(['Anonymous', 'UserName']);
    expect(dev.allowAnonymous).toBe(true);
  });
});
