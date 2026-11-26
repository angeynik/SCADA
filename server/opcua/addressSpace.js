// opcua/addressSpace.js
// Пространство адресов OPC UA из модели объекта (соответствие — opcua/nodes.js):
//   Objects/<объект> (папка) → установки (Object типа шаблона) → переменные тегов;
//   Types/ObjectTypes/BaseObjectType/<шаблон> — тип установки, параметры — компоненты
//   с правилом Optional (экземпляр может исключить параметр через exclude).
// Запись: переменные тегов access rw получают CurrentWrite, их writeValue заменён вызовом
// onWrite(tag, dataValue, context) → Promise<StatusCode> (commandGateway через opcua/index.js).
// Значение переменной после записи не меняется здесь: его кладёт values.js из tagStore,
// куда драйвер пишет подтверждённое контроллером значение. Без onWrite все переменные
// только для чтения.
// Методы шаблона (methods) — узлы Method установки; вызов — onCall(method, context).
// Значения в переменные кладёт values.js, здесь узлы создаются с bad / BadNotConnected.
'use strict';

const opcua = require('node-opcua');
const nodes = require('./nodes');

const { DataType, Range, StatusCodes, makeEUInformation } = opcua;
const READ_ONLY = { accessLevel: 'CurrentRead', userAccessLevel: 'CurrentRead' };
const READ_WRITE = { accessLevel: 'CurrentRead | CurrentWrite', userAccessLevel: 'CurrentRead | CurrentWrite' };

function addProperty(ns, variable, nodeId, name, dataType, value, modellingRule) {
  return ns.addVariable({
    propertyOf: variable,
    browseName: { name, namespaceIndex: 0 },
    nodeId: `s=${nodes.propertyNodeId(nodeId, name)}`,
    dataType,
    modellingRule,
    ...READ_ONLY,
    value: { dataType: DataType.ExtensionObject, value },
  });
}

// Переменная параметра. param — параметр шаблона (для типа) или тег (для экземпляра).
// modellingRule задаётся только у компонентов типа.
function addParamVariable(ns, parent, nodeId, name, param, modellingRule, writable = false) {
  const base = {
    componentOf: parent,
    browseName: name,
    nodeId: `s=${nodeId}`,
    displayName: name,
    description: nodes.describe(param),
    dataType: param.dataType,
    minimumSamplingInterval: 0,
    modellingRule,
    ...(writable ? READ_WRITE : READ_ONLY),
  };
  const kind = nodes.variableKind(param);
  if (kind === 'multiState') {
    const list = nodes.enumValuesOf(param.states);
    return ns.addMultiStateValueDiscrete({
      ...base,
      enumValues: list.map((e) => ({ value: e.value, displayName: e.text })),
      value: list[0].value,
    });
  }
  if (kind === 'plain') return ns.addVariable(base);

  const variable = ns.addVariable({ ...base, typeDefinition: 'BaseAnalogType' });
  const propRule = modellingRule ? 'Mandatory' : undefined;
  const eu = nodes.euInformation(param.unit);
  if (eu) {
    const info = makeEUInformation(eu.code || '', eu.displayName, eu.description);
    if (!eu.code) info.unitId = -1;
    addProperty(ns, variable, nodeId, 'EngineeringUnits', 'EUInformation', info, propRule);
  }
  const range = nodes.euRange(param);
  if (range) addProperty(ns, variable, nodeId, 'EURange', 'Range', new Range(range), propRule);
  return variable;
}

// Запись переменной — только через onWrite. node-opcua вызывает writeValue(context,
// dataValue, [indexRange,] callback); стандартная обработка (запись значения в узел) не нужна
function bindWrite(variable, tag, onWrite) {
  variable.writeValue = function writeValue(context, dataValue, ...args) {
    const callback = args[args.length - 1];
    onWrite(tag, dataValue, context).then((status) => callback(null, status), (err) => callback(err));
  };
}

function addMethodNode(ns, parent, nodeId, name, title, modellingRule) {
  return ns.addMethod(parent, {
    browseName: name,
    nodeId: `s=${nodeId}`,
    description: title,
    modellingRule,
    inputArguments: [],
    outputArguments: [],
  });
}

function addObjectType(ns, template) {
  const type = ns.addObjectType({
    browseName: template.id,
    nodeId: `s=${nodes.typeNodeId(template.id)}`,
    description: template.description ? `${template.title}. ${template.description}` : template.title,
  });
  for (const [name, param] of Object.entries(template.params)) {
    addParamVariable(ns, type, nodes.typeParamNodeId(template.id, name), name, param, 'Optional', param.access === 'rw');
  }
  for (const [name, m] of Object.entries(template.methods || {})) {
    addMethodNode(ns, type, nodes.typeParamNodeId(template.id, name), name, m.title, 'Optional');
  }
  return type;
}

// Строит узлы модели в пространстве имён ns.
// Возвращает { variables: Map(tagId → UAVariable), types, instances, writable, methods }.
function buildAddressSpace({ addressSpace, ns, model, onWrite = null, onCall = null }) {
  const types = new Map();
  for (const template of model.templates.values()) types.set(template.id, addObjectType(ns, template));

  const { site } = model;
  const folder = ns.addFolder(addressSpace.rootFolder.objects, {
    browseName: site.id,
    nodeId: `s=${site.id}`,
    description: site.title,
  });

  const variables = new Map();
  let writableCount = 0;
  let methodCount = 0;
  for (const inst of model.instances) {
    const object = ns.addObject({
      organizedBy: folder,
      browseName: inst.id,
      nodeId: `s=${site.id}/${inst.id}`,
      typeDefinition: types.get(inst.template),
      description: inst.title,
    });
    for (const tagId of inst.tagIds) {
      const tag = model.tags.get(tagId);
      const writable = Boolean(onWrite) && tag.access === 'rw';
      const variable = addParamVariable(ns, object, tagId, tag.param, tag, undefined, writable);
      variable.setValueFromSource({ dataType: DataType.Null }, StatusCodes.BadNotConnected);
      if (writable) {
        bindWrite(variable, tag, onWrite);
        writableCount += 1;
      }
      variables.set(tagId, variable);
    }
    for (const m of (onCall && inst.methods) || []) {
      const node = addMethodNode(ns, object, `${site.id}/${inst.id}/${m.name}`, m.name, m.title);
      node.bindMethod(async (inputArguments, context) => ({ statusCode: await onCall(m, context) }));
      methodCount += 1;
    }
  }
  return { variables, types: types.size, instances: model.instances.length, writable: writableCount, methods: methodCount };
}

module.exports = { buildAddressSpace };
