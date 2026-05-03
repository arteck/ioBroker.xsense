/**
 *  JSON to ioBroker object converter for XSense devices
 */
const {batInfoToPercent, rfLevelToString} = require('./xsenseClient');

/**
 *
 */
class Json2iobXSense {
    /**
     * @param adapter
     */
    constructor(adapter) {
        this.adapter = adapter;
        /** Bereits subscribed States – verhindert doppelte Handler */
        this._subscribedStates = new Set();
    }

    /**
     * Einmalig subscriben – bei erneutem Aufruf kein Duplikat.
     *
     * @param {string} id
     */
    subscribeOnce(id) {
        if (!this._subscribedStates.has(id)) {
            this._subscribedStates.add(id);
            this.adapter.subscribeStates(id);
        }
    }

    /**
     * Schreibt Häuser/Stationen/Geräte aus XSenseClient.houses in ioBroker-States.
     *
     * @param {string} basePath  Adapter-Namespace (z.B. "xsense.0")
     * @param {object} houses    XSenseClient.houses
     */
    async parseHouses(basePath, houses) {
        await this.createStaticDeviceObject();

        // devices-Ordner einmalig anlegen
        await this.adapter.setObjectNotExistsAsync('devices', {
            type: 'folder',
            common: {name: 'Devices'},
            native: {},
        });

        for (const house of Object.values(houses)) {
            // ── Haus-Ordner – Name statt UUID als Pfad ────────────────────────
            const houseFolderId = await this.name2id(house.name || house.houseId);
            const housePath = `devices.${houseFolderId}`;

            await this.adapter.setObjectNotExistsAsync(housePath, {
                type: 'folder',
                common: {name: house.name || house.houseId},
                native: {},
            });

            // Haus-Meta-States (home_id enthält die echte UUID zur Referenz)
            await this.writeFields(housePath, {
                home_id: house.houseId,
                houseName: house.name || '',
                region: house.region || '',
                mqttRegion: house.mqttRegion || '',
                mqttServer: house.mqttServer || '',
            });

            for (const station of Object.values(house.stations)) {
                const bridgeId = await this.name2id(station.serial);
                const bridgePath = `${housePath}.${bridgeId}`;

                // Bridge/Station als Device-Objekt unter dem Haus-Ordner
                await this.ensureDevice(basePath, bridgePath, station.name || station.serial);

                const stationFields = {
                    stationId: station.stationId || '',
                    serial: station.serial,
                    name: station.name || '',
                    online: station.online ?? false,
                    ...station.data,
                    ...(station.type != null ? {type: station.type} : {}),
                };

                await this.writeFields(bridgePath, stationFields);

                // Untergeräte als Channel unter dem Bridge-Device
                for (const device of Object.values(station.devices)) {
                    const deviceId = await this.name2id(device.serial);
                    const devicePath = `${bridgePath}.${deviceId}`;

                    await this.ensureChannel(basePath, devicePath, device.name || device.serial);

                    const deviceFields = {
                        deviceId: device.deviceId || '',
                        serial: device.serial,
                        name: device.name || '',
                        online: device.online ?? false,
                        ...device.data,                                              // data.type als Fallback
                        ...(device.type != null ? {type: device.type} : {}),     // device.type gewinnt nur wenn vorhanden
                    };
                    await this.writeFields(devicePath, deviceFields);
                }
            }
        }
    }

    /**
     * Schreibt eine einzelne Station + ihre Untergeräte in ioBroker-States.
     * Wird vom MQTT-Handler aufgerufen – schreibt nur die betroffene Station,
     * nicht alle Häuser.
     *
     * @param {string} basePath      Adapter-Namespace (z.B. "xsense.0")
     * @param {object} station       Station-Objekt mit { serial, name, type, online, data, devices, houseId }
     * @param {string} houseFolderId Bereinigter Hausname als ioBroker-Pfad-Segment (z.B. "Mein_Zuhause")
     */
    async parseStation(basePath, station, houseFolderId) {
        const bridgeId   = await this.name2id(station.serial);
        const bridgePath = `devices.${houseFolderId}.${bridgeId}`;

        await this.ensureDevice(basePath, bridgePath, station.name || station.serial);

        const stationFields = {
            stationId: station.stationId || '',
            serial:    station.serial,
            name:      station.name || '',
            online:    station.online ?? false,
            ...station.data,
            ...(station.type != null ? {type: station.type} : {}),
        };
        await this.writeFields(bridgePath, stationFields);

        for (const device of Object.values(station.devices)) {
            const deviceId   = await this.name2id(device.serial);
            const devicePath = `${bridgePath}.${deviceId}`;

            await this.ensureChannel(basePath, devicePath, device.name || device.serial);

            const deviceFields = {
                deviceId: device.deviceId || '',
                serial:   device.serial,
                name:     device.name || '',
                online:   device.online ?? false,
                ...device.data,
                ...(device.type != null ? {type: device.type} : {}),
            };
            await this.writeFields(devicePath, deviceFields);
        }
    }

    /**
     * Legt ein Device-Objekt an (nur wenn noch nicht vorhanden).
     *
     * @param {string} basePath  Adapter-Namespace
     * @param {string} id        Relativer Pfad, z.B. "devices.SBS50ABC"
     * @param {string} name
     */
    async ensureDevice(basePath, id, name = '') {
        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
                name: name || id.split('.').pop(),
                statusStates: {
                    onlineId: `${basePath}.${id}.online`,
                },
            },
            native: {},
        });
    }

    /**
     * Legt ein Channel-Objekt an (nur wenn noch nicht vorhanden).
     * Sub-Geräte unter einem Device müssen Channel sein (ioBroker-Objekthierarchie).
     *
     * @param {string} basePath  Adapter-Namespace
     * @param {string} id        Relativer Pfad, z.B. "devices.SBS50ABC.XS01M001"
     * @param {string} name
     */
    async ensureChannel(basePath, id, name = '') {
        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'channel',
            common: {
                name: name || id.split('.').pop(),
                statusStates: {
                    onlineId: `${basePath}.${id}.online`,
                },
            },
            native: {},
        });
    }

    /**
     * Schreibt alle Key-Value-Paare als States unterhalb von basePath.
     *
     * @param {string} basePath
     * @param {object} fields
     */
    async writeFields(basePath, fields) {
        for (const [key, value] of Object.entries(fields)) {
            if (value === null || value === undefined) {
                continue;
            }
            const id = `${basePath}.${await this.name2id(key)}`;
            await this.setStateObject(id, value);
        }
    }

    /**
     *
     * @param id
     * @param value
     */
    async setStateObject(id, value) {
        const lastPart = id.split('.').pop();
        let type = typeof value;
        let role = 'value';
        let unit = '';
        let min;
        let max;

        const isNumericString = typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value);
        let setAlarm = false;

        if (typeof value === 'string') {
            const lower = value.toLowerCase();
            if (!isNumericString && (lower === 'true' || lower === 'false')) {
                type = 'boolean';
                value = lower === 'true';
            } else if (isNumericString) {
                if (lastPart === 'serial' || lastPart === 'stationId' || lastPart === 'deviceId' || lastPart === 'home_id') {
                    type = 'string';
                    role = 'info.id';
                } else {
                    type = 'number';
                    value = Number(value);
                }
            }
        }

        if (lastPart === 'batInfo' && typeof value === 'number') {
            value = batInfoToPercent(value);
            type = 'number';
            role = 'value.battery';
            unit = '%';
            min = 0;
            max = 100;
        } else if (lastPart === 'rfLevel' && (typeof value === 'number' || typeof value === 'string')) {
            value = rfLevelToString(value);
            type = 'string';
            role = 'value';
        } else {
            switch (true) {
                case lastPart === 'online':
                    role = 'indicator.reachable';
                    break;
                case lastPart === 'name' || lastPart === 'houseName':
                    role = 'text';
                    break;
                case lastPart === 'serial' || lastPart === 'stationId' || lastPart === 'deviceId':
                    role = 'info.id';
                    break;
                case lastPart === 'home_id':
                    role = 'info.id';
                    type = 'string';
                    break;
                case lastPart === 'type':
                    role = 'text';
                    type = 'string';
                    break;
                case lastPart === 'region' || lastPart === 'mqttRegion' || lastPart === 'mqttServer':
                    role = 'info.address';
                    type = 'string';
                    break;
                case lastPart === 'ip':
                    role = 'info.ip';
                    break;
                case lastPart === 'sw' || lastPart === 'network_sw' || lastPart === 'wifi_sw':
                    role = 'info.firmware';
                    break;
                case lastPart === 'ssid':
                    role = 'info.ssid';
                    break;
                case lastPart === 'temperature':
                    role = 'value.temperature';
                    unit = '°C';
                    type = 'number';
                    break;
                case lastPart === 'humidity':
                    role = 'value.humidity';
                    unit = '%';
                    type = 'number';
                    break;
                case lastPart === 'coPpm':
                    role = 'value';
                    unit = 'ppm';
                    type = 'number';
                    break;
                case lastPart === 'alarmVol' || lastPart === 'voiceVol':
                    role = 'level.volume';
                    unit = '%';
                    type = 'number';
                    break;
                case lastPart === 'isLifeEnd':
                    role = 'indicator';
                    type = 'boolean';
                    value = value === 1 || value === '1' || value === true;
                    break;
                case lastPart === 'isOpen':
                    role = 'sensor.door';
                    type = 'boolean';
                    value = value === '1' || value === 1 || value === true;
                    break;
                case lastPart === 'muteStatus':
                    role = 'indicator';
                    type = 'boolean';
                    break;
                case lastPart === 'activate':
                    role = 'indicator';
                    type = 'boolean';
                    break;
                case lastPart === 'continuedAlarm':
                    role = 'indicator.alarm';
                    type = 'boolean';
                    break;
                case lastPart.includes('alarm') || lastPart === 'alarmStatus':
                    role = 'indicator.alarm';
                    setAlarm = true;
                    break;
                case /(co|rf|wifi)/i.test(lastPart):
                    role = 'level';
                    if (/(wifi)/i.test(lastPart)) {
                        unit = 'dBm';
                        type = 'number';
                    }
                    break;
            }
        }

        const common = {name: lastPart, type, role, unit, read: true, write: false};
        if (min !== undefined) {
            common.min = min;
        }
        if (max !== undefined) {
            common.max = max;
        }

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common,
            native: {},
        });

        this.adapter.setState(id, {val: value, ack: true});

        if (setAlarm) {
            const msgId = id.replace(/\.[^.]+$/, '.test_Alarm_Message');
            const alarmId = id.replace(/\.[^.]+$/, '.test_Alarm');

            await this.adapter.setObjectNotExistsAsync(msgId, {
                type: 'state',
                common: {
                    name: 'answer test_Alarm_Message',
                    type: 'string',
                    role: 'text',
                    read: true,
                    write: false,
                    def: ''
                },
                native: {},
            });
            // Nur schreiben wenn noch kein Wert vorhanden
            const existing = await this.adapter.getStateAsync(msgId);
            if (existing === null || existing === undefined) {
                this.adapter.setState(msgId, {val: '', ack: true});
            }

            await this.adapter.setObjectNotExistsAsync(alarmId, {
                type: 'state',
                common: {
                    name: 'Toggle state test_Alarm',
                    type: 'boolean',
                    role: 'button',
                    read: true,
                    write: true,
                    def: false
                },
                native: {},
            });
            // test_Alarm Button NICHT bei jedem Poll zurücksetzen – User-Trigger würde überschrieben
            const alarmState = await this.adapter.getStateAsync(alarmId);
            if (alarmState === null || alarmState === undefined) {
                this.adapter.setState(alarmId, {val: false, ack: true});
            }

            // Einmalig subscriben
            this.subscribeOnce(alarmId);
        }
    }

    /**
     * @param pName
     */
    async name2id(pName) {
        // Leerzeichen, Punkte, FORBIDDEN_CHARS → _
        // Punkte sind ioBroker-Pfad-Trenner und dürfen nicht in Segment-Namen vorkommen
        return (pName || '')
            .replace(/\s+/g, '_')                       // Leerzeichen → _
            .replace(/\./g, '_')                        // Punkte → _ (würden Pfad splitten)
            .replace(this.adapter.FORBIDDEN_CHARS, '_'); // ioBroker-Verbotene Zeichen → _
    }

    /**
     * Legt den forceRefresh-Button einmalig an.
     */
    async createStaticDeviceObject() {
        await this.adapter.setObjectNotExistsAsync('devices.forceRefresh', {
            type: 'state',
            common: {
                name: 'refresh manually',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: false,
            },
            native: {},
        });
        this.subscribeOnce('devices.forceRefresh');
    }

    // ─── Legacy parse() / parseObject() ──────────────────────────────────────

    /**
     * @param basePath
     * @param obj
     */
    async parse(basePath, obj) {
        let devBridge = false;

        if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, 'home_id')) {
            const homeIdValue = obj.home_id;
            if (homeIdValue != null) {
                delete obj.home_id;
                await this.setStateObject('devices.home_id', homeIdValue, false);
                this.createStaticDeviceObject();
            }
        }

        let devicesContainer = obj.devices;
        if (devicesContainer && devicesContainer.devices) {
            devicesContainer = devicesContainer.devices;
        }

        if (!devicesContainer || typeof devicesContainer !== 'object') {
            return;
        }

        let basisPath = 'devices';

        for (const key of Object.keys(devicesContainer)) {
            const device = devicesContainer[key];
            let deviceName = '';
            let targetPath = '';

            if (Object.prototype.hasOwnProperty.call(device, 'wifiRSSI')) {
                basisPath = `devices.${device.serial}`;
                targetPath = basisPath;
                devBridge = true;

                deviceName = typeof device.name === 'string' ? device.name : '';
                await this.ensureDevice(basePath, await this.name2id(targetPath), await this.name2id(deviceName));
                await this.parseObject(targetPath, device);
                continue;
            }

            if (devBridge) {
                const serial = device?.serial;
                if (!serial || serial.length === 0) {
                    continue;
                }

                targetPath = `${basisPath}.${serial}`;
                deviceName = typeof device.name === 'string' ? device.name : '';
                await this.ensureChannel(basePath, await this.name2id(targetPath), await this.name2id(deviceName));
                await this.parseObject(targetPath, device);
            }
        }
    }

    /**
     * @param basePath
     * @param obj
     */
    async parseObject(basePath, obj) {
        for (const key in obj) {
            const value = obj[key];
            const fullPath = await this.name2id(`${basePath}.${key}`);

            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const arrayItem = value[index];
                    const itemName = arrayItem?.name || `index_${index}`;
                    const arrayPath = `${fullPath}.${itemName}`;
                    if (typeof arrayItem === 'object' && arrayItem !== null) {
                        await this.parseObject(arrayPath, arrayItem);
                    } else {
                        await this.setStateObject(arrayPath, arrayItem);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                await this.parseObject(fullPath, value);
            } else {
                await this.setStateObject(fullPath, value);
            }
        }
    }
}

module.exports = Json2iobXSense;
