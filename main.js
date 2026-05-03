'use strict';

const utils = require('@iobroker/adapter-core');
const {XSenseClient} = require('./lib/xsenseClient');
const Json2iobXSense = require('./lib/json2iob');
const MqttServerController = require('./lib/mqttServerController').MqttServerController;
const DeviceController = require('./lib/deviceController').DeviceController;
const mqtt = require('mqtt');
const tools = require('./lib/tools');

global.fetch = require('node-fetch-commonjs');

// ─── Modul-globale MQTT-Objekte ───────────────────────────────────────────────
let mqttServerController;
let mqttClient;
let messageParseMutex = Promise.resolve();

// ─────────────────────────────────────────────────────────────────────────────
class XSenseAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({...options, name: 'xsense'});

        this.json2iob = new Json2iobXSense(this);
        this.xsenseClient = null;
        this.deviceController = null;
        this._requestInterval = null;
        this.houseCache = null; // Cache für Haus-Objekte (für MQTT-Topic-Auflösung)

        /** Bereits beim MQTT-Broker subscribed Topics – verhindert Duplikate */
        this._mqttSubscribedTopics = new Set();

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // ─── onReady ─────────────────────────────────────────────────────────────

    async onReady() {
        try {
            this.log.info('[XSense] Adapter startet...');

            await this.ensureInfoStates();
            await this.json2iob.createStaticDeviceObject();

            let loginGo = true;

            if (!this.config.userEmail) {
                this.log.error('[XSense] Kein Benutzername konfiguriert');
                loginGo = false;
            }
            if (!this.config.userPassword) {
                this.log.error('[XSense] Kein Passwort konfiguriert');
                loginGo = false;
            }

            // MQTT-Verbindung (unabhängig vom Cloud-Login)
            if (this.config.useMqttServer && loginGo) {
                await this.connectToMQTT();
            }

            if (!loginGo) {
                this.log.warn('[XSense] Login übersprungen – Konfiguration unvollständig');
                return;
            }

            this.deviceController = new DeviceController(
                this,
                this.houseCache,
                this.config
            );

            await this.setAllAvailableToFalse();

            // Session wiederherstellen oder neu einloggen
            this.xsenseClient = await this.initSession();

            if (this.xsenseClient) {
                this.setState('info.connection', true, true);
                await this.startIntervall();
            }
        } catch (err) {
            this.setState('info.connection', false, true);
            this.setState('info.MQTT_connection', false, true);
            this.log.error(`[XSense] onReady Fehler: ${err.message}`);
            this.log.debug(err.stack);
        }
    }

    // ─── Session-Management ───────────────────────────────────────────────────

    /**
     * Versucht die gespeicherte Session wiederherzustellen, loggt sich sonst frisch ein.
     *
     * @returns {Promise<XSenseClient>}
     */
    async initSession() {
        let client = null;

        // Gespeicherte Session laden
        const savedState = await this.getStateAsync('info.session');
        if (savedState?.val) {
            try {
                client = XSenseClient.deserialize(String(savedState.val), this.log);
                this.log.info('[XSense] Session aus Speicher wiederhergestellt');
            } catch (e) {
                this.log.warn(`[XSense] Session-Wiederherstellung fehlgeschlagen: ${e.message}`);
                client = null;
            }
        }

        // Client-Infos müssen immer neu geladen werden (init ist unauthenticated)
        client = client || new XSenseClient(this.log);
        await client.init();

        // Login wenn nötig
        if (client.isAccessTokenExpiring()) {
            this.log.info('[XSense] Führe Login durch...');
            await client.login(this.config.userEmail, this.config.userPassword);
            await this.saveSession(client);
            this.log.info('[XSense] Login erfolgreich');
        } else {
            this.log.info('[XSense] Nutze bestehende Session');
        }

        return client;
    }

    /**
     * Persistiert die Session in einem ioBroker-State.
     *
     * @param {XSenseClient} client
     */
    async saveSession(client) {
        try {
            this.setState('info.session', {val: client.serialize(), ack: true});
        } catch (e) {
            this.log.warn(`[XSense] Session konnte nicht gespeichert werden: ${e.message}`);
        }
    }

    // ─── Polling / Daten laden ────────────────────────────────────────────────

    async startIntervall() {
        this.log.debug('[XSense] startIntervall');

        // Erster Datenabruf: IMMER getState() aufrufen (forceFullRefresh=true)
        // → stellt sicher dass alle States (auch isLifeEnd, batInfo etc.) initial befüllt sind
        // → danach übernimmt MQTT die Live-Updates
        await this.datenVerarbeiten(false, true);

        // Interval: normaler Poll (MQTT überspringt getState wenn aktiv)
        if (!this._requestInterval) {
            this.log.info(`[XSense] Polling-Intervall gestartet: ${this.config.polltime}s`);
            this._requestInterval = this.setInterval(async () => {
                await this.datenVerarbeiten(false);
            }, this.config.polltime * 1000);
        }
    }

    async datenVerarbeiten(firstTry, forceFullRefresh = false) {
        this.log.debug('[XSense] datenVerarbeiten');

        try {
            // Tokens erneuern wenn nötig
            if (this.xsenseClient.isAccessTokenExpiring()) {
                this.log.debug('[XSense] Access-Token läuft ab, erneuere...');
                await this.xsenseClient.refresh();
                await this.saveSession(this.xsenseClient);
            }

            if (this.xsenseClient.isAwsTokenExpiring()) {
                this.log.debug('[XSense] AWS-Credentials laufen ab, erneuere...');
                await this.xsenseClient.loadAws();
            }

            // Alle Geräte laden (Struktur, Serials, Namen)
            await this.xsenseClient.loadAll();

            // MQTT-Topics nachziehen falls neue Stationen hinzukamen
            if (mqttClient && !mqttClient.closed) {
                this.subscribeMqttTopics();
                this.requestTemperatureUpdates();
            }

            // Gerätezustände:
            // - forceFullRefresh (manueller forceRefresh-Button): immer getState aufrufen
            // - MQTT aktiv: getState überspringen (Push liefert States in Echtzeit)
            // - kein MQTT:  getState per REST-API aufrufen
            const mqttActive = mqttClient && !mqttClient.closed;

            for (const house of Object.values(this.xsenseClient.houses)) {
                for (const station of Object.values(house.stations)) {
                    try {
                        // Station-eigene Daten (Bridge: wifiRSSI, sw-Version etc.) immer laden
                        await this.xsenseClient.getStationState(station);   // station-spezifische Daten immer laden (z.B. Bridge-Infos)
                        await this.xsenseClient.getState(station);              // Gerätezustände bei jedem Polling laden (auch mit MQTT, da manche Daten nicht per Push kommen)
                    } catch (e) {
                        this.log.warn(`[XSense] Zustand für Station ${station.serial} Fehler: ${e.message}`);
                    }
                }
            }

            // In ioBroker-States schreiben
            await this.json2iob.parseHouses(this.namespace, this.xsenseClient.houses);

            this.setState('info.connection', true, true);
            this.log.debug(`[XSense] datenVerarbeiten abgeschlossen (MQTT-aktiv: ${mqttActive}, force: ${forceFullRefresh})`);

        } catch (err) {
            this.log.error(`[XSense] datenVerarbeiten Fehler: ${err.message}`);
            this.setState('info.connection', false, true);

            // Bei abgelaufener Session neu einloggen
            if (err.message?.includes('SessionExpired') || err.message?.includes('401')) {
                this.log.info('[XSense] Session abgelaufen, versuche Re-Login...');
                try {
                    await this.xsenseClient.init();
                    await this.xsenseClient.login(this.config.userEmail, this.config.userPassword);
                    await this.saveSession(this.xsenseClient);
                    this.setState('info.connection', true, true);
                    this.log.info('[XSense] Re-Login erfolgreich');
                } catch (loginErr) {
                    this.log.error(`[XSense] Re-Login fehlgeschlagen: ${loginErr.message}`);
                }
            } else {
                this.errorMessage(err, firstTry);
            }
        }
    }

    // ─── MQTT Nachrichten-Parsing ─────────────────────────────────────────────

    /**
     * Löst den ioBroker-Pfad für Bridge+Device auf.
     * Berücksichtigt die neue Haus-Ordner-Ebene (devices.<Hausname>.<bridge>.<device>).
     *
     * @param {string} bridgeSerial
     * @param {string} deviceSerial
     * @returns {string}  z.B. "devices.Mein_Zuhause.15298924.00000001"
     */
    resolveDevicePath(bridgeSerial, deviceSerial) {
        if (this.xsenseClient?.houses) {
            for (const house of Object.values(this.xsenseClient.houses)) {
                for (const station of Object.values(house.stations)) {
                    if (station.serial === bridgeSerial) {
                        // Gleiche Bereinigung wie json2iob.name2id(): Leerzeichen + Punkte + FORBIDDEN_CHARS
                        const houseName = (house.name || house.houseId)
                            .replace(/\s+/g, '_')
                            .replace(/\./g, '_')
                            .replace(this.FORBIDDEN_CHARS, '_');
                        return `devices.${houseName}.${bridgeSerial}.${deviceSerial}`;
                    }
                }
            }
        }
        return `devices.${bridgeSerial}.${deviceSerial}`;
    }

    async messageParse(message) {
        // Mutex: parallele Aufrufe serialisieren
        let release = () => {
        };  // Default-Wert statt undefined
        const lock = new Promise(resolve => (release = resolve));
        const prev = messageParseMutex;
        messageParseMutex = lock;
        await prev;

        try {
            if (!tools.isJson(message)) {
                return;
            }

            const messageObj = JSON.parse(message);
            this.log.debug(`[XSense] MQTT Message: ${JSON.stringify(messageObj)}`);

            if (!messageObj.topic.includes('SBS50')) {
                this.log.error(
                    `[XSense] SBS50 nicht im Topic: ${messageObj.topic}. Prüfe ob eine SBS50-Bridge konfiguriert ist.`,
                );
                return;
            }

            const suffix = await this.getTopicSuffix(messageObj.topic);

            switch (suffix) {
                case 'state': {
                    const parts = messageObj.topic.split('/').filter(Boolean);
                    const findDp = parts.at(-2) ?? '';
                    const mTopic = findDp.match(/^SBS50([^_]+)_([^_]+)_(.+)$/);

                    const bridgeId = mTopic?.[1] ?? null;
                    const deviceId = mTopic?.[2] ?? null;
                    const attribute = mTopic?.[3] ?? null;

                    if (!bridgeId || !deviceId || !attribute) {
                        this.log.warn(`[XSense] Topic konnte nicht geparst werden: ${messageObj.topic}`);
                        return;
                    }

                    // Korrekten Pfad mit Haus-Ordner auflösen
                    const devicePath = this.resolveDevicePath(bridgeId, deviceId);

                    this.log.debug(`[XSense] Bridge=${bridgeId} Device=${deviceId} Attr=${attribute} → ${devicePath}`);

                    switch (attribute) {
                        case 'battery': {
                            const batLevel =
                                messageObj.payload.status === 'Normal' ? 3 :
                                    messageObj.payload.status === 'Low' ? 2 :
                                        messageObj.payload.status === 'Critical' ? 1 : 0;
                            this.setState(`${devicePath}.batInfo`, {val: batLevel, ack: true});
                            break;
                        }
                        case 'lifeend': {
                            const id = `${devicePath}.isLifeEnd`;
                            await this.setObjectNotExistsAsync(id, {
                                type: 'state',
                                common: {
                                    name: 'isLifeEnd',
                                    type: 'boolean',
                                    role: 'indicator',
                                    read: true,
                                    write: false
                                },
                                native: {},
                            });
                            this.setState(id, {val: messageObj.payload.status === 'EOL', ack: true});
                            break;
                        }
                        case 'online':
                            this.setState(`${devicePath}.online`, {
                                val: messageObj.payload.status === 'Online', ack: true,
                            });
                            break;

                        case 'smokealarm':
                        case 'heatalarm':
                        case 'coalarm':
                            this.setState(`${devicePath}.alarmStatus`, {
                                val: messageObj.payload.status === 'Detected', ack: true,
                            });
                            break;

                        case 'smokefault':
                        case 'heatfault':
                        case 'cofault':
                            // Fault-States – aktuell keine Aktion
                            break;

                        default:
                            this.log.warn(`[XSense] Unbekanntes Attribut in Topic: ${messageObj.topic} (${attribute})`);
                    }
                    break;
                }
                default:
                    break;
            }
        } finally {
            if (release) {
                release();
            }
        }
    }

    async getTopicSuffix(topic) {
        if (typeof topic !== 'string' || topic.length === 0) {
            return null;
        }
        const parts = topic.split('/').filter(Boolean);
        return parts.length ? parts[parts.length - 1] : null;
    }

    // ─── State-Change Handler ─────────────────────────────────────────────────

    async onStateChange(stateId, stateObj) {
        if (!stateObj || stateObj.ack) {
            return;
        }

        this.log.debug(`[XSense] State-Change: ${stateId}`);

        const parts = stateId.split('.');
        const controlKey = parts[3];   // 'forceRefresh' bei devices.forceRefresh
        const lastPart = parts[parts.length - 1]; // letztes Segment – unabhängig von Tiefe

        try {
            switch (controlKey) {
                case 'forceRefresh':
                    this.log.info('[XSense] Manueller Refresh ausgelöst...');
                    await this.datenVerarbeiten(false, true);
                    this.setState(stateId, {val: false, ack: true});
                    break;
                default:
                    // test_Alarm ist das letzte Segment – unabhängig von Haus-Ebene
                    if (lastPart === 'test_Alarm') {
                        await this.testAlarm(stateId);
                    }
            }
        } catch (err) {
            this.log.error(`[XSense] onStateChange Fehler: ${err.message}`);
        }
    }

    // ─── Testalarm ────────────────────────────────────────────────────────────

    /**
     * @param {string} stateId  z.B. "xsense.0.devices.Haus.BRIDGE.DEVICE.test_Alarm"
     */
    async testAlarm(stateId) {
        this.log.debug(`[XSense] testAlarm: ${stateId}`);

        // Pfad: xsense.0.devices.<Haus>.<bridge>.<deviceSerial>.test_Alarm
        // deviceSerial = vorletztes Segment
        const parts = stateId.split('.');
        const deviceSerial = parts[parts.length - 2];
        const msgStateId = stateId.replace(/\.test_Alarm$/, '.test_Alarm_Message');

        this.setState(msgStateId, {val: 'in progress...', ack: true});

        try {
            if (!this.xsenseClient) {
                throw new Error('XSenseClient nicht initialisiert');
            }
            const result = await this.xsenseClient.testAlarm(deviceSerial);
            this.setState(msgStateId, {val: result || 'done', ack: true});
        } catch (err) {
            this.log.error(`[XSense] testAlarm Fehler: ${err.message}`);
            this.setState(msgStateId, {val: `Fehler: ${err.message}`, ack: true});
        }
    }

    // ─── onUnload ─────────────────────────────────────────────────────────────

    async onUnload(callback) {
        try {
            if (['exmqtt', 'intmqtt'].includes(this.config.connectionType)) {
                if (mqttClient && !mqttClient.closed) {
                    try {
                        mqttClient.end();
                    } catch (e) {
                        this.log.error(e);
                    }
                }
            }

            if (this.config.connectionType === 'intmqtt') {
                try {
                    if (mqttServerController) {
                        mqttServerController.closeServer();
                    }
                } catch (e) {
                    this.log.error(e);
                }
            }

            if (this._requestInterval) {
                this.clearInterval(this._requestInterval);
                this._requestInterval = null;
            }

            await this.setAllAvailableToFalse();
            // Immer beide Connection-States zurücksetzen
            this.setState('info.connection', false, true);
            this.setState('info.MQTT_connection', false, true);

            callback();
        } catch (e) {
            callback();
        }
    }

    // ─── Hilfsmethoden ───────────────────────────────────────────────────────

    async setAllAvailableToFalse() {
        const states = await this.getStatesAsync('devices.*.online');
        for (const id in states) {
            await this.setStateChangedAsync(id, false, true);
        }
    }

    /**
     * Legt benötigte info.*-States an, falls noch nicht vorhanden.
     */
    async ensureInfoStates() {
        await this.setObjectNotExistsAsync('info.session', {
            type: 'state',
            common: {name: 'Gespeicherte Session', type: 'string', role: 'json', read: true, write: false, def: ''},
            native: {},
        });
        await this.setObjectNotExistsAsync('info.MQTT_connection', {
            type: 'state',
            common: {
                name: 'If MQTT is connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false
            },
            native: {},
        });
    }

    async connectToMQTT() {
        try {
            if (!['exmqtt', 'intmqtt'].includes(this.config.connectionType)) {
                return;
            }

            const clientId = `ioBroker.xsense_${Math.random().toString(16).slice(2, 8)}`;

            if (this.config.connectionType === 'exmqtt') {
                if (!this.config.externalMqttServerIP) {
                    this.log.warn('[XSense] Externer MQTT-Server nicht konfiguriert');
                    return;
                }

                const mqttOptions = {clientId, clean: true, reconnectPeriod: 500};

                if (this.config.externalMqttServerCredentials === true) {
                    mqttOptions.username = this.config.externalMqttServerUsername;
                    mqttOptions.password = this.config.externalMqttServerPassword;
                }

                mqttClient = mqtt.connect(
                    `mqtt://${this.config.externalMqttServerIP}:${this.config.externalMqttServerPort}`,
                    mqttOptions,
                );
            } else {
                // Interner MQTT-Server
                mqttServerController = new MqttServerController(this);
                await mqttServerController.createMQTTServer();
                await this.delay(1500);
                mqttClient = mqtt.connect(
                    `mqtt://${this.config.mqttServerIPBind}:${this.config.mqttServerPort}`,
                    {clientId, clean: true, reconnectPeriod: 500},
                );
            }

            mqttClient.on('connect', () => {
                const mode = this.config.connectionType === 'exmqtt' ? 'externem' : 'internem';
                this.log.info(`[XSense] Verbunden mit ${mode} MQTT-Server`);
                this.setState('info.MQTT_connection', true, true);

                // Bei (Re-)Connect Set leeren, damit alle Topics neu subscribed werden
                this._mqttSubscribedTopics.clear();

                // Legacy baseTopic (SBS50-Bridge direkt)
                if (this.config.baseTopic) {
                    this.mqttSubscribeOncetates(this.config.baseTopic);
                }

                // HA-konforme Topics für alle bekannten Stationen subscriben
                this.subscribeMqttTopics();

                // Temperatur-Sensoren aktiv anfragen
                this.requestTemperatureUpdates();
            });

            mqttClient.on('message', (topic, payload) => {
                if (this.config.mqttmessages) {
                    this.log.info(`[XSense MQTT] Topic: ${topic} | Payload: ${payload.toString()}`);
                }
                // Zuerst versuchen via HA-konformes processMqttMessage
                if (this.xsenseClient) {
                    const station = this.xsenseClient.processMqttMessage(topic, payload);
                    if (station) {
                        // Hausname für den ioBroker-Pfad auflösen
                        let houseFolderId = station.houseId;
                        for (const house of Object.values(this.xsenseClient.houses)) {
                            if (house.houseId === station.houseId) {
                                houseFolderId = (house.name || house.houseId)
                                    .replace(/\s+/g, '_').replace(/\./g, '_').replace(/[^a-zA-Z0-9_-]/g, '_');
                                break;
                            }
                        }
                        // Nur die betroffene Station schreiben – nicht alle Häuser neu aufbauen
                        this.json2iob.parseStation(this.namespace, station, houseFolderId)
                            .catch(e => this.log.error(`[XSense] MQTT parseStation Fehler: ${e.message}`));
                        return;
                    }
                }

                // Fallback: Legacy SBS50-Parsing
                const payloadStr = payload.toString();
                const slashIdx = topic.indexOf('/');
                const topicSuffix = slashIdx >= 0 ? topic.slice(slashIdx + 1) : topic;
                const newMessage = `{"payload":${payloadStr === '' ? '"null"' : payloadStr},"topic":"${topicSuffix}"}`;
                this.messageParse(newMessage);
            });

            mqttClient.on('error', err => {
                this.log.error(`[XSense] MQTT-Fehler: ${err.message}`);
                this.setState('info.MQTT_connection', false, true);
            });

            mqttClient.on('offline', () => {
                this.log.warn('[XSense] MQTT-Client offline');
                this.setState('info.MQTT_connection', false, true);
            });

            mqttClient.on('reconnect', () => {
                this.log.debug('[XSense] MQTT-Client verbindet sich neu...');
                this.setState('info.MQTT_connection', false, true);
            });

        } catch (err) {
            this.log.error(`[XSense] connectToMQTT Fehler: ${err.message}`);
        }
    }

    /**
     * Subscribed einen einzelnen MQTT-Topic – einmalig, kein Duplikat.
     *
     * @param {string} topic
     */
    mqttSubscribeOncetates(topic) {
        if (!mqttClient || this._mqttSubscribedTopics.has(topic)) {
            return;
        }
        this._mqttSubscribedTopics.add(topic);
        mqttClient.subscribe(topic, err => {
            if (err) {
                this._mqttSubscribedTopics.delete(topic); // bei Fehler retry erlauben
                this.log.warn(`[XSense] MQTT Subscribe fehlgeschlagen: ${topic} – ${err.message}`);
            } else {
                this.log.debug(`[XSense] MQTT subscribed: ${topic}`);
            }
        });
    }

    /**
     * Subscribed alle HA-konformen MQTT-Topics für alle Häuser/Stationen.
     * Quelle: HA coordinator.py → assure_subscriptions()
     * Wird nur im connect-Event aufgerufen – nie im Poll-Zyklus.
     */
    subscribeMqttTopics() {
        if (!mqttClient || !this.xsenseClient) {
            return;
        }

        for (const house of Object.values(this.xsenseClient.houses)) {
            for (const station of Object.values(house.stations)) {
                const topics = this.xsenseClient.getMqttTopics(station);
                for (const topic of topics) {
                    this.mqttSubscribeOncetates(topic);
                }
            }
        }
    }

    /**
     * Fordert Live-Daten für Temperatur/Luftfeuchte-Sensoren an (MQTT Publish).
     * Quelle: HA coordinator.py → request_device_updates() [STH51/STH0A]
     */
    requestTemperatureUpdates() {
        if (!mqttClient || !this.xsenseClient) {
            return;
        }

        for (const house of Object.values(this.xsenseClient.houses)) {
            for (const station of Object.values(house.stations)) {
                const req = this.xsenseClient.buildTemperatureUpdateRequest(station);
                if (!req) {
                    continue;
                }

                mqttClient.publish(req.topic, req.payload, {qos: 0, retain: false}, err => {
                    if (err) {
                        this.log.warn(`[XSense] Temperature-Update-Request fehlgeschlagen: ${err.message}`);
                    } else {
                        this.log.debug(`[XSense] Temperature-Update angefordert für ${station.serial}`);
                    }
                });
            }
        }
    }

    errorMessage(err, firstTry) {
        if (firstTry) {
            this.log.error(`[XSense] Schwerwiegender Fehler: ${err}`);
        }

        if (err?.message) {
            this.log.error(`[XSense] ${err.message}`);
        } else {
            this.log.error('[XSense] Unbekannter Fehler');
        }

        if (firstTry) {
            this.log.error('[XSense] Adapter manuell neu starten.');
            this.setState('info.MQTT_connection', false, true);
            this.setState('info.connection', false, true, () => {
                this.terminate('[XSense] Adapter beendet', 1);
            });
        }
    }
}


// ─── Export / Start ───────────────────────────────────────────────────────────
if (module.parent) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new XSenseAdapter(options);
} else {
    new XSenseAdapter();
}
