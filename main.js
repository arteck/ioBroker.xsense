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
        this.on('schedule', this.onSchedule.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            this.log.info('Start X-Sense...');

            this.python = await this.setupXSenseEnvironment();

            if (!this.python) {
                this.log.error('Python environment could not be initialized.');
                return;
            }

            await this.datenVerarbeiten();
            this.setState('info.connection', true, true);

        } catch (err) {
            this.setState('info.connection', false, true);
            this.log.error(`Error on Login or Setup: ${err.message}`);
            return;
        }
    }

    async onSchedule() {
        if (!this.python) {
            this.log.warn('Python environment not initialized. Trying again...');
            this.python = await this.setupXSenseEnvironment();
            if (!this.python) {
                this.setState('info.connection', false, true);
                return;
            }
        }

        await this.datenVerarbeiten();

    }

    async datenVerarbeiten() {
        const response = await this.callBridge(this.python, this.config.userEmail, this.config.userPassword);

        if (response) {
            let knownDevices = [];
            let iobDevices = await this.getDevicesAsync();

            const parsed = tools.parseXSenseOutput(response, knownDevices);

            await this.json2iob.parse('xsense.0', parsed, {forceIndex: true, write: true});

        }
    }


    async setupXSenseEnvironment() {
        try {
            const { getVenv } = await import('autopy');
            const pfadPythonScript = tools.getDataFolder(this);
            this.log.debug('[XSense] getVenv imported from autopy');

            const python = await getVenv({
                name: 'xsense-env',
                pythonVersion: '~3.13',
                requirements: [
                    { name: 'requests', version: '' },
                    { name: 'aiohttp', version: '' }
                ],
                extraPackages: [
                    pfadPythonScript + 'python-xsense'
                ]
            });

            this.log.debug('[XSense] Python environment ready at ' + python.path);

            return python;
        } catch (err) {
            this.log.error('[XSense] Error on create ' + err.message);
            this.log.debug(err.stack);
            return null;
        }
    }

    async callBridge(python, email, password) {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'python', 'run_xsense.py');
            const proc = python('python3', [scriptPath, email, password]);

            let result = '';

            proc.stdout?.on('data', data => {
                result += data.toString();
            });

            proc.stderr?.on('data', data => {
                this.log.warn('callBridge warning: ' + data.toString());
            });

            proc.on('error', err => {
                reject(err);
            });

            proc.on('close', code => {
                this.log.info('callBridge script exited with code ' + code);
                if (code === 0) {
                    resolve(result.trim());
                } else {
                    reject(new Error(`callBridge Python script exited with code ${code}`));
                }
            });
        });
    }


    async onUnload(callback) {
        try {
            callback();
        } catch (e) {
            callback();
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
