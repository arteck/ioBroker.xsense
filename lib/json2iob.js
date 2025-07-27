class Json2iobXSense {
    constructor(adapter) {
        this.adapter = adapter;
    }

    async parse(basePath, obj, options = {}) {
        const forceIndex = options.forceIndex || false;
        const write = options.write || false;

        for (const key in obj) {
            const value = obj[key];
            const fullPath = `${basePath}.${key}`;

            if (Array.isArray(value)) {
                for (let index = 0; index < value.length; index++) {
                    const arrayItem = value[index];
                    const arrayPath = `${fullPath}.${arrayItem.name}`;

                    if (typeof arrayItem === 'object' && arrayItem !== null) {
                        await this.parse(arrayPath, arrayItem, options);
                    } else {
                        await this.setStateObject(arrayPath, arrayItem, write);
                    }
                }
            } else if (typeof value === 'object' && value !== null) {
                await this.parse(fullPath, value, options);
            } else {
                await this.setStateObject(fullPath, value, write);
            }
        }
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
