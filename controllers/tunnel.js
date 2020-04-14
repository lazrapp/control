const emitter = require('../services/emitter');
const shell = require('../services/shell');

function tunnelOpen(args) {
    console.log(`localproxy -r ${args.region} -d 22 -t ${args.clientAccessToken}`);
    //shell.exec(`localproxy -r ${args.region} -d 22 -t ${args.clientAccessToken}`);
}

module.exports.init = ({ channel }) => {
    emitter.on(channel, (msg) => {
        console.log('opening tunnel proxy');
        tunnelOpen(msg);
    });
};