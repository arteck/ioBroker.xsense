'use strict';

const assert = require('node:assert/strict');
const Json2iobXSense = require('../lib/json2iob');

/**
 * Minimal Adapter-Mock der die ioBroker Adapter-API simuliert.
 */
function createAdapterMock() {
    const objects = {};
    const states = {};
    const subscriptions = [];

    return {
        FORBIDDEN_CHARS: /[*?[\]]/g,
        log: {
            debug: () => {},
            info:  () => {},
            warn:  () => {},
            error: () => {},
        },
        objects,
        states,
        subscriptions,

        async setObjectNotExistsAsync(id, obj) {
            if (!objects[id]) {
                objects[id] = obj;
            }
        },
        async setStateAsync(id, state) {
            states[id] = state;
        },
        async getStateAsync(id) {
            return states[id] ?? null;
        },
        async subscribeStates(id) {
            subscriptions.push(id);
        },
    };
}

// ─────────────────────────────────────────────────────────────
// name2id
// ─────────────────────────────────────────────────────────────
describe('Json2iobXSense – name2id()', () => {
    let j2i;
    beforeEach(() => {
        j2i = new Json2iobXSense(createAdapterMock());
    });

    it('replaces forbidden chars with underscore', async () => {
        assert.equal(await j2i.name2id('a*b?c[d]'), 'a_b_c_d_');
    });

    it('leaves valid id untouched', async () => {
        assert.equal(await j2i.name2id('devices.ABC123'), 'devices.ABC123');
    });

    it('handles null/undefined gracefully', async () => {
        assert.equal(await j2i.name2id(null), '');
        assert.equal(await j2i.name2id(undefined), '');
    });
});

// ─────────────────────────────────────────────────────────────
// createStaticDeviceObject
// ─────────────────────────────────────────────────────────────
describe('Json2iobXSense – createStaticDeviceObject()', () => {
    let adapter, j2i;
    beforeEach(() => {
        adapter = createAdapterMock();
        j2i = new Json2iobXSense(adapter);
    });

    it('creates devices.forceRefresh state object', async () => {
        await j2i.createStaticDeviceObject();
        assert.ok(adapter.objects['devices.forceRefresh'], 'forceRefresh state should be created');
        assert.equal(adapter.objects['devices.forceRefresh'].type, 'state');
    });

    it('subscribes to devices.forceRefresh', async () => {
        await j2i.createStaticDeviceObject();
        assert.ok(adapter.subscriptions.includes('devices.forceRefresh'));
    });

    it('is idempotent – calling twice does not duplicate', async () => {
        await j2i.createStaticDeviceObject();
        await j2i.createStaticDeviceObject();
        // _subscribeOnce: subscribeStates nur einmal aufgerufen
        assert.equal(adapter.subscriptions.filter(s => s === 'devices.forceRefresh').length, 1);
        assert.ok(adapter.objects['devices.forceRefresh']);
    });
});

// ─────────────────────────────────────────────────────────────
// setStateObject
// ─────────────────────────────────────────────────────────────
describe('Json2iobXSense – setStateObject()', () => {
    let adapter, j2i;
    beforeEach(() => {
        adapter = createAdapterMock();
        j2i = new Json2iobXSense(adapter);
    });

    it('creates a state with correct boolean type for "true" string', async () => {
        await j2i.setStateObject('devices.test.online', 'true');
        assert.equal(adapter.objects['devices.test.online'].common.type, 'boolean');
        assert.equal(adapter.states['devices.test.online'].val, true);
    });

    it('converts batInfo to battery percentage (batInfo*100/3)', async () => {
        await j2i.setStateObject('devices.test.batInfo', 3);
        assert.equal(adapter.objects['devices.test.batInfo'].common.type, 'number');
        assert.equal(adapter.objects['devices.test.batInfo'].common.unit, '%');
        assert.equal(adapter.objects['devices.test.batInfo'].common.role, 'value.battery');
        assert.equal(adapter.states['devices.test.batInfo'].val, 100); // 3*100/3 = 100
    });

    it('converts batInfo=1 to 33%', async () => {
        await j2i.setStateObject('devices.test2.batInfo', 1);
        assert.equal(adapter.states['devices.test2.batInfo'].val, 33);
    });

    it('keeps serial as string type', async () => {
        await j2i.setStateObject('devices.test.serial', '12345678');
        assert.equal(adapter.objects['devices.test.serial'].common.type, 'string');
        assert.equal(adapter.states['devices.test.serial'].val, '12345678');
    });

    it('sets role indicator.reachable for online state', async () => {
        await j2i.setStateObject('devices.test.online', true);
        assert.equal(adapter.objects['devices.test.online'].common.role, 'indicator.reachable');
    });

    it('sets role indicator.alarm for alarmStatus state', async () => {
        await j2i.setStateObject('devices.test.alarmStatus', 'false');
        assert.equal(adapter.objects['devices.test.alarmStatus'].common.role, 'indicator.alarm');
    });

    it('creates test_Alarm and test_Alarm_Message states for alarm fields', async () => {
        await j2i.setStateObject('devices.bridge.sensor.alarmStatus', 'false');
        assert.ok(adapter.objects['devices.bridge.sensor.test_Alarm'], 'test_Alarm object should exist');
        assert.ok(adapter.objects['devices.bridge.sensor.test_Alarm_Message'], 'test_Alarm_Message object should exist');
        assert.ok(adapter.subscriptions.includes('devices.bridge.sensor.test_Alarm'));
    });

    it('sets dBm unit for wifi fields', async () => {
        await j2i.setStateObject('devices.test.wifiRSSI', '-65');
        assert.equal(adapter.objects['devices.test.wifiRSSI'].common.unit, 'dBm');
    });
});

// ─────────────────────────────────────────────────────────────
// parse  (top-level integration)
// ─────────────────────────────────────────────────────────────
describe('Json2iobXSense – parse()', () => {
    let adapter, j2i;
    beforeEach(() => {
        adapter = createAdapterMock();
        j2i = new Json2iobXSense(adapter);
    });

    it('returns early when devicesContainer is missing', async () => {
        await j2i.parse('xsense.0', {});
        assert.equal(Object.keys(adapter.states).length, 0);
    });

    it('writes home_id state when present', async () => {
        await j2i.parse('xsense.0', { home_id: 'AABB1122', devices: [] });
        assert.ok(adapter.states['devices.home_id'], 'home_id state should be set');
    });

    it('handles bridge device (wifiRSSI present)', async () => {
        const input = {
            devices: {
                devices: [
                    {
                        serial: 'BRIDGEABC',
                        name: 'My Bridge',
                        wifiRSSI: '-55',
                        online: 'true',
                    },
                ],
            },
        };
        await j2i.parse('xsense.0', input);
        assert.ok(adapter.objects['devices.BRIDGEABC'], 'Bridge device object should be created');
    });

    it('handles child device under bridge (no wifiRSSI)', async () => {
        const input = {
            devices: {
                devices: [
                    { serial: 'BRIDGEABC', name: 'Bridge', wifiRSSI: '-55', online: 'true' },
                    { serial: 'SENSOR001', name: 'Smoke 1', alarmStatus: 'false', online: 'true' },
                ],
            },
        };
        await j2i.parse('xsense.0', input);
        assert.ok(adapter.objects['devices.BRIDGEABC.SENSOR001'], 'Child device object should be created');
    });

    it('skips child device with null/empty serial', async () => {
        const input = {
            devices: {
                devices: [
                    { serial: 'BRIDGEABC', name: 'Bridge', wifiRSSI: '-55', online: 'true' },
                    { serial: null, name: 'Ghost Device' },
                ],
            },
        };
        // Should not throw
        await assert.doesNotReject(j2i.parse('xsense.0', input));
    });
});

// ─────────────────────────────────────────────────────────────
// parseHouses – multi-station
// ─────────────────────────────────────────────────────────────
describe('Json2iobXSense – parseHouses() multi-station', () => {
    let adapter, j2i;
    beforeEach(() => {
        adapter = createAdapterMock();
        j2i = new Json2iobXSense(adapter);
    });

    function makeHouses(stationCount = 2) {
        const stations = {};
        for (let i = 1; i <= stationCount; i++) {
            const sn = `BRIDGE00${i}`;
            stations[sn] = {
                stationId: `ST00${i}`,
                serial: sn, name: `Station ${i}`, type: 'SBS50', online: true,
                data: { wifiRSSI: -50 - i },
                devices: {
                    [`DEV${i}A`]: { deviceId: `DV${i}A`, serial: `DEV${i}A`, name: `Sensor ${i}A`, type: 'XS01', online: true,  data: { alarmStatus: false, batInfo: 2 } },
                    [`DEV${i}B`]: { deviceId: `DV${i}B`, serial: `DEV${i}B`, name: `Sensor ${i}B`, type: 'XS01', online: false, data: { alarmStatus: false, batInfo: 1 } },
                },
            };
        }
        return {
            HOUSE1: {
                houseId: 'HOUSE1', name: 'Mein Zuhause',
                region: 'eu-west-1', mqttRegion: 'eu-west-1', mqttServer: 'mqtt.x-sense-iot.com',
                stations,
            },
        };
    }

    it('erstellt Haus-Ordner für jedes Haus', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.ok(adapter.objects['devices.Mein_Zuhause'], 'Haus-Ordner fehlt');
        assert.equal(adapter.objects['devices.Mein_Zuhause'].type, 'folder');
    });

    it('schreibt home_id (UUID) unter dem Haus-Ordner', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.ok(adapter.states['devices.Mein_Zuhause.home_id'], 'home_id fehlt');
        assert.equal(adapter.states['devices.Mein_Zuhause.home_id'].val, 'HOUSE1');
    });

    it('schreibt houseName, region, mqttRegion, mqttServer', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.equal(adapter.states['devices.Mein_Zuhause.houseName'].val,  'Mein Zuhause');
        assert.equal(adapter.states['devices.Mein_Zuhause.region'].val,     'eu-west-1');
        assert.equal(adapter.states['devices.Mein_Zuhause.mqttRegion'].val, 'eu-west-1');
        assert.equal(adapter.states['devices.Mein_Zuhause.mqttServer'].val, 'mqtt.x-sense-iot.com');
    });

    it('Haus-Ordner-Name ohne gültigen Namen fällt auf houseId zurück', async () => {
        const houses = { H1: { houseId: 'UUID-1234', name: '', region: '', mqttRegion: '', mqttServer: '', stations: {} } };
        await j2i.parseHouses('xsense.0', houses);
        assert.ok(adapter.objects['devices.UUID-1234'], 'Fallback auf houseId fehlt');
    });

    it('erstellt device-Objekte für jede Station unter dem Haus', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(2));
        assert.ok(adapter.objects['devices.Mein_Zuhause.BRIDGE001'], 'Station 1 device fehlt');
        assert.ok(adapter.objects['devices.Mein_Zuhause.BRIDGE002'], 'Station 2 device fehlt');
    });

    it('schreibt stationId und type für jede Station', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE001.stationId'].val, 'ST001');
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE001.type'].val,      'SBS50');
    });

    it('erstellt channel-Objekte für Sub-Geräte (nicht device)', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(2));
        assert.equal(adapter.objects['devices.Mein_Zuhause.BRIDGE001.DEV1A'].type, 'channel');
        assert.equal(adapter.objects['devices.Mein_Zuhause.BRIDGE002.DEV2A'].type, 'channel');
    });

    it('schreibt deviceId und type für jedes Sub-Gerät', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE001.DEV1A.deviceId'].val, 'DV1A');
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE001.DEV1A.type'].val,     'XS01');
    });

    it('Sub-Geräte verschiedener Stationen haben unterschiedliche Pfade', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(2));
        assert.ok(adapter.objects['devices.Mein_Zuhause.BRIDGE001.DEV1A']);
        assert.ok(adapter.objects['devices.Mein_Zuhause.BRIDGE002.DEV2A']);
        assert.ok(!adapter.objects['devices.Mein_Zuhause.BRIDGE001.DEV2A']);
        assert.ok(!adapter.objects['devices.Mein_Zuhause.BRIDGE002.DEV1A']);
    });

    it('kein doppeltes subscribeStates bei wiederholtem parseHouses-Aufruf', async () => {
        const houses = makeHouses(2);
        await j2i.parseHouses('xsense.0', houses);
        await j2i.parseHouses('xsense.0', houses);
        const count = adapter.subscriptions.filter(s => s === 'devices.forceRefresh').length;
        assert.equal(count, 1, `devices.forceRefresh ${count}x subscribed, erwartet 1`);
    });

    it('kein doppeltes subscribeStates für test_Alarm bei wiederholtem Poll', async () => {
        const houses = makeHouses(1);
        await j2i.parseHouses('xsense.0', houses);
        await j2i.parseHouses('xsense.0', houses);
        const alarmId = 'devices.Mein_Zuhause.BRIDGE001.DEV1A.test_Alarm';
        const count = adapter.subscriptions.filter(s => s === alarmId).length;
        assert.equal(count, 1, `${alarmId} ${count}x subscribed, erwartet 1`);
    });

    it('test_Alarm wird beim zweiten Poll nicht zurückgesetzt', async () => {
        const houses = makeHouses(1);
        await j2i.parseHouses('xsense.0', houses);
        const alarmId = 'devices.Mein_Zuhause.BRIDGE001.DEV1A.test_Alarm';
        adapter.states[alarmId] = { val: true, ack: false };
        await j2i.parseHouses('xsense.0', houses);
        assert.equal(adapter.states[alarmId].val, true, 'User-Trigger wurde fälschlicherweise zurückgesetzt');
    });

    it('batInfo wird als Prozent gespeichert', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        const state = adapter.states['devices.Mein_Zuhause.BRIDGE001.DEV1A.batInfo'];
        assert.ok(state, 'batInfo state fehlt');
        assert.equal(state.val, 67);
    });

    it('online-State wird für jedes Gerät gesetzt', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(2));
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE001.online'].val, true);
        assert.equal(adapter.states['devices.Mein_Zuhause.BRIDGE002.DEV2B.online'].val, false);
    });

    it('devices Ordner wird als folder angelegt', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        assert.ok(adapter.objects['devices'], 'devices folder fehlt');
        assert.equal(adapter.objects['devices'].type, 'folder');
    });

    it('onlineId in statusStates zeigt auf korrekten State', async () => {
        await j2i.parseHouses('xsense.0', makeHouses(1));
        const device = adapter.objects['devices.Mein_Zuhause.BRIDGE001'];
        assert.equal(device.common.statusStates.onlineId, 'xsense.0.devices.Mein_Zuhause.BRIDGE001.online');
        const channel = adapter.objects['devices.Mein_Zuhause.BRIDGE001.DEV1A'];
        assert.equal(channel.common.statusStates.onlineId, 'xsense.0.devices.Mein_Zuhause.BRIDGE001.DEV1A.online');
    });
});

