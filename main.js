const utils = require('@iobroker/adapter-core');
const tools = require('./lib/tools');
const Json2iobXSense = require('./lib/json2iob');

const util = require('util');
const exec = util.promisify(require('child_process').exec);
const path = require('path');

global.fetch = (...args) => import('node-fetch').then(mod => mod.default(...args));


/**
 * -------------------------------------------------------------------
 * ioBroker X-Sense Adapter
 * -------------------------------------------------------------------
 */
class xsenseControll  extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'xsense'
        });

        this.json2iob = new Json2iobXSense(this);

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            this.log.info('Starte Login bei X-Sense...');

            const response = await this.xsenseLogin();

            const parsed = tools.parseXSenseOutput(response);

            await this.json2iob.parse('xsense.0', parsed, { forceIndex: true, write: true });


        } catch (err) {
            this.log.error(`Fehler beim Login oder Setup: ${err.message}`);
            return;
        }
    }


    async xsenseLogin() {
        try {
            const scriptPath = path.join(tools.getDataFolder(this), 'run_xsense.py');
            const cmd = `python3 ${scriptPath} ${this.config.userEmail} ${this.config.userPassword}`;

            const { stdout, stderr } = await exec(cmd);

            if (stderr) {
                this.log.warn('Warnung beim Ausführen des Scripts: ' + stderr);
            }

            return stdout;

        } catch (error) {
            this.log.error('Fehler beim Ausführen des Scripts: ' + error.message);
            return null;
        }
    }



    async onUnload(callback) {
        try {
            callback();
        } catch (e) {
            callback();
        }
    }



    async createDeviceObjects(device) {
        try {
            await this.setObjectNotExistsAsync(device.id, {
                type: 'device',
                common: {
                    name: device.name,
                    statusStates: {
                        onlineId: `${this.namespace}.${device.id}.alive`
                    }
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.Info', {
                type: 'channel',
                common: {
                    name: 'Device Information'
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.alive', {
                type: 'state',
                common: {
                    name: 'Is Fully alive?',
                    desc: 'If Fully Browser is alive or not',
                    type: 'boolean',
                    role: 'indicator.reachable',
                    read: true,
                    write: false
                },
                native: {}
            });
            await this.setObjectNotExistsAsync(device.id + '.lastInfoUpdate', {
                type: 'state',
                common: {
                    name: 'Last information update',
                    desc: 'Date/time of last information update from Fully Browser',
                    type: 'number',
                    role: 'value.time',
                    read: true,
                    write: false
                },
                native: {}
            });

            return true;
        } catch (e) {
            this.log.error(this.err2Str(e));
            return false;
        }
    }


}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
    module.exports = (options) => new xsenseControll(options);
} else {
    // otherwise start the instance directly
    new xsenseControll();
}
