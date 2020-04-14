const awsIot = require('aws-iot-device-sdk');

module.exports.iot = {
    init: ({ ca, cert, key, host, client }) => {
        return awsIot.jobs({
            caCert: ca,
            clientCert: cert,
            privateKey: key,
            clientId: client,
            host: host
        });
    }
};