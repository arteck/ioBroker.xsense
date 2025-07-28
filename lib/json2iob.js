class Json2iobXSense {
    constructor(adapter) {
        this.adapter = adapter;
    }

    async parse(basePath, obj, options = {}) {
        const write = options.write || false;

        // home_id verarbeiten
        if (obj && typeof obj === 'object' && obj.hasOwnProperty('home_id')) {
            const homeIdValue = obj.home_id;
            delete obj.home_id;
            await this.setStateObject('devices.home_id', homeIdValue, write);
        }

        // devices.devices auslesen
        let devicesContainer = obj.devices;
        if (devicesContainer && devicesContainer.devices) {
            devicesContainer = devicesContainer.devices;
        }

        if (!devicesContainer || typeof devicesContainer !== 'object') return;

        // Jedes Gerät verarbeiten, egal ob Basisstation oder Sensor
        for (const key of Object.keys(devicesContainer)) {
            const device = devicesContainer[key];

            // serial als Geräteordner verwenden
            const serial = device?.serial;
            if (!serial) continue; // skip falls keine serial

            const targetPath = `devices.${serial}`;
            const deviceName = typeof device.name === 'string' ? device.name : '';

            await this.createDeviceObject(targetPath, deviceName);
            await this.parseObject(targetPath, device, options);
        }
    }

    async parseObject(basePath, obj, options = {}) {
        const write = options.write || false;

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
