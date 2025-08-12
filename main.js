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
class xsenseControll extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'xsense',
        });

        this.json2iob = new Json2iobXSense(this);

        this._requestInterval = 0;

        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        try {
            let loginGo = true;
            this.log.info('Start X-Sense...');

            if (this.config.userEmail == '') {
                this.log.error('Check Settings. No Username set');
                loginGo = false;
            }
            if (this.config.userPassword == '') {
                this.log.error('Check Settings. No Password set');
                loginGo = false;
            }

            if (loginGo) {
                this.callPython = (await this.getState('info.callPython'))?.val;
                this.setAllAvailableToFalse();
                this.python = await this.setupXSenseEnvironment(true);

                if (this.python) {
                    await this.datenVerarbeiten(true);
                    this.setState('info.connection', true, true);

                    this.startIntervall();
                }
            }
        } catch (err) {
            this.setState('info.connection', false, true);
            this.log.error(`Error : ${err.message}`);
            return;
        }
    }

    async startIntervall() {
        this.log.debug('[XSense] Start intervall');

        if (!this.python) {
            this.log.warn('Python environment not initialized. Trying again...');
            this.python = await this.setupXSenseEnvironment();

            if (!this.python) {
                this.setState('info.connection', false, true);
                return;
            }
        }

        await this.datenVerarbeiten(false);

        if (!this._requestInterval) {
            this.log.debug(` Start XSense request intervall`);
            this._requestInterval = setInterval(async () => {
                await this.startIntervall();
            }, this.config.polltime * 1000);
        }
    }

    async datenVerarbeiten(firstTry) {
        this.log.debug('[XSense] datenVerarbeiten called');
        this.log.debug('[XSense] This may take up to 1 minute. Please wait');

        try {
            const response = await this.callBridge(this.python, this.config.userEmail, this.config.userPassword);

            if (response) {
                // hole alle devices und vergleiche ob was offline ist
                const devices = await this.getDevicesAsync();
                const knownDevices = tools.extractDeviceIds(devices);

                const parsed = tools.parseXSenseOutput(response, knownDevices);

                this.log.debug(`[XSense] parsed ${JSON.stringify(parsed)}`);

                await this.json2iob.parse(this.namespace, parsed);
            }
        } catch (err) {
            this.errorMessage(err, firstTry);
        }
    }

    async setupXSenseEnvironment(firstTry) {
        try {
            const { getVenv } = await import('autopy');
            const pfadPythonScript = tools.getDataFolder(this);
            this.log.debug('[XSense] getVenv imported from autopy');

            const python = await getVenv({
                name: 'xsense-env',
                pythonVersion: this.config.pythonVersion,
                requirements: [
                    { name: 'requests', version: '' },
                    { name: 'aiohttp', version: '' },
                ],
                extraPackages: [`${pfadPythonScript}python-xsense`],
            });

            this.log.debug('[XSense] Python environment ready ');

            return python;
        } catch (err) {
            this.errorMessage(err, firstTry);
        }
    }

    async callBridge(python, email, password) {
        this.log.debug('[XSense] callBridge ');

        return new Promise((resolve, reject) => {
            const scriptPath = path.join(__dirname, 'python', 'run_xsense.py');
            const proc = python(this.callPython, [scriptPath, email, password]);

            let result = '';

            proc.stdout?.on('data', data => {
                result += data.toString();
                this.log.debug(`[XSense] callBridge result ${data.toString()}`);
            });

            proc.stderr?.on('data', data => {
                this.log.warn(`[XSense]   callBridge request error `);
                this.log.warn(
                    `[XSense]   If it is the first run of the adapter, restart it manually and check again. `,
                );
            });

            proc.on('error', err => {
                reject(err);
            });

            proc.on('close', code => {
                this.log.debug(`[XSense] callBridge script exited with code ${code}`);

                if (code === 0) {
                    resolve(result.trim());
                } else {
                    reject(new Error(`[XSense] callBridge Python script exited with code ${code}`));
                }
            });
        });
    }

    async onUnload(callback) {
        try {
            if (this._requestInterval) {
                clearInterval(this._requestInterval);
            }
            this.setAllAvailableToFalse();
            callback();
        } catch (e) {
            callback();
        }
    }

    async setAllAvailableToFalse() {
        const availableStates = await this.getStatesAsync('*.online');
        for (const availableState in availableStates) {
            await this.setStateChangedAsync(availableState, false, true);
        }
    }

    async errorMessage(err, firstTry) {
        if (firstTry) {
            this.log.error(`[XSense] Fatal error starting Python | ${err} .`);
            this.log.error(`[XSense] ------------------------------------------------------`);
        }
        this.log.error(`[XSense] Python environment could not be initialized.`);

        if (firstTry) {
            this.log.error(`[XSense] Restart the adapter manually.`);
            this.setState('info.connection', false, true, () => {
                this.terminate('[XSense]  terminated', 1);
            });
        }
    }
}

if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new xsenseControll(options);
} else {
    // otherwise start the instance directly
    new xsenseControll();
}
