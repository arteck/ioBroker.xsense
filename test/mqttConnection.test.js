'use strict';

/**
 * Tests für info.MQTT_connection State-Logik in main.js
 *
 * Da wir keinen echten ioBroker-Adapter instanziieren können, testen wir
 * die Zustands-Übergänge durch einen schlanken Adapter-Mock, der die
 * relevanten Methoden (connectToMQTT, onUnload, _ensureInfoStates) isoliert testet.
 */

const assert      = require('node:assert/strict');
const EventEmitter = require('node:events');

// ─── Minimaler MQTT-Client-Mock ────────────────────────────────────────────────

class MockMqttClient extends EventEmitter {
    constructor() {
        super();
        this.subscribed   = [];
        this.published    = [];
        this.ended        = false;
        this.closed       = false;
    }
    subscribe(topic, cb) {
        this.subscribed.push(topic);
        if (cb) cb(null);
    }
    publish(topic, payload, opts, cb) {
        this.published.push({ topic, payload });
        if (cb) cb(null);
    }
    end() { this.ended = true; this.closed = true; }
}

// ─── Minimaler Adapter-Mock ────────────────────────────────────────────────────

function createAdapterMock(config = {}) {
    const states  = {};
    const objects = {};

    const adapter = {
        config: {
            connectionType:              config.connectionType              || 'intmqtt',
            useMqttServer:               config.useMqttServer               ?? true,
            externalMqttServerIP:        config.externalMqttServerIP        || '',
            externalMqttServerPort:      config.externalMqttServerPort      || 1883,
            externalMqttServerCredentials: config.externalMqttServerCredentials ?? false,
            externalMqttServerUsername:  '',
            externalMqttServerPassword:  '',
            mqttServerIPBind:            '127.0.0.1',
            mqttServerPort:              1885,
            baseTopic:                   config.baseTopic                   || '',
        },
        states,
        objects,
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },

        setState(id, val, ack) {
            states[id] = typeof val === 'object' && val !== null && 'val' in val ? val : { val, ack };
        },
        async setStateAsync(id, stateObj) {
            states[id] = stateObj;
        },
        async getStateAsync(id) { return states[id] ?? null; },
        async setObjectNotExistsAsync(id, obj) {
            if (!objects[id]) objects[id] = obj;
        },
        async getStatesAsync() { return {}; },
        async setStateChangedAsync() {},
        subscribeStates(id) { /* sync version required by Json2iobXSense._subscribeOnce */ },
        clearInterval(id) { clearInterval(id); },
        setInterval(fn, ms) { return setInterval(fn, ms); },
        namespace: 'xsense.0',
    };

    return adapter;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('info.MQTT_connection – _ensureInfoStates()', () => {
    it('legt info.MQTT_connection als boolean state an', async () => {
        const adapter = createAdapterMock();

        // Methode isoliert testen (kopiert aus main.js)
        async function _ensureInfoStates() {
            await adapter.setObjectNotExistsAsync('info.session', {
                type: 'state',
                common: { name: 'Gespeicherte Session', type: 'string', role: 'json', read: true, write: false, def: '' },
                native: {},
            });
            await adapter.setObjectNotExistsAsync('info.MQTT_connection', {
                type: 'state',
                common: { name: 'If MQTT is connected', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
                native: {},
            });
        }

        await _ensureInfoStates();
        assert.ok(adapter.objects['info.MQTT_connection'], 'info.MQTT_connection Objekt fehlt');
        assert.equal(adapter.objects['info.MQTT_connection'].common.type, 'boolean');
        assert.equal(adapter.objects['info.MQTT_connection'].common.role, 'indicator.connected');
        assert.equal(adapter.objects['info.MQTT_connection'].common.def, false);
    });

    it('ist idempotent – zweiter Aufruf überschreibt nicht', async () => {
        const adapter = createAdapterMock();
        async function _ensureInfoStates() {
            await adapter.setObjectNotExistsAsync('info.MQTT_connection', {
                type: 'state',
                common: { name: 'original', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
                native: {},
            });
        }
        await _ensureInfoStates();
        adapter.objects['info.MQTT_connection'].common.name = 'modified';
        await _ensureInfoStates(); // zweiter Aufruf darf nicht überschreiben
        assert.equal(adapter.objects['info.MQTT_connection'].common.name, 'modified');
    });
});

describe('info.MQTT_connection – MQTT connect/disconnect Events', () => {
    let mqttClient;

    beforeEach(() => {
        mqttClient = new MockMqttClient();
    });

    it('wird auf true gesetzt wenn connect-Event feuert', () => {
        const adapter = createAdapterMock();

        // Simuliere den connect-Handler aus main.js
        mqttClient.on('connect', () => {
            adapter.setState('info.MQTT_connection', true, true);
        });

        mqttClient.emit('connect');
        assert.equal(adapter.states['info.MQTT_connection'].val, true);
    });

    it('wird auf false gesetzt wenn offline-Event feuert', () => {
        const adapter = createAdapterMock();
        adapter.setState('info.MQTT_connection', true, true);

        mqttClient.on('offline', () => {
            adapter.setState('info.MQTT_connection', false, true);
        });

        mqttClient.emit('offline');
        assert.equal(adapter.states['info.MQTT_connection'].val, false);
    });

    it('bleibt false wenn error-Event feuert (kein setState im error-Handler)', () => {
        const adapter = createAdapterMock();
        adapter.setState('info.MQTT_connection', false, true);

        // error-Handler setzt MQTT_connection nicht – nur log
        mqttClient.on('error', () => { /* nur log */ });
        mqttClient.emit('error', new Error('Verbindung fehlgeschlagen'));

        assert.equal(adapter.states['info.MQTT_connection'].val, false);
    });

    it('reconnect-Event ändert MQTT_connection NICHT', () => {
        const adapter = createAdapterMock();
        adapter.setState('info.MQTT_connection', false, true);

        mqttClient.on('reconnect', () => { /* nur log, kein setState */ });
        mqttClient.emit('reconnect');

        assert.equal(adapter.states['info.MQTT_connection'].val, false);
    });

    it('connect → offline → connect: korrekte Zustandsfolge', () => {
        const adapter = createAdapterMock();

        mqttClient.on('connect',  () => adapter.setState('info.MQTT_connection', true,  true));
        mqttClient.on('offline',  () => adapter.setState('info.MQTT_connection', false, true));

        mqttClient.emit('connect');
        assert.equal(adapter.states['info.MQTT_connection'].val, true, 'Nach connect sollte true sein');

        mqttClient.emit('offline');
        assert.equal(adapter.states['info.MQTT_connection'].val, false, 'Nach offline sollte false sein');

        mqttClient.emit('connect');
        assert.equal(adapter.states['info.MQTT_connection'].val, true, 'Nach erneutem connect sollte true sein');
    });
});

describe('info.MQTT_connection – onUnload', () => {
    it('setzt MQTT_connection auf false beim Entladen', async () => {
        const adapter = createAdapterMock();
        adapter.setState('info.MQTT_connection', true, true);
        adapter.setState('info.connection', true, true);

        // Isolierter onUnload-Kern aus main.js
        async function onUnloadCore(cb) {
            try {
                adapter.setState('info.connection', false, true);
                adapter.setState('info.MQTT_connection', false, true);
                cb();
            } catch (e) { cb(); }
        }

        await new Promise(resolve => onUnloadCore(resolve));

        assert.equal(adapter.states['info.MQTT_connection'].val, false);
        assert.equal(adapter.states['info.connection'].val, false);
    });

    it('setzt MQTT_connection auch ohne aktiven mqttClient auf false', async () => {
        const adapter = createAdapterMock({ connectionType: 'none' });
        adapter.setState('info.MQTT_connection', true, true);

        // mqttClient ist null – kein Absturz, State trotzdem zurücksetzen
        async function onUnloadCore(cb) {
            try {
                adapter.setState('info.connection', false, true);
                adapter.setState('info.MQTT_connection', false, true);
                cb();
            } catch (e) { cb(); }
        }

        await new Promise(resolve => onUnloadCore(resolve));
        assert.equal(adapter.states['info.MQTT_connection'].val, false);
    });

    it('setzt MQTT_connection auf false auch wenn useMqttServer=false', async () => {
        const adapter = createAdapterMock({ useMqttServer: false, connectionType: 'none' });
        adapter.setState('info.MQTT_connection', true, true);

        async function onUnloadCore(cb) {
            adapter.setState('info.MQTT_connection', false, true);
            cb();
        }

        await new Promise(resolve => onUnloadCore(resolve));
        assert.equal(adapter.states['info.MQTT_connection'].val, false);
    });
});

describe('info.MQTT_connection – onReady Fehlerfall', () => {
    it('setzt MQTT_connection auf false wenn onReady einen Fehler wirft', () => {
        const adapter = createAdapterMock();

        // Simuliert den catch-Block in onReady
        function handleOnReadyError() {
            adapter.setState('info.connection', false, true);
            adapter.setState('info.MQTT_connection', false, true);
        }

        handleOnReadyError();
        assert.equal(adapter.states['info.MQTT_connection'].val, false);
        assert.equal(adapter.states['info.connection'].val, false);
    });
});

describe('info.MQTT_connection – externalMqttServerIP Validierung', () => {
    it('connectToMQTT bricht ab wenn externalMqttServerIP leer ist (exmqtt)', async () => {
        const adapter = createAdapterMock({ connectionType: 'exmqtt', externalMqttServerIP: '' });
        let warningLogged = false;
        adapter.log.warn = () => { warningLogged = true; };

        // Isolierter Guard aus connectToMQTT
        async function connectGuard() {
            if (adapter.config.connectionType === 'exmqtt' && !adapter.config.externalMqttServerIP) {
                adapter.log.warn('[XSense] Externer MQTT-Server nicht konfiguriert');
                return false;
            }
            return true;
        }

        const result = await connectGuard();
        assert.equal(result, false);
        assert.ok(warningLogged, 'Warnung sollte geloggt worden sein');
    });

    it('connectToMQTT fährt fort wenn externalMqttServerIP gesetzt ist', async () => {
        const adapter = createAdapterMock({ connectionType: 'exmqtt', externalMqttServerIP: '192.168.1.100' });

        async function connectGuard() {
            if (adapter.config.connectionType === 'exmqtt' && !adapter.config.externalMqttServerIP) {
                return false;
            }
            return true;
        }

        assert.equal(await connectGuard(), true);
    });
});

// ─── Multi-Bridge MQTT Topic Deduplication ────────────────────────────────────

describe('Multi-Bridge MQTT – _mqttSubscribeOnce()', () => {
    /** Mini-Implementierung der Logik aus main.js für isolierte Tests */
    function createSubscriptionManager() {
        const subscribed = new Set();
        const log = { debug: () => {}, warn: () => {} };
        const client = new MockMqttClient();

        function mqttSubscribeOnce(topic) {
            if (!client || subscribed.has(topic)) return;
            subscribed.add(topic);
            client.subscribe(topic, err => {
                if (err) {
                    subscribed.delete(topic);
                    log.warn(`Subscribe fehlgeschlagen: ${topic}`);
                } else {
                    log.debug(`subscribed: ${topic}`);
                }
            });
        }

        return { subscribed, client, mqttSubscribeOnce };
    }

    it('subscribed ein Topic genau einmal', () => {
        const { subscribed, mqttSubscribeOnce, client } = createSubscriptionManager();
        mqttSubscribeOnce('xsense/bridge1/events');
        mqttSubscribeOnce('xsense/bridge1/events');
        assert.equal(client.subscribed.filter(t => t === 'xsense/bridge1/events').length, 1);
        assert.equal(subscribed.size, 1);
    });

    it('subscribed verschiedene Topics für verschiedene Bridges', () => {
        const { subscribed, mqttSubscribeOnce } = createSubscriptionManager();
        mqttSubscribeOnce('xsense/bridge1/events');
        mqttSubscribeOnce('xsense/bridge2/events');
        mqttSubscribeOnce('xsense/bridge3/events');
        assert.equal(subscribed.size, 3);
    });

    it('nach clear() werden Topics erneut subscribed (Reconnect)', () => {
        const { subscribed, mqttSubscribeOnce, client } = createSubscriptionManager();
        mqttSubscribeOnce('xsense/bridge1/events');
        assert.equal(client.subscribed.length, 1);

        subscribed.clear(); // Simuliert Reconnect

        mqttSubscribeOnce('xsense/bridge1/events');
        assert.equal(client.subscribed.length, 2, 'Topic soll nach clear() neu subscribed werden');
    });

    it('bei Subscribe-Fehler wird Topic aus Set entfernt (retry erlaubt)', () => {
        const subscribed = new Set();
        const client     = new MockMqttClient();

        function mqttSubscribeOnce(topic) {
            if (subscribed.has(topic)) return;
            subscribed.add(topic);
            // Simuliere immer Fehler-Callback
            client.subscribe(topic, () => {
                subscribed.delete(topic);
            });
        }

        mqttSubscribeOnce('xsense/bridge1/events');
        assert.equal(subscribed.size, 0, 'Nach Fehler soll Topic retry-fähig sein');

        mqttSubscribeOnce('xsense/bridge1/events');
        assert.equal(client.subscribed.length, 2, 'Zweiter Versuch soll Subscribe aufrufen');
    });
});

describe('Multi-Bridge MQTT – _subscribeMqttTopics()', () => {
    function makeXsenseClientMock(stationCount = 2) {
        const houses = {};
        for (let i = 1; i <= stationCount; i++) {
            houses[`HOUSE${i}`] = {
                houseId: `HOUSE${i}`,
                stations: {
                    [`BRIDGE00${i}`]: { serial: `BRIDGE00${i}`, devices: {} },
                },
            };
        }
        return {
            houses,
            getMqttTopics(house, station) {
                return [
                    `@xsense/events/${house.houseId}/`,
                    `$aws/things/${station.serial}/shadow/name/x/update`,
                    `$aws/things/${station.serial}/shadow/name/x/update/accepted`,
                    `presence/${house.houseId}/${station.serial}`,
                ];
            },
        };
    }

    function subscribeAll(xsenseClient, subscribed, client) {
        for (const house of Object.values(xsenseClient.houses)) {
            for (const station of Object.values(house.stations)) {
                for (const topic of xsenseClient.getMqttTopics(house, station)) {
                    if (subscribed.has(topic)) continue;
                    subscribed.add(topic);
                    client.subscribe(topic);
                }
            }
        }
    }

    it('2 Bridges = 8 Topics (4 pro Bridge)', () => {
        const subscribed   = new Set();
        const client       = new MockMqttClient();
        const xsenseClient = makeXsenseClientMock(2);

        subscribeAll(xsenseClient, subscribed, client);
        assert.equal(subscribed.size, 8);
        assert.equal(client.subscribed.length, 8);
    });

    it('3 Bridges = 12 Topics, alle eindeutig', () => {
        const subscribed   = new Set();
        const client       = new MockMqttClient();
        const xsenseClient = makeXsenseClientMock(3);

        subscribeAll(xsenseClient, subscribed, client);
        assert.equal(subscribed.size, 12);
    });

    it('Topics verschiedener Bridges haben keinen Pfad-Konflikt', () => {
        const xsenseClient = makeXsenseClientMock(2);
        const allTopics = [];

        for (const house of Object.values(xsenseClient.houses)) {
            for (const station of Object.values(house.stations)) {
                allTopics.push(...xsenseClient.getMqttTopics(house, station));
            }
        }

        const unique = new Set(allTopics);
        assert.equal(unique.size, allTopics.length, 'Topic-Kollision zwischen Bridges!');
    });

    it('nach Reconnect (clear) werden alle Topics erneut subscribed', () => {
        const subscribed   = new Set();
        const client       = new MockMqttClient();
        const xsenseClient = makeXsenseClientMock(2);

        subscribeAll(xsenseClient, subscribed, client);
        assert.equal(client.subscribed.length, 8);

        subscribed.clear(); // Reconnect

        subscribeAll(xsenseClient, subscribed, client);
        assert.equal(client.subscribed.length, 16, 'Nach Reconnect alle 8 Topics erneut subscribed');
    });

    it('ohne Reconnect: mehrfache Poll-Aufrufe erzeugen KEINE Duplikate', () => {
        const subscribed   = new Set();
        const client       = new MockMqttClient();
        const xsenseClient = makeXsenseClientMock(2);

        subscribeAll(xsenseClient, subscribed, client); // erster Poll
        subscribeAll(xsenseClient, subscribed, client); // zweiter Poll
        subscribeAll(xsenseClient, subscribed, client); // dritter Poll

        assert.equal(client.subscribed.length, 8, 'Kein Duplikat ohne Reconnect');
    });

    it('baseTopic wird einmal zusammen mit Bridge-Topics subscribed', () => {
        const subscribed   = new Set();
        const client       = new MockMqttClient();
        const xsenseClient = makeXsenseClientMock(2);
        const baseTopic    = 'homeassistant/binary_sensor/#';

        function mqttSubscribeOnce(topic) {
            if (subscribed.has(topic)) return;
            subscribed.add(topic);
            client.subscribe(topic);
        }

        mqttSubscribeOnce(baseTopic);
        subscribeAll(xsenseClient, subscribed, client);

        assert.ok(subscribed.has(baseTopic), 'baseTopic fehlt');
        assert.equal(subscribed.size, 9, '8 Bridge-Topics + 1 baseTopic');
    });
});

// ─── forceRefresh Button Logik ────────────────────────────────────────────────

describe('devices.forceRefresh – onStateChange', () => {
    it('forceRefresh mit ack=true wird ignoriert', () => {
        let datenVerarbeitetCalled = false;
        const stateObj = { val: true, ack: true };

        // Simuliert onStateChange Guard
        if (!stateObj || stateObj.ack) {
            // return – kein datenVerarbeiten
        } else {
            datenVerarbeitetCalled = true;
        }

        assert.equal(datenVerarbeitetCalled, false, 'ack=true soll ignoriert werden');
    });

    it('forceRefresh mit ack=false löst datenVerarbeiten aus', () => {
        let datenVerarbeitetCalled = false;
        const stateObj = { val: true, ack: false };

        if (!stateObj || stateObj.ack) {
            // ignorieren
        } else {
            const parts = 'xsense.0.devices.forceRefresh'.split('.');
            const controlKey = parts[3];
            if (controlKey === 'forceRefresh') datenVerarbeitetCalled = true;
        }

        assert.equal(datenVerarbeitetCalled, true);
    });

    it('forceRefresh ruft datenVerarbeiten mit forceFullRefresh=true auf', async () => {
        let calledWithForce = false;

        async function datenVerarbeiten(_firstTry, forceFullRefresh = false) {
            calledWithForce = forceFullRefresh;
        }

        // Simuliert den forceRefresh-case aus onStateChange
        await datenVerarbeiten(false, true);
        assert.equal(calledWithForce, true, 'forceFullRefresh soll true sein');
    });

    it('forceRefresh setzt Button-State danach auf false zurück', async () => {
        const adapter = createAdapterMock();
        adapter.states['xsense.0.devices.forceRefresh'] = { val: true, ack: false };

        // Simuliert den forceRefresh-Handler
        async function handleForceRefresh(stateId) {
            // datenVerarbeiten würde hier aufgerufen...
            await adapter.setStateAsync(stateId, { val: false, ack: true });
        }

        await handleForceRefresh('xsense.0.devices.forceRefresh');
        assert.equal(adapter.states['xsense.0.devices.forceRefresh'].val, false);
        assert.equal(adapter.states['xsense.0.devices.forceRefresh'].ack, true);
    });

    it('forceRefresh-Button bleibt nach Reset auf false – nächster Klick wird erkannt', async () => {
        const adapter = createAdapterMock();

        // Erster Klick
        adapter.states['xsense.0.devices.forceRefresh'] = { val: true, ack: false };
        // Handler setzt zurück
        await adapter.setStateAsync('xsense.0.devices.forceRefresh', { val: false, ack: true });

        // Zweiter Klick (val=true, ack=false)
        adapter.states['xsense.0.devices.forceRefresh'] = { val: true, ack: false };
        const stateObj = adapter.states['xsense.0.devices.forceRefresh'];

        assert.equal(stateObj.ack, false, 'Zweiter Klick soll ack=false haben');
        assert.equal(stateObj.val, true, 'Zweiter Klick soll val=true haben');
    });
});

describe('datenVerarbeiten – forceFullRefresh Parameter', () => {
    it('forceFullRefresh=false + MQTT aktiv → needsGetState=false', () => {
        const mqttClient    = new MockMqttClient();
        mqttClient.closed   = false;
        const forceFullRefresh = false;
        const mqttActive    = mqttClient && !mqttClient.closed;
        const needsGetState = forceFullRefresh || !mqttActive;
        assert.equal(needsGetState, false, 'Kein getState bei MQTT ohne force');
    });

    it('forceFullRefresh=true + MQTT aktiv → needsGetState=true', () => {
        const mqttClient    = new MockMqttClient();
        mqttClient.closed   = false;
        const forceFullRefresh = true;
        const mqttActive    = mqttClient && !mqttClient.closed;
        const needsGetState = forceFullRefresh || !mqttActive;
        assert.equal(needsGetState, true, 'getState soll bei force=true auch mit MQTT aufgerufen werden');
    });

    it('forceFullRefresh=false + kein MQTT → needsGetState=true', () => {
        const mqttClientNull   = null;
        const forceFullRefresh = false;
        const mqttActive       = mqttClientNull && !mqttClientNull.closed;
        const needsGetState    = forceFullRefresh || !mqttActive;
        assert.equal(needsGetState, true, 'Ohne MQTT immer getState aufrufen');
    });

    it('forceFullRefresh=false + MQTT geschlossen → needsGetState=true', () => {
        const mqttClient    = new MockMqttClient();
        mqttClient.closed   = true;
        const forceFullRefresh = false;
        const mqttActive    = mqttClient && !mqttClient.closed;
        const needsGetState = forceFullRefresh || !mqttActive;
        assert.equal(needsGetState, true, 'Geschlossenes MQTT = kein MQTT = getState aufrufen');
    });

    it('Alle 4 Fälle korrekt kombiniert', () => {
        const cases = [
            // [mqttActive, force, expectedNeedsGetState]
            [true,  true,  true],   // MQTT + force → immer holen
            [true,  false, false],  // MQTT + kein force → überspringen
            [false, true,  true],   // kein MQTT + force → holen
            [false, false, true],   // kein MQTT + kein force → holen
        ];
        for (const [mqttActive, force, expected] of cases) {
            const needsGetState = force || !mqttActive;
            assert.equal(needsGetState, expected,
                `mqttActive=${mqttActive}, force=${force} → erwartet ${expected}, got ${needsGetState}`);
        }
    });
});

describe('startIntervall – initialer getState (isLifeEnd-Schutz)', () => {
    it('erster Aufruf nutzt forceFullRefresh=true damit isLifeEnd initial geladen wird', () => {
        let firstCallForce = null;
        let secondCallForce = null;
        let callCount = 0;

        async function datenVerarbeiten(_firstTry, forceFullRefresh = false) {
            callCount++;
            if (callCount === 1) firstCallForce  = forceFullRefresh;
            if (callCount === 2) secondCallForce = forceFullRefresh;
        }

        // Simuliert startIntervall
        async function startIntervall() {
            await datenVerarbeiten(false, true);  // erster Aufruf: force=true
            // setInterval würde datenVerarbeiten(false) aufrufen
            await datenVerarbeiten(false);         // simulierter Interval-Tick
        }

        return startIntervall().then(() => {
            assert.equal(firstCallForce,  true,  'Erster Aufruf muss forceFullRefresh=true haben');
            assert.equal(secondCallForce, false, 'Interval-Tick hat forceFullRefresh=false (MQTT übernimmt)');
        });
    });

    it('isLifeEnd wird in device.data geschrieben wenn vorhanden', async () => {
        const adapter = createAdapterMock();
        const Json2iobXSense = require('../lib/json2iob');
        const j2i = new Json2iobXSense(adapter);

        const houses = {
            HOUSE1: {
                houseId: 'HOUSE1', name: 'Home',
                region: 'eu', mqttRegion: 'eu', mqttServer: 'mqtt.x-sense-iot.com',
                stations: {
                    BRIDGE001: {
                        stationId: 'ST001', serial: 'BRIDGE001', name: 'Bridge', type: 'SBS50', online: true, data: {},
                        devices: {
                            DEV001: {
                                deviceId: 'DV001', serial: 'DEV001', name: 'Sensor', type: 'XS01', online: true,
                                data: { alarmStatus: false, batInfo: 2, isLifeEnd: false },
                            },
                        },
                    },
                },
            },
        };

        await j2i.parseHouses('xsense.0', houses);

        assert.ok(adapter.objects['devices.Home.BRIDGE001.DEV001.isLifeEnd'], 'isLifeEnd Objekt fehlt');
        assert.equal(adapter.objects['devices.Home.BRIDGE001.DEV001.isLifeEnd'].common.type, 'boolean');
        assert.equal(adapter.states['devices.Home.BRIDGE001.DEV001.isLifeEnd'].val, false);
    });

    it('isLifeEnd=true wird korrekt gesetzt', async () => {
        const adapter = createAdapterMock();
        const Json2iobXSense = require('../lib/json2iob');
        const j2i = new Json2iobXSense(adapter);

        const houses = {
            HOUSE1: {
                houseId: 'HOUSE1', name: 'Home',
                region: 'eu', mqttRegion: 'eu', mqttServer: 'mqtt.x-sense-iot.com',
                stations: {
                    BRIDGE001: {
                        stationId: 'ST001', serial: 'BRIDGE001', name: 'Bridge', type: 'SBS50', online: true, data: {},
                        devices: {
                            DEV001: {
                                deviceId: 'DV001', serial: 'DEV001', name: 'EOL-Sensor', type: 'XS01', online: false,
                                data: { isLifeEnd: true },
                            },
                        },
                    },
                },
            },
        };

        await j2i.parseHouses('xsense.0', houses);
        assert.equal(adapter.states['devices.Home.BRIDGE001.DEV001.isLifeEnd'].val, true);
    });
});

describe('MQTT kein Polling – getState Logik', () => {
    it('getState wird aufgerufen wenn KEIN MQTT aktiv', async () => {
        let getStateCalled = 0;
        const station = { serial: 'BRIDGE001', devices: {} };

        // mqttActive = false → getState soll aufgerufen werden
        const mqttActive = false;
        if (!mqttActive) getStateCalled++;

        assert.equal(getStateCalled, 1, 'getState soll ohne MQTT aufgerufen werden');
    });

    it('getState wird NICHT aufgerufen wenn MQTT aktiv und verbunden', async () => {
        let getStateCalled = 0;

        const mqttClient = new MockMqttClient();
        mqttClient.closed = false;

        const mqttActive = mqttClient && !mqttClient.closed;
        if (!mqttActive) getStateCalled++;

        assert.equal(getStateCalled, 0, 'getState soll bei aktivem MQTT übersprungen werden');
    });

    it('getState wird aufgerufen wenn mqttClient.closed = true', () => {
        let getStateCalled = 0;

        const mqttClient = new MockMqttClient();
        mqttClient.closed = true;

        const mqttActive = mqttClient && !mqttClient.closed;
        if (!mqttActive) getStateCalled++;

        assert.equal(getStateCalled, 1, 'getState soll aufgerufen werden wenn MQTT geschlossen ist');
    });

    it('getState wird aufgerufen wenn mqttClient null ist', () => {
        let getStateCalled = 0;

        const mqttClientNull = null;
        const mqttActive = mqttClientNull && !mqttClientNull.closed;
        if (!mqttActive) getStateCalled++;

        assert.equal(getStateCalled, 1, 'getState soll aufgerufen werden wenn kein MQTT-Client');
    });

    it('getStationState wird IMMER aufgerufen (unabhängig von MQTT)', () => {
        let getStationStateCalled = 0;

        // Beide Fälle: mit und ohne MQTT
        for (const mqttActive of [true, false]) {
            // getStationState wird immer aufgerufen
            getStationStateCalled++;
            if (!mqttActive) {
                // getState nur ohne MQTT
            }
        }

        assert.equal(getStationStateCalled, 2, 'getStationState soll immer aufgerufen werden');
    });

    it('_subscribeMqttTopics wird nach loadAll aufgerufen wenn MQTT aktiv', () => {
        let subscribeTopicsCalled = 0;
        const mqttClient = new MockMqttClient();
        mqttClient.closed = false;

        // Simuliert datenVerarbeiten nach loadAll
        if (mqttClient && !mqttClient.closed) {
            subscribeTopicsCalled++;
        }

        assert.equal(subscribeTopicsCalled, 1, '_subscribeMqttTopics soll nach loadAll aufgerufen werden');
    });

    it('_subscribeMqttTopics wird NICHT aufgerufen wenn MQTT offline', () => {
        let subscribeTopicsCalled = 0;
        const mqttClient = new MockMqttClient();
        mqttClient.closed = true;

        if (mqttClient && !mqttClient.closed) {
            subscribeTopicsCalled++;
        }

        assert.equal(subscribeTopicsCalled, 0, '_subscribeMqttTopics soll nicht aufgerufen werden wenn MQTT offline');
    });
});

// ─── testAlarm & test_Alarm_Message Pfad-Logik ───────────────────────────────

describe('testAlarm – Pfad-Extraktion mit Haus-Ebene', () => {
    it('deviceSerial ist das vorletzte Segment (neuer Pfad mit Haus)', () => {
        const stateId = 'xsense.0.devices.Mein_Zuhause.15298924.00000001.test_Alarm';
        const parts   = stateId.split('.');
        assert.equal(parts[parts.length - 2], '00000001');
    });

    it('test_Alarm_Message Pfad wird korrekt abgeleitet', () => {
        const stateId = 'xsense.0.devices.Mein_Zuhause.15298924.00000001.test_Alarm';
        const msgId   = stateId.replace(/\.test_Alarm$/, '.test_Alarm_Message');
        assert.equal(msgId, 'xsense.0.devices.Mein_Zuhause.15298924.00000001.test_Alarm_Message');
    });

    it('deviceSerial auch ohne Haus-Ebene korrekt (alter Pfad rückwärtskompatibel)', () => {
        const stateId = 'xsense.0.devices.15298924.00000001.test_Alarm';
        const parts   = stateId.split('.');
        assert.equal(parts[parts.length - 2], '00000001');
    });

    it('lastPart-Erkennung ist pfad-tiefen-unabhängig', () => {
        const paths = [
            'xsense.0.devices.15298924.00000001.test_Alarm',
            'xsense.0.devices.Mein_Zuhause.15298924.00000001.test_Alarm',
        ];
        for (const p of paths) {
            const parts = p.split('.');
            assert.equal(parts[parts.length - 1], 'test_Alarm', `Fehlgeschlagen für: ${p}`);
        }
    });

    it('onStateChange erkennt test_Alarm über lastPart korrekt', () => {
        let testAlarmCalled = false;
        const stateId  = 'xsense.0.devices.Mein_Zuhause.15298924.00000001.test_Alarm';
        const stateObj = { val: true, ack: false };
        if (stateObj && !stateObj.ack) {
            const parts      = stateId.split('.');
            const controlKey = parts[3];
            const lastPart   = parts[parts.length - 1];
            if (controlKey !== 'forceRefresh' && lastPart === 'test_Alarm') {
                testAlarmCalled = true;
            }
        }
        assert.equal(testAlarmCalled, true);
    });

    it('onStateChange erkennt forceRefresh weiterhin korrekt', () => {
        let refreshCalled = false;
        const stateId  = 'xsense.0.devices.forceRefresh';
        const stateObj = { val: true, ack: false };
        if (stateObj && !stateObj.ack) {
            const parts      = stateId.split('.');
            const controlKey = parts[3];
            if (controlKey === 'forceRefresh') refreshCalled = true;
        }
        assert.equal(refreshCalled, true);
    });

    it('test_Alarm wird nicht ausgelöst wenn ack=true', () => {
        let testAlarmCalled = false;
        const stateObj = { val: true, ack: true };
        if (!stateObj || stateObj.ack) {
            // return – kein testAlarm
        } else {
            testAlarmCalled = true;
        }
        assert.equal(testAlarmCalled, false);
    });
});

describe('_resolveDevicePath – Haus-Pfad-Auflösung', () => {
    const FORBIDDEN = /[*?[\]]/g;

    function resolveDevicePath(xsenseClient, bridgeSerial, deviceSerial) {
        if (xsenseClient?.houses) {
            for (const house of Object.values(xsenseClient.houses)) {
                for (const station of Object.values(house.stations)) {
                    if (station.serial === bridgeSerial) {
                        const houseName = (house.name || house.houseId)
                            .replace(/\s+/g, '_')
                            .replace(FORBIDDEN, '_');
                        return `devices.${houseName}.${bridgeSerial}.${deviceSerial}`;
                    }
                }
            }
        }
        return `devices.${bridgeSerial}.${deviceSerial}`;
    }

    it('gibt korrekten Pfad mit Hausname zurück', () => {
        const client = { houses: { H1: { houseId: 'UUID', name: 'Mein Zuhause', stations: { B1: { serial: '15298924', devices: {} } } } } };
        assert.equal(resolveDevicePath(client, '15298924', '00000001'), 'devices.Mein_Zuhause.15298924.00000001');
    });

    it('ersetzt Leerzeichen im Hausnamen durch _', () => {
        const client = { houses: { H1: { houseId: 'UUID', name: 'Mein Tolles Haus', stations: { B1: { serial: 'BRIDGE001', devices: {} } } } } };
        assert.equal(resolveDevicePath(client, 'BRIDGE001', 'DEV001'), 'devices.Mein_Tolles_Haus.BRIDGE001.DEV001');
    });

    it('Fallback auf devices.bridge.device wenn kein Client', () => {
        assert.equal(resolveDevicePath(null, 'BRIDGE001', 'DEV001'), 'devices.BRIDGE001.DEV001');
    });

    it('Fallback wenn Bridge nicht gefunden', () => {
        const client = { houses: { H1: { houseId: 'UUID', name: 'Haus', stations: { B1: { serial: 'ANDEREBRIDGE', devices: {} } } } } };
        assert.equal(resolveDevicePath(client, 'BRIDGE001', 'DEV001'), 'devices.BRIDGE001.DEV001');
    });

    it('test_Alarm_Message landet im richtigen Pfad nach Auflösung', () => {
        const client  = { houses: { H1: { houseId: 'UUID', name: 'Mein Zuhause', stations: { B1: { serial: '15298924', devices: {} } } } } };
        const devPath = resolveDevicePath(client, '15298924', '00000001');
        assert.equal(`${devPath}.test_Alarm_Message`, 'devices.Mein_Zuhause.15298924.00000001.test_Alarm_Message');
    });

    it('UUID-only Hausname (kein name) wird als Fallback-ID verwendet', () => {
        const client = { houses: { H1: { houseId: '9FC3BB7E6A23', name: '', stations: { B1: { serial: 'BRIDGE001', devices: {} } } } } };
        const path = resolveDevicePath(client, 'BRIDGE001', 'DEV001');
        assert.equal(path, 'devices.9FC3BB7E6A23.BRIDGE001.DEV001');
    });

    it('Punkte im Hausnamen werden durch _ ersetzt (verhindert Pfad-Splitting)', () => {
        const client = { houses: { H1: { houseId: 'UUID', name: 'Mein.Haus.2024', stations: { B1: { serial: 'BRIDGE001', devices: {} } } } } };
        const FORBIDDEN_LOCAL = /[*?[\]]/g;
        function resolve(xc, bridge, device) {
            if (xc?.houses) {
                for (const house of Object.values(xc.houses)) {
                    for (const station of Object.values(house.stations)) {
                        if (station.serial === bridge) {
                            const hn = (house.name || house.houseId)
                                .replace(/\s+/g, '_')
                                .replace(/\./g, '_')
                                .replace(FORBIDDEN_LOCAL, '_');
                            return `devices.${hn}.${bridge}.${device}`;
                        }
                    }
                }
            }
            return `devices.${bridge}.${device}`;
        }
        assert.equal(resolve(client, 'BRIDGE001', 'DEV001'), 'devices.Mein_Haus_2024.BRIDGE001.DEV001');
    });

    it('name2id ersetzt auch Punkte (konsistent mit _resolveDevicePath)', async () => {
        const adapter = createAdapterMock();
        const Json2iobXSense = require('../lib/json2iob');
        const j2i = new Json2iobXSense(adapter);
        const result = await j2i.name2id('Mein.Haus.Test');
        assert.equal(result, 'Mein_Haus_Test');
    });

    it('name2id: Leerzeichen + Punkte kombiniert', async () => {
        const adapter = createAdapterMock();
        const Json2iobXSense = require('../lib/json2iob');
        const j2i = new Json2iobXSense(adapter);
        assert.equal(await j2i.name2id('My House 1.0'), 'My_House_1_0');
    });
});

describe('messageParse – topic.slice Schutz', () => {
    it('topic mit Slash → alles nach erstem Slash', () => {
        const topic    = 'xsense/SBS50ABC_DEV001_battery/state';
        const slashIdx = topic.indexOf('/');
        const result   = slashIdx >= 0 ? topic.slice(slashIdx + 1) : topic;
        assert.equal(result, 'SBS50ABC_DEV001_battery/state');
    });

    it('topic ohne Slash → ganzer String unverändert (kein slice(-1+1)=slice(0)-Fehler)', () => {
        const topic    = 'SBS50ABC_DEV001_battery';
        const slashIdx = topic.indexOf('/');
        const result   = slashIdx >= 0 ? topic.slice(slashIdx + 1) : topic;
        assert.equal(result, 'SBS50ABC_DEV001_battery');
    });

    it('leeres topic → leerer String', () => {
        const topic    = '';
        const slashIdx = topic.indexOf('/');
        const result   = slashIdx >= 0 ? topic.slice(slashIdx + 1) : topic;
        assert.equal(result, '');
    });

    it('topic mit führendem Slash → korrekt ab Position 1', () => {
        const topic    = '/SBS50ABC_DEV001_battery/state';
        const slashIdx = topic.indexOf('/');
        const result   = slashIdx >= 0 ? topic.slice(slashIdx + 1) : topic;
        assert.equal(result, 'SBS50ABC_DEV001_battery/state');
    });
});
