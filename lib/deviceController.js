'use strict';

const dmUtils = require('@iobroker/dm-utils');
const {batInfoToPercent, rfLevelToString} = require('./xsenseClient');

// ─── Gerätetype-Definitionen ──────────────────────────────────────────────────

/**
 * Zentrale Gerätetype-Tabelle.
 * label:    Lesbarer Name für die Kachel/Detailansicht
 * icon:     dm-utils Icon-Key
 * testable: true = Testalarm wird unterstützt
 */
const DEVICE_TYPES = {
    'XS01-M': {label: 'Rauchmelder (standalone)', icon: 'fireAlarm', testable: true},
    'XS0B-MR': {label: 'Rauchmelder (vernetzt)', icon: 'fireAlarm', testable: true},
    'XS0D-MR': {label: 'Rauchmelder (vernetzt)', icon: 'fireAlarm', testable: true},
    'XS01-WX': {label: 'Rauchmelder WLAN', icon: 'fireAlarm', testable: true},
    'XP0A-MR': {label: 'Rauchmelder (vernetzt)', icon: 'fireAlarm', testable: true},
    'XP02S-MR': {label: 'Rauchmelder (vernetzt)', icon: 'fireAlarm', testable: true},
    'XC01-M': {label: 'CO-Melder (standalone)', icon: 'fireAlarm', testable: true},
    'XC04-WX': {label: 'CO-Melder WLAN', icon: 'fireAlarm', testable: true},
    'XH02-M': {label: 'Hitzemelder', icon: 'fireAlarm', testable: true},
    'SC06-WX': {label: 'Rauch+CO-Melder WLAN', icon: 'fireAlarm', testable: true},
    'SC07-MR': {label: 'Rauch+CO-Melder (vernetzt)', icon: 'fireAlarm', testable: true},
    'SC07-WX': {label: 'Rauch+CO-Melder WLAN', icon: 'fireAlarm', testable: true},
    SWS51: {label: 'Wassermelder', icon: 'floodAlarm', testable: true},
    STH0A: {label: 'Temp/Feuchte-Sensor', icon: 'humidity', testable: true},
    STH51: {label: 'Temp/Feuchte-Sensor', icon: 'humidity', testable: true},
    SBS10: {label: 'Basisstation SBS10', icon: 'hub5', testable: false},
    SBS50: {label: 'Basisstation SBS50', icon: 'hub5', testable: false},
};

/**
 * @param {string} type
 * @returns {string}
 */
function getIconForType(type) {
    return DEVICE_TYPES[type]?.icon ?? 'instance';
}

/**
 * @param {string} type
 * @returns {string}
 */
function getModelDescription(type) {
    return DEVICE_TYPES[type]?.label ?? type ?? '—';
}

/**
 * @param {string} type
 * @returns {boolean}
 */
function isTestable(type) {
    return DEVICE_TYPES[type]?.testable === true;
}


// ─── DeviceController ─────────────────────────────────────────────────────────

/**
 * XSense Device Manager – verwaltet die dm-utils Kacheln und Detail-Ansichten
 * für alle XSense-Geräte (Stationen + Untergeräte).
 *
 * Datenmodell:
 *   adapter.xsenseClient.houses
 *     └─ house { houseId, name, stations: {} }
 *          └─ station { serial, type, name, online, data: {wifiRSSI, sw, ...} }
 *               └─ device  { serial, type, name, online, data: {batInfo, rfLevel, alarmStatus, ...} }
 *
 * ioBroker-Pfad:
 *   devices.<houseName>.<stationSerial>.<deviceSerial>.<feld>
 */
class DeviceController extends dmUtils.DeviceManagement {
    /**
     * @param {object} adapter  Die ioBroker-Adapter-Instanz (XSenseAdapter)
     */
    constructor(adapter) {
        super(adapter);
        this.adapter = adapter;
    }

    // ─── Instanz-Info-Kachel ──────────────────────────────────────────────────

    /**
     * Liefert Adapter-Instanzinfos mit einer Status-Kachel (Cloud + MQTT).
     */
    async getInstanceInfo() {
        const info = await super.getInstanceInfo();
        if (!info.actions) {
            info.actions = [];
        }

        const ns = this.adapter.namespace;
        info.customInfo = {
            id: 'instanceInfo',
            schema: {
                type: 'panel',
                items: {
                    connection: {
                        type: 'state', oid: `${ns}.info.connection`, foreign: true,
                        label: 'Cloud verbunden',
                        trueText: '✔ Verbunden', falseText: '✘ Getrennt', newLine: true,
                    },
                    mqtt_connection: {
                        type: 'state', oid: `${ns}.info.MQTT_connection`, foreign: true,
                        label: 'MQTT verbunden',
                        trueText: '✔ Verbunden', falseText: '✘ Getrennt', newLine: true,
                    },
                },
            },
        };

        info.actions.push({
            id: 'forceRefresh',
            icon: 'refresh',
            description: 'Alle Geräte neu laden',
            handler: async (_context) => {
                try {
                    await this.adapter.datenVerarbeiten(false, true);
                } catch (e) {
                    this.adapter.log.error(`[XSense DM] forceRefresh Fehler: ${e.message}`);
                }
                return {refresh: true};
            },
        });

        return info;
    }

    // ─── Geräteliste ─────────────────────────────────────────────────────────

    /**
     * Lädt alle XSense-Stationen und Untergeräte in die dm-utils Kachel-Ansicht.
     *
     * Kachel-Prioritäten:
     *   Prio 1: alarmStatus / isOpen
     *   Prio 2: batInfo (Batterie), rfLevel (Signal)
     *   Prio 3: gerätetyp-spezifische Messwerte (temperature, humidity, coPpm)
     *   Prio 4: isLifeEnd, muteStatus
     *
     * @param {object} context  DeviceLoadContext
     */
    async loadDevices(context) {
        const client = this.adapter.xsenseClient;
        if (!client || !client.houses) {
            context.setTotalDevices(0);
            context.complete();
            return;
        }

        // Geräte zählen: Stationen + alle Untergeräte
        let total = 0;
        for (const house of Object.values(client.houses)) {
            total += Object.keys(house.stations).length;
            for (const station of Object.values(house.stations)) {
                total += Object.keys(station.devices).length;
            }
        }
        context.setTotalDevices(total);

        for (const house of Object.values(client.houses)) {
            const houseName = this.sanitizeName(house.name || house.houseId);

            for (const station of Object.values(house.stations)) {
                const stationPath = `${this.adapter.namespace}.devices.${houseName}.${station.serial}`;
                context.addDevice(this.buildStationTile(station, stationPath));

                for (const device of Object.values(station.devices)) {
                    const devicePath = `${stationPath}.${device.serial}`;
                    context.addDevice(this.buildDeviceTile(device, devicePath, station, houseName));
                }
            }
        }

        context.complete();
    }

    // ─── Detail-Ansicht ───────────────────────────────────────────────────────

    /**
     * Gibt Schema und Daten für die Detail-Ansicht eines einzelnen Geräts zurück.
     * ID-Format (Station):  "bridge/<stationSerial>"
     * ID-Format (Gerät):    "<houseName>/<stationSerial>/<deviceSerial>"
     *
     * @param {string} id  Geräte-ID aus loadDevices
     */
    async getDeviceDetails(id) {
        this.adapter.log.debug(`[XSense DM] getDeviceDetails: ${id}`);

        try {
            const client = this.adapter.xsenseClient;
            if (!client || !client.houses) {
return null;
}

            const parts = id.split('/');

            if (parts[0] === 'bridge') {
                const station = this.findStation(client.houses, parts[1]);
                if (!station) {
return null;
}
                const house = this.findHouseForStation(client.houses, parts[1]);
                const houseName = this.sanitizeName(house ? (house.name || house.houseId) : '');
                return this.buildStationDetails(station, `devices.${houseName}.${station.serial}`);
            }

            const [houseName, stationSerial, deviceSerial] = parts;
            const station = this.findStation(client.houses, stationSerial);
            if (!station) {
return null;
}

            const device = Object.values(station.devices).find(d => d.serial === deviceSerial);
            if (!device) {
return null;
}

            return this.buildDeviceDetails(device, station, `devices.${houseName}.${stationSerial}`);
        } catch (e) {
            this.adapter.log.error(`[XSense DM] getDeviceDetails Fehler für "${id}": ${e.message}`);
            return null;
        }
    }


    // ─── Private: Tile-Builder ────────────────────────────────────────────────

    /**
     * Baut die Kachel-Definition für eine Station (Bridge).
     *
     * @param {object} station      Station-Objekt
     * @param {string} stationPath  Voller ioBroker-Pfad der Station (inkl. Namespace)
     * @returns {object}            dm-utils device-Objekt
     */
    buildStationTile(station, stationPath) {
        const items = {};

        items.online = {
            type: 'state', oid: `${stationPath}.online`, foreign: true,
            label: 'Online', trueText: '✔ Online', falseText: '✘ Offline', newLine: true,
        };

        if (station.data?.wifiRSSI !== undefined) {
            items.wifiRSSI = {
                type: 'state', oid: `${stationPath}.wifiRSSI`, foreign: true,
                label: 'WiFi Signal', unit: 'dBm', newLine: true,
            };
        }
        if (station.data?.sw !== undefined) {
            items.sw = {
                type: 'state', oid: `${stationPath}.sw`, foreign: true,
                label: 'Firmware', newLine: true,
            };
        }

        return {
            id: `bridge/${station.serial}`,
            name: station.name || station.serial,
            icon: 'hub5',
            manufacturer: 'X-Sense',
            model: station.type,
            status: {connection: station.online ? 'connected' : 'disconnected'},
            hasDetails: true,
            customInfo: Object.keys(items).length > 0
                ? {id: station.serial, schema: {type: 'panel', items}}
                : undefined,
            actions: [],
        };
    }

    /**
     * Baut die Kachel-Definition für ein Untergerät.
     *
     * @param {object} device      Device-Objekt
     * @param {string} devicePath  Voller ioBroker-Pfad des Geräts (inkl. Namespace)
     * @param {object} station     Übergeordnete Station
     * @param {string} houseName   Bereinigter Hausname für die ID
     * @returns {object}           dm-utils device-Objekt
     */
    buildDeviceTile(device, devicePath, station, houseName) {
        const data = device.data || {};
        // device.type bevorzugt – Fallback auf data.type falls device.type leer
        const type = device.type || data.type || '';
        const items = {};
        const status = {connection: device.online ? 'connected' : 'disconnected'};

        // ── Prio 1: Alarm-Status ──────────────────────────────────────────────
        if (data.alarmStatus !== undefined) {
            items.alarmStatus = {
                type: 'state', oid: `${devicePath}.alarmStatus`, foreign: true,
                label: 'Alarm', trueText: '🔴 ALARM', falseText: '--', newLine: true,
            };
        }
        if (data.isOpen !== undefined) {
            items.isOpen = {
                type: 'state', oid: `${devicePath}.isOpen`, foreign: true,
                label: 'Wasser', trueText: '💧 WASSER', falseText: '✔ Trocken', newLine: true,
            };
        }

        // ── Prio 2: Batterie + Signal ─────────────────────────────────────────
        if (data.batInfo !== undefined) {
            const batPct = batInfoToPercent(data.batInfo);
            items.batInfo = {
                type: 'state', oid: `${devicePath}.batInfo`, foreign: true,
                label: 'Batterie', unit: '%', newLine: true,
            };
            status.battery = batPct;
        }
        if (data.rfLevel !== undefined) {
            status.rssi = rfLevelToString(data.rfLevel);
            items.rfLevel = {
                type: 'state', oid: `${devicePath}.rfLevel`, foreign: true,
                label: 'Signal', newLine: true,
            };
        }

        // ── Prio 2b: Testalarm-Button ─────────────────────────────────────────
        if (isTestable(type)) {
            items._testAlarm = {
                type: 'state',
                oid: `${devicePath}.test_Alarm`,
                foreign: true,
                label: '🔔 Test Alarm',
                control: 'button',
                newLine: true,
            };
        }

        // ── Prio 3: Typ-spezifische Messwerte ─────────────────────────────────
        const t = type.toUpperCase();

        if ((t === 'STH0A' || t === 'STH51') && data.temperature !== undefined) {
            items.temperature = {
                type: 'state', oid: `${devicePath}.temperature`, foreign: true,
                label: 'Temperatur', unit: '°C', newLine: true,
            };
        }
        if ((t === 'STH0A' || t === 'STH51') && data.humidity !== undefined) {
            items.humidity = {
                type: 'state', oid: `${devicePath}.humidity`, foreign: true,
                label: 'Luftfeuchte', unit: '%', newLine: true,
            };
        }
        if ((t.startsWith('XC') || t.startsWith('SC')) && data.coPpm !== undefined) {
            items.coPpm = {
                type: 'state', oid: `${devicePath}.coPpm`, foreign: true,
                label: 'CO', unit: 'ppm', newLine: true,
            };
        }

        // ── Prio 4: Lebensdauer ───────────────────────────────────────────────
        if (data.isLifeEnd !== undefined) {
            items.isLifeEnd = {
                type: 'state', oid: `${devicePath}.isLifeEnd`, foreign: true,
                label: 'Lebensdauer Ende', trueText: '⚠ Abgelaufen', falseText: '✔ OK', newLine: true,
            };
        }

        return {
            id: `${houseName}/${station.serial}/${device.serial}`,
            name: device.name || device.serial,
            icon: getIconForType(type),
            manufacturer: 'X-Sense',
            model: type,
            status,
            hasDetails: true,
            customInfo: Object.keys(items).length > 0
                ? {id: device.serial, schema: {type: 'panel', items}}
                : undefined,
            actions: [],
        };
    }

    // ─── Private: Detail-Builder ──────────────────────────────────────────────

    /**
     * Detail-Ansicht (Tabs) für eine Station (Bridge).
     *
     * @param {object} station      Station-Objekt
     * @param {string} stationPath  Relativer ioBroker-Pfad (ohne Namespace)
     * @returns {object}            dm-utils detail-Objekt
     */
    buildStationDetails(station, stationPath) {
        const fullPath = `${this.adapter.namespace}.${stationPath}`;

        const infoItems = {
            _h1: {type: 'header', text: 'Station', sm: 12, newLine: true},
            _d1: {type: 'divider', color: 'primary'},
            serial: {
                type: 'staticInfo',
                label: 'Seriennummer',
                data: station.serial,
                size: 16,
                addColon: true,
                newLine: true
            },
            name: {
                type: 'staticInfo',
                label: 'Name',
                data: station.name || '—',
                size: 16,
                addColon: true,
                newLine: true
            },
            type: {
                type: 'staticInfo',
                label: 'Typ',
                data: getModelDescription(station.type),
                size: 16,
                addColon: true,
                newLine: true
            },
        };

        const connItems = {
            _h1: {type: 'header', text: 'Verbindung', sm: 12, newLine: true},
            _d1: {type: 'divider', color: 'primary'},
            online: {
                type: 'state', oid: `${fullPath}.online`, foreign: true,
                label: 'Online', trueText: '✔ Online', falseText: '✘ Offline', newLine: true,
            },
        };
        if (station.data?.wifiRSSI !== undefined) {
            connItems.wifiRSSI = {
                type: 'state', oid: `${fullPath}.wifiRSSI`, foreign: true,
                label: 'WiFi Signal', unit: 'dBm', newLine: true,
            };
        }
        if (station.data?.sw !== undefined) {
            connItems.sw = {
                type: 'state', oid: `${fullPath}.sw`, foreign: true,
                label: 'Firmware', newLine: true,
            };
        }

        return {
            id: station.serial,
            schema: {
                type: 'tabs',
                items: {
                    _tab_info: {type: 'panel', label: 'Station', items: infoItems},
                    _tab_conn: {type: 'panel', label: 'Verbindung', items: connItems},
                },
            },
            data: {},
        };
    }

    /**
     * Detail-Ansicht (Tabs) für ein Untergerät.
     *
     * @param {object} device       Device-Objekt
     * @param {object} station      Übergeordnete Station
     * @param {string} stationPath  Relativer ioBroker-Pfad der Station (ohne Namespace)
     * @returns {object}            dm-utils detail-Objekt
     */
    buildDeviceDetails(device, station, stationPath) {
        const fullPath = `${this.adapter.namespace}.${stationPath}.${device.serial}`;
        const data = device.data || {};
        const type = device.type || data.type || '';

        // ── Tab 1: Gerätinfo ──────────────────────────────────────────────────
        const infoItems = {
            _h1: {type: 'header', text: 'Gerät', sm: 12, newLine: true},
            _d1: {type: 'divider', color: 'primary'},
            serial: {
                type: 'staticInfo',
                label: 'Seriennummer',
                data: device.serial,
                size: 12,
                addColon: true,
                newLine: true
            },
            name: {
                type: 'staticInfo',
                label: 'Name',
                data: device.name || '—',
                size: 12,
                addColon: true,
                newLine: true
            },
            type: {type: 'staticInfo', label: 'Typ', data: type, size: 12, addColon: true, newLine: true},
            bridge: {
                type: 'staticInfo',
                label: 'Basisstation',
                data: station.name || station.serial,
                size: 12,
                addColon: true,
                newLine: true
            },
        };

        // ── Tab 2: Status ─────────────────────────────────────────────────────
        const statusItems = {
            _h1: {type: 'header', text: 'Status', sm: 12, newLine: true},
            _d1: {type: 'divider', color: 'primary'},
            online: {
                type: 'state', oid: `${fullPath}.online`, foreign: true, size: 12,
                label: 'Online', trueText: '✔ Online', falseText: '✘ Offline', newLine: true,
            },
        };
        if (data.alarmStatus !== undefined) {
            statusItems.alarmStatus = {
                type: 'state', oid: `${fullPath}.alarmStatus`, foreign: true, size: 12,
                label: 'Alarm', trueText: '🔴 ALARM', falseText: '--', newLine: true,
            };
        }
        if (data.continuedAlarm !== undefined) {
            statusItems.continuedAlarm = {
                type: 'state', oid: `${fullPath}.continuedAlarm`, foreign: true, size: 12,
                label: 'Anhaltender Alarm', trueText: '🔴 Aktiv', falseText: '✔ Inaktiv', newLine: true,
            };
        }
        if (data.muteStatus !== undefined) {
            statusItems.muteStatus = {
                type: 'state', oid: `${fullPath}.muteStatus`, foreign: true, size: 12,
                label: 'Stummgeschaltet', trueText: '🔇 Stumm', falseText: '🔊 --', newLine: true,
            };
        }
        if (data.isLifeEnd !== undefined) {
            statusItems.isLifeEnd = {
                type: 'state', oid: `${fullPath}.isLifeEnd`, foreign: true, size: 12,
                label: 'Lebensdauer Ende', trueText: '⚠ Abgelaufen', falseText: '✔ --', newLine: true,
            };
        }
        if (data.isOpen !== undefined) {
            statusItems.isOpen = {
                type: 'state', oid: `${fullPath}.isOpen`, foreign: true, size: 12,
                label: 'Wasser erkannt', trueText: '💧 WASSER', falseText: '✔ Trocken', newLine: true,
            };
        }

        // ── Tab 3: Hardware ───────────────────────────────────────────────────
        const hardwareItems = {
            _h1: {type: 'header', text: 'Hardware', sm: 12, newLine: true},
            _d1: {type: 'divider', color: 'primary'},
        };
        if (data.batInfo !== undefined) {
            hardwareItems.batInfo = {
                type: 'state', oid: `${fullPath}.batInfo`, foreign: true, size: 12,
                label: 'Batterie', unit: '%', newLine: true,
            };
        }
        if (data.rfLevel !== undefined) {
            hardwareItems.rfLevel = {
                type: 'state', oid: `${fullPath}.rfLevel`, foreign: true, size: 12,
                label: 'Funksignal', newLine: true,
            };
        }
        if (data.sw !== undefined) {
            hardwareItems.sw = {
                type: 'state', oid: `${fullPath}.sw`, foreign: true, size: 12,
                label: 'Firmware', newLine: true,
            };
        }

        // ── Tabs zusammenbauen ────────────────────────────────────────────────
        const tabs = {
            _tab_info: {type: 'panel', label: 'Gerät', items: infoItems},
            _tab_status: {type: 'panel', label: 'Status', items: statusItems},
            _tab_hardware: {type: 'panel', label: 'Hardware', items: hardwareItems},
        };

        // Messwerte-Tab
        const measureItems = {};
        if (data.temperature !== undefined) {
            measureItems.temperature = {
                type: 'state', oid: `${fullPath}.temperature`, foreign: true, size: 12,
                label: 'Temperatur', unit: '°C', newLine: true,
            };
        }
        if (data.humidity !== undefined) {
            measureItems.humidity = {
                type: 'state', oid: `${fullPath}.humidity`, foreign: true, size: 12,
                label: 'Luftfeuchte', unit: '%', newLine: true,
            };
        }
        if (data.coPpm !== undefined) {
            measureItems.coPpm = {
                type: 'state', oid: `${fullPath}.coPpm`, foreign: true, size: 12,
                label: 'CO-Konzentration', unit: 'ppm', newLine: true,
            };
        }
        if (data.coLevel !== undefined) {
            measureItems.coLevel = {
                type: 'state', oid: `${fullPath}.coLevel`, foreign: true, size: 12,
                label: 'CO-Pegel', newLine: true,
            };
        }
        if (Object.keys(measureItems).length > 0) {
            tabs._tab_measure = {
                type: 'panel',
                label: 'Messwerte',
                items: {
                    _h1: {type: 'header', text: 'Messwerte', sm: 12, newLine: true},
                    _d1: {type: 'divider', color: 'primary'},
                    ...measureItems,
                },
            };
        }

        return {
            id: device.serial,
            schema: {type: 'tabs', items: tabs},
            data: {},
        };
    }


    // ─── Private: Hilfsmethoden ───────────────────────────────────────────────

    /**
     * Bereinigt einen Namen für ioBroker-Pfade (wie json2iob.name2id).
     *
     * @param {string} name
     * @returns {string}
     */
    sanitizeName(name) {
        return String(name || '')
            .replace(/\s+/g, '_')
            .replace(/\./g, '_')
            .replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    /**
     * Sucht eine Station anhand ihrer Seriennummer in allen Häusern.
     *
     * @param {object} houses  client.houses
     * @param {string} serial  Seriennummer der Station
     * @returns {object|null}
     */
    findStation(houses, serial) {
        for (const house of Object.values(houses)) {
            for (const station of Object.values(house.stations)) {
                if (station.serial === serial) {
                    return station;
                }
            }
        }
        return null;
    }

    /**
     * Sucht das Haus-Objekt für eine Station anhand der Stations-Seriennummer.
     *
     * @param {object} houses  client.houses
     * @param {string} serial  Seriennummer der Station
     * @returns {object|null}
     */
    findHouseForStation(houses, serial) {
        for (const house of Object.values(houses)) {
            for (const station of Object.values(house.stations)) {
                if (station.serial === serial) {
                    return house;
                }
            }
        }
        return null;
    }
}

module.exports = {DeviceController};

