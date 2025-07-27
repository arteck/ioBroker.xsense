class Json2iobXSense {
    constructor(adapter) {
        this.adapter = adapter;
        this.baseStationId = null;
    }

    async parse(basePath, obj, options = {}) {
        const write = options.write || false;

        // home_id direkt setzen
        if (obj && typeof obj === 'object' && obj.hasOwnProperty('home_id')) {
            const homeIdValue = obj.home_id;
            delete obj.home_id;
            await this.setStateObject('devices.home_id', homeIdValue, write);
        }

        // Basisstation suchen - hier liegt sie unter devices.devices.0 laut Screenshot
        // deshalb suchen wir unter obj.devices.devices
        let devicesContainer = obj.devices;
        if (devicesContainer && devicesContainer.devices) {
            devicesContainer = devicesContainer.devices;
        }

        if (devicesContainer && typeof devicesContainer === 'object') {
            for (const key of Object.keys(devicesContainer)) {
                const device = devicesContainer[key];

                if (
                    device &&
                    typeof device === 'object' &&
                    device.wifiRSSI !== undefined
                ) {
                    // Basisstation identifizieren und Basisstations-ID setzen
                    this.baseStationId = device.name || device.serial || key || 'base_station';

                    // Basisstation als Device anlegen unter devices.<baseStationId>
                    const baseStationPath = `devices.${this.baseStationId}`;
                    const deviceName = typeof device.type === 'string' ? device.type : '';
                    await this.createDeviceObject(baseStationPath, deviceName);

                    // Basisstation-Inhalt schreiben
                    await this.parseObject(baseStationPath, device, options);

                    // Basisstation aus dem Container löschen, damit sie nicht doppelt angelegt wird
                    delete devicesContainer[key];
                    break; // nur eine Basisstation erwartet
                }
            }

            // Jetzt alle anderen Geräte unter devices.<baseStationId> einsortieren
            for (const key of Object.keys(devicesContainer)) {
                const device = devicesContainer[key];
                let targetPath;

                if (this.baseStationId) {
                    targetPath = `devices.${this.baseStationId}.${key}`;
                } else {
                    targetPath = `devices.${key}`;
                }

                await this.parseObject(targetPath, device, options);
            }
        }
    }

    async parseObject(basePath, obj, options = {}) {
        const write = options.write || false;

        if (typeof obj === 'object' && obj !== null) {
            const deviceName = typeof obj.type === 'string' ? obj.name : '';
            await this.createDeviceObject(basePath, deviceName);
        }

        for (const key in obj) {
            const value = obj[key];
            const fullPath = `${basePath}.${key}`;

            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const arrayItem = value[index];
                    const itemName = arrayItem?.name || `index_${index}`;
                    const arrayPath = `${fullPath}.${itemName}`;

                    if (typeof arrayItem === 'object' && arrayItem !== null) {
                        await this.parseObject(arrayPath, arrayItem, options);
                    } else {
                        await this.setStateObject(arrayPath, arrayItem, write);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                await this.parseObject(fullPath, value, options);
            } else {
                await this.setStateObject(fullPath, value, write);
            }
        }
    }

    async createDeviceObject(id, name = '') {
        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
                name: name || id.split('.').pop(),
            },
            native: {},
        });
    }

    async setStateObject(id, value, write = false) {
        const common = {
            name: id.split('.').pop(),
            type: typeof value,
            role: 'state',
            read: true,
            write: write,
        };

        await this.adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common,
            native: {},
        });

        await this.adapter.setStateAsync(id, { val: value, ack: true });
    }
}


module.exports = Json2iobXSense;
