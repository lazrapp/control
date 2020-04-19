const _ = require('lodash');

const emitter = require('../services/emitter');
const logger = require('../services/logger');

let shadowUpdate;

const services = {
    getSystemInfo: () => {
        const { installedPackages } = require('./jobs');

        let packageNames = installedPackages.map(package => package.packageName);

        let res = {
            installedPackages: JSON.stringify(packageNames),
            arch: process.arch,
            nodeVersion: process.version,
            cwd: process.cwd(),
            platform: process.platform,
            title: process.title,
            uptime: process.uptime()
        };

        emitter.emit('publish::iot', {
            topic: 'systemInfo',
            msg: res
        });
    },
    package: {
        started: (package) => {
            let { id, pid, ts } = package;
            logger.verbose('package %s has started with PID %d', id, pid);
            let state = _.set({}, `state.reported._runtime[${id}]`, { pid, ts });
            shadowUpdate(state);
        },
        stopped: (package) => {
            let { id } = package;
            logger.verbose('package %s has stopped', id);
            let state = _.set({}, `state.reported._runtime[${id}]`, null);
            shadowUpdate(state);
        },
        startFailed: (packages) => {
            packages.forEach(package => {
                logger.error('package %s has failed to autostart', id);
                logger.errro(package.err);
            });
        }
    }
};

// expose services to global, private and other controllers

const controllers = {
    global: {
        getSystemInfo: services.getSystemInfo
    },
    private: {
        getSystemInfo: services.getSystemInfo
    },
    internal: {
        "package::started": services.package.started,
        "package::stopped": services.package.stopped,
        "package::startFailed": services.package.startFailed
    }
};

// map messages to internal controllers

/* message structure example
{
    function: "getSystemInfo",
    attributes: []
}
*/
function messageRouter(type, payload) {
    let { topic, attributes } = payload;

    let fn = _.get(controllers, `${type}.${topic}`, null);

    if (fn === null) return logger.error('Unsupported %s function call %d', type, topic);

    fn({ message: attributes });
}

function internalMessageRouter(topic, payload) {
    let fn = _.get(controllers, `internal.${topic}`, null);

    if (fn) fn(payload);
}

module.exports = ({iot, auth}) => {
    let shadow = require('./shadow');
    let jobs = require('./jobs');
    let tunnel = require('./tunnel');

    let initChannels = [
        `devices/${auth.client}`,
        `devices/$global`,
        `$aws/things/${auth.client}/shadow/delta`,
        `$aws/things/${auth.client}/shadow/get/#`,
        `$aws/things/${auth.client}/tunnels/notify`
    ];

    let channel = {
        iot: {
            private: initChannels[0],
            global: initChannels[1],
            tunnel: initChannels[5]
        },
        internal: {}
    };

    for (const key in channel.iot) {
        channel.internal[key] = `iot::${channel.iot[key]}`;
    }
    
    let events = {
        onConnect: async () => {
            logger.info('Connected');
            iot.subscribe(initChannels);
            
            // ready to go, start the dependencies
            let { update } = await shadow.init({ iot, auth });
            shadowUpdate = update;

            await jobs.init({ iot, auth });
            
            await tunnel.init({ channel: channel.internal.tunnel });
        },
        onClose: () => {
            logger.info('Closed');
        },
        onReconnect: () => {
            logger.info('Reconnect');
        },
        onOffline: () => {
            logger.info('Offline');
        },
        onError: (err) => {
            logger.error(err);
            throw new Error(err);
        },
        onMessage: (topic, payload) => {
            logger.verbose('Received MQTT message on topic %s', topic);
            emitter.emit(`iot::${topic}`, JSON.parse(payload.toString()));
        }
    };

    // mqtt message routing
    iot
        .on('connect', events.onConnect)
        .on('close', events.onClose)
        .on('reconnect', events.onReconnect)
        .on('offline', events.onOffline)
        .on('error', events.onError)
        .on('message', events.onMessage);

    // message routing
    emitter.on(channel.internal.private, (payload) => messageRouter("private", payload));
    emitter.on(channel.internal.global, (payload) => messageRouter("global", payload));

    // internal message routing
    emitter.on('package::started', (payload) => internalMessageRouter('package::started', payload));
    emitter.on('package::stopped', (payload) => internalMessageRouter('package::stopped', payload));
    emitter.on('package::startFailed', (payload) => internalMessageRouter('package::startFailed', payload));

    // message emitter
    emitter.on('publish::iot', ({ topic, msg }) => {
        iot.publish(`${channel.iot.private}/${topic}`, JSON.stringify(msg || {}));
    });
};