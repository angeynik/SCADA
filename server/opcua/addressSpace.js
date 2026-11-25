// opcua/addressSpace.js
// Пространство адресов OPC UA из модели объекта (соответствие — opcua/nodes.js):
//   Objects/<объект> (папка) → установки (Object типа шаблона) → переменные тегов;
//   Types/ObjectTypes/BaseObjectType/<шаблон> — тип установки, параметры — компоненты
//   с правилом Optional (экземпляр может исключить параметр через exclude).
// На этапе 4 все переменные только для чтения (AccessLevel CurrentRead): запись появится
// вместе с commandGateway на этапе 5.
// Значения в переменные кладёт values.js, здесь узлы создаются с bad / BadNotConnected.
'use strict';

const opcua = require('node-opcua');
const nodes = require('./nodes');

const { DataType, Range, StatusCodes, makeEUInformation } = opcua;
const READ_ONLY = { accessLevel: 'CurrentRead', userAccessLevel: 'CurrentRead' };

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
function addParamVariable(ns, parent, nodeId, name, param, modellingRule) {
  const base = {
    componentOf: parent,
    browseName: name,
    nodeId: `s=${nodeId}`,
    displayName: name,
    description: nodes.describe(param),
    dataType: param.dataType,
    minimumSamplingInterval: 0,
    modellingRule,
    ...READ_ONLY,
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

function addObjectType(ns, template) {
  const type = ns.addObjectType({
    browseName: template.id,
    nodeId: `s=${nodes.typeNodeId(template.id)}`,
    description: template.description ? `${template.title}. ${template.description}` : template.title,
  });
  for (const [name, param] of Object.entries(template.params)) {
    addParamVariable(ns, type, nodes.typeParamNodeId(template.id, name), name, param, 'Optional');
  }
  return type;
}

// Строит узлы модели в пространстве имён ns.
// Возвращает { variables: Map(tagId → UAVariable), types, instances }.
function buildAddressSpace({ addressSpace, ns, model }) {
  const types = new Map();
  for (const template of model.templates.values()) types.set(template.id, addObjectType(ns, template));

  const { site } = model;
  const folder = ns.addFolder(addressSpace.rootFolder.objects, {
    browseName: site.id,
    nodeId: `s=${site.id}`,
    description: site.title,
  });

  const variables = new Map();
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
      const variable = addParamVariable(ns, object, tagId, tag.param, tag);
      variable.setValueFromSource({ dataType: DataType.Null }, StatusCodes.BadNotConnected);
      variables.set(tagId, variable);
    }
  }
  return { variables, types: types.size, instances: model.instances.length };
}

module.exports = { buildAddressSpace };
