const emitter = require('../services/emitter');
const shell = require('../services/shell');
const logger = require('../services/logger');

function tunnelOpen(args) {
    logger.info('Opening localproxy tunnel');
    shell.exec(`localproxy -r ${args.region} -d 22 -t ${args.clientAccessToken}`);
}

module.exports.init = ({ channel }) => {
    emitter.on(channel, (msg) => {
        tunnelOpen(msg);
    });
};