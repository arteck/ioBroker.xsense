const mqtt = require('mqtt');


function connectMqtt(adapter, credentials, config, deviceList) {
    const url = `wss://${config.iot.endpoint}/mqtt`;
    const clientId = `xsense-${Math.floor(Math.random() * 100000)}`;

    const client = mqtt.connect(url, {
        clientId,
        protocol: 'wss',
        accessKeyId: credentials.accessKeyId,
        secretKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        region: config.region,
        keepalive: 60,
        reconnectPeriod: 3000,
    });

    client.on('connect', () => {
        adapter.log.info('✅ Verbunden mit X-Sense MQTT');

        for (const dev of deviceList) {
            const topic = `$aws/things/${dev.uuid}/shadow/update/documents`;
            client.subscribe(topic, (err) => {
                if (err) adapter.log.error(`Fehler beim Abonnieren: ${topic}`);
                else adapter.log.info(`📡 Abonniert: ${topic}`);
            });
        }
    });

    client.on('message', (topic, payload) => {
        try {
            const uuid = topic.split('/')[2];
            const data = JSON.parse(payload.toString());
            const reported = data.current?.state?.reported;
            if (!reported) return;

            for (const key in reported) {
                const path = `devices.${uuid}.${key}`;
                adapter.setObjectNotExistsAsync(path, {
                    type: 'state',
                    common: {
                        name: key,
                        type: typeof reported[key],
                        role: 'state',
                        read: true,
                        write: false,
                    },
                    native: {},
                });
                adapter.setStateAsync(path, reported[key], true);
            }
        } catch (e) {
            adapter.log.error('MQTT Fehler: ' + e.message);
        }
    });

    return client;
}

module.exports = connectMqtt;