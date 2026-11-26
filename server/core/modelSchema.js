// core/modelSchema.js
// Схемы Joi файлов конфигурации объекта (формат — docs/model.md):
//   site.json          — объект (здание): id, title, timezone;
//   templates/*.json   — типы установок: параметры (теги) без привязки к контроллеру;
//   maps/*.json        — карты привязки параметров шаблона к контроллеру одной модели;
//   instances/*.json   — экземпляры установок (массив): шаблон + контроллер + своя привязка.
// Здесь только форма данных. Взаимные проверки (шаблон существует, параметр привязан,
// тип точки подходит к типу параметра) — в modelLoader.
'use strict';

const Joi = require('joi');

// Часть идентификатора тега (объект, установка) — rules.md, «Модель данных»
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Имя параметра начинается с буквы: имена из одних цифр меняли бы порядок ключей объекта
const PARAM_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

const DATA_TYPES = ['Boolean', 'Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double', 'String'];
const NUMERIC_TYPES = ['Int16', 'UInt16', 'Int32', 'UInt32', 'Float', 'Double'];

const MODBUS_AREAS = ['coil', 'discrete', 'input', 'holding'];
const MODBUS_TYPES = ['bool', 'int16', 'uint16', 'int32', 'uint32', 'float32'];
const BYTE_ORDERS = ['ABCD', 'CDAB', 'BADC', 'DCBA'];

const BACNET_OBJECT_TYPES = [
  'analogInput', 'analogOutput', 'analogValue',
  'binaryInput', 'binaryOutput', 'binaryValue',
  'multiStateInput', 'multiStateOutput', 'multiStateValue',
  'characterstringValue',
];
// Приоритеты 1–7 (жизнеобеспечение, критичное оборудование) сервер не использует никогда
const BACNET_PRIORITY_MIN = 8;

const ALARM_TYPES = ['hi', 'lo', 'hihi', 'lolo', 'state', 'bad'];
const LIMIT_ALARMS = ['hi', 'lo', 'hihi', 'lolo'];

// Сообщения на русском: их читает инженер, который правит конфигурацию
const MESSAGES = {
  'any.required': '{{#label}}: обязательное поле',
  'any.only': '{{#label}}: допустимо {{#valids}}',
  'any.invalid': '{{#label}}: недопустимое значение',
  'any.unknown': '{{#label}}: поле не допускается',
  'object.unknown': '{{#label}}: неизвестное поле',
  'object.base': '{{#label}}: ожидается объект',
  'object.min': '{{#label}}: нужно хотя бы {{#limit}} значение',
  'object.pattern.match': '{{#label}}: недопустимое имя',
  'array.base': '{{#label}}: ожидается массив',
  'array.unique': '{{#label}}: повтор значения',
  'string.base': '{{#label}}: ожидается строка',
  'string.empty': '{{#label}}: пустая строка',
  'string.max': '{{#label}}: не длиннее {{#limit}} символов',
  'string.pattern.base': '{{#label}}: недопустимые символы или формат',
  'string.hostname': '{{#label}}: ожидается IP-адрес или имя узла',
  'number.base': '{{#label}}: ожидается число',
  'number.integer': '{{#label}}: ожидается целое число',
  'number.min': '{{#label}}: не меньше {{#limit}}',
  'number.max': '{{#label}}: не больше {{#limit}}',
  'boolean.base': '{{#label}}: ожидается true или false',
  'alternatives.types': '{{#label}}: ожидается {{#types}}',
};

const text = (max) => Joi.string().max(max);

const site = Joi.object({
  id: Joi.string().pattern(ID_RE).required(),
  title: text(200).required(),
  description: text(1000),
  timezone: text(64),
});

const alarm = Joi.object({
  type: Joi.string().valid(...ALARM_TYPES).required(),
  limit: Joi.number().when('type', { is: Joi.valid(...LIMIT_ALARMS), then: Joi.required(), otherwise: Joi.forbidden() }),
  value: Joi.alternatives(Joi.number(), Joi.boolean())
    .when('type', { is: 'state', then: Joi.required(), otherwise: Joi.forbidden() }),
  priority: Joi.number().integer().min(1).max(1000).required(),
  deadband: Joi.number().min(0).default(0),
  delayMs: Joi.number().integer().min(0).max(3600000).default(0),
  message: text(200),
});

const archive = Joi.object({
  mode: Joi.string().valid('change', 'interval', 'none').default('change'),
  deadband: Joi.number().min(0),
  periodMs: Joi.number().integer().min(1000).max(86400000)
    .when('mode', { is: 'interval', then: Joi.required() }),
});

const states = Joi.object().pattern(/^-?\d+$/, text(100));

const param = Joi.object({
  title: text(200).required(),
  description: text(1000),
  dataType: Joi.string().valid(...DATA_TYPES).required(),
  access: Joi.string().valid('r', 'rw').default('r'),
  unit: text(32),
  min: Joi.number(),
  max: Joi.number(),
  writeLevel: Joi.number().integer().min(1).max(4).default(3),
  states,
  deadband: Joi.number().min(0).default(0),
  archive: archive.default(),
  alarms: Joi.array().items(alarm).default([]),
});

// Переопределение параметра в экземпляре: только то, что может отличаться у установок одного типа
const paramOverride = Joi.object({
  title: text(200),
  description: text(1000),
  min: Joi.number(),
  max: Joi.number(),
  writeLevel: Joi.number().integer().min(1).max(4),
  deadband: Joi.number().min(0),
  archive: Joi.object({
    mode: Joi.string().valid('change', 'interval', 'none'),
    deadband: Joi.number().min(0),
    periodMs: Joi.number().integer().min(1000).max(86400000),
  }),
  alarms: Joi.array().items(alarm),
});

// Метод установки (OPC UA Method, кнопка интерфейса): запись заданного значения в параметр rw.
// Права — writeLevel этого параметра
const method = Joi.object({
  title: text(200).required(),
  param: Joi.string().pattern(PARAM_RE).required(),
  value: Joi.alternatives(Joi.boolean(), Joi.number()).required(),
});

const template = Joi.object({
  id: Joi.string().pattern(ID_RE).required(),
  title: text(200).required(),
  description: text(1000),
  params: Joi.object().pattern(PARAM_RE, param).min(1).required(),
  methods: Joi.object().pattern(PARAM_RE, method).default({}),
});

const scaling = {
  scale: Joi.number().invalid(0).default(1),
  offset: Joi.number().default(0),
};

const modbusPoint = Joi.object({
  area: Joi.string().valid(...MODBUS_AREAS).required(),
  address: Joi.number().integer().min(0).max(65535).required(),
  type: Joi.string().valid(...MODBUS_TYPES),
  bit: Joi.number().integer().min(0).max(15),
  ...scaling,
});

const bacnetPoint = Joi.object({
  objectType: Joi.string().valid(...BACNET_OBJECT_TYPES).required(),
  instance: Joi.number().integer().min(0).max(4194302).required(),
  priority: Joi.number().integer().min(BACNET_PRIORITY_MIN).max(16),
  ...scaling,
});

const POINT = { modbus: modbusPoint, bacnet: bacnetPoint };
const points = (driver) => Joi.object().pattern(PARAM_RE, POINT[driver]);

const map = Joi.object({
  id: Joi.string().pattern(ID_RE).required(),
  title: text(200),
  description: text(1000),
  driver: Joi.string().valid('modbus', 'bacnet').required(),
  template: Joi.string().pattern(ID_RE).required(),
  byteOrder: Joi.when('driver', {
    is: 'modbus',
    then: Joi.string().valid(...BYTE_ORDERS).default('ABCD'),
    otherwise: Joi.forbidden(),
  }),
  points: Joi.when('driver', { is: 'modbus', then: points('modbus'), otherwise: points('bacnet') }).required(),
});

const modbusSource = Joi.object({
  driver: Joi.string().valid('modbus').required(),
  map: Joi.string().pattern(ID_RE).required(),
  host: Joi.string().hostname().required(),
  port: Joi.number().integer().min(1).max(65535).default(502),
  unitId: Joi.number().integer().min(0).max(255).default(1),
  byteOrder: Joi.string().valid(...BYTE_ORDERS),
  points: points('modbus'),
});

const bacnetSource = Joi.object({
  driver: Joi.string().valid('bacnet').required(),
  map: Joi.string().pattern(ID_RE),
  device: Joi.number().integer().min(0).max(4194302).required(),
  // Без адреса устройство ищется по номеру (Who-Is)
  address: Joi.string().pattern(/^[A-Za-z0-9.-]+(:\d{1,5})?$/),
  points: points('bacnet'),
});

const instance = Joi.object({
  id: Joi.string().pattern(ID_RE).required(),
  title: text(200).required(),
  description: text(1000),
  template: Joi.string().pattern(ID_RE).required(),
  enabled: Joi.boolean().default(true),
  source: Joi.object({ driver: Joi.string().valid('modbus', 'bacnet').required() }).unknown(true).required(),
  exclude: Joi.array().items(Joi.string().pattern(PARAM_RE)).unique().default([]),
  params: Joi.object().pattern(PARAM_RE, paramOverride).default({}),
});

const SOURCE = { modbus: modbusSource, bacnet: bacnetSource };

// Проверка значения схемой. Возвращает { value } или { error } с текстом всех ошибок.
function check(schema, data, label) {
  const { value, error } = schema.validate(data, {
    abortEarly: false,
    messages: MESSAGES,
    errors: { wrap: { label: false } },
  });
  if (error) {
    const details = error.details.map((d) => d.message).join('; ');
    return { error: label ? `${label}: ${details}` : details };
  }
  return { value };
}

module.exports = {
  ID_RE,
  PARAM_RE,
  DATA_TYPES,
  NUMERIC_TYPES,
  MODBUS_TYPES,
  BACNET_OBJECT_TYPES,
  LIMIT_ALARMS,
  schemas: { site, template, map, instance, param, source: SOURCE },
  check,
};
