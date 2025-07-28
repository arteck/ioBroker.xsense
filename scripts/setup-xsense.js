const fs = require('fs');
const path = require('path');
const { getVenv } = require('autopy');

(async () => {
    const envPath = path.join(__dirname, '..', '.autopy', 'xsense-env');

    if (fs.existsSync(envPath)) {
        console.log('Python-Umgebung "xsense-env" ist bereits vorhanden. Setup wird übersprungen.');
        return;
    }

    try {
        const python = await getVenv({
            name: 'xsense-env',
            pythonVersion: '~3.11',
            requirements: [
                { name: 'requests' },
                { name: 'aiohttp' }
            ],
            extraPackages: ['git+https://github.com/theosnel/python-xsense.git']
        });

        console.log('XSense-Umgebung erfolgreich eingerichtet.');
    } catch (err) {
        console.error('Fehler beim Einrichten der Umgebung:', err);
    }
})();
