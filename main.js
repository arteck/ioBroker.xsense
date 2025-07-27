const utils = require('@iobroker/adapter-core');
const tools = require('./lib/tools');

const { PythonShell } = require('python-shell');
const path = require('path');
const { exec } = require("child_process");

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

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            this.log.info('Starte Login bei X-Sense...');

            const response = this.xsenseLogin();


            let asdasd = 0;

        } catch (err) {
            this.log.error(`Fehler beim Login oder Setup: ${err.message}`);
            return;
        }
    }


    async xsenseLogin() {

        const scriptPath = path.join(tools.getDataFolder(this), 'run_xsense.py');
        const cmd = `python3 ${scriptPath} ${this.config.userEmail} ${this.config.userPassword}`;

        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                this.log.error("Fehler beim Ausführen des Scripts: " + error.message, "error");
                return;
            }
            try {
                const result = JSON.stringify(stdout);
                return result;

            } catch (e) {
                this.log.error("Fehler beim Parsen der Ausgabe: " + e.message, "error");
                this.log.error("RAW: " + stdout, "debug");
            }
        });
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
