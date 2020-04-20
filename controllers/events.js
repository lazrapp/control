const _ = require('lodash');

const emitter = require('../services/emitter');
const ipc = require('../services/ipc');
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
        },
        message: {
            received: {
                iot: ({package, message}) => {
                    logger.verbose('Received message for package %s', package);
                    if (package) ipc.emit('mqtt', package, message);
                },
                ipc: ({type, package, message}) => {
                    switch (type) {
                        case "state":
                            // update shadow
                            shadowUpdate(_.set({}, `state.reported._package[${package}]`, message));
                            break;
                        default:
                            // send mqtt
                            emitter.emit(`iot::package/message`, {type, package, message});
                            //iot.publish(`$aws/rules/PackageMessage/${type}`, JSON.stringify(message));
                    }
                }
            }
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

function packageMessageRouter(payload) {
    services.package.message.received.iot(payload);
}

function ipcMessageRouter(type, package, message) {
    console.log('<<', { type, package, message });
    services.package.message.received.ipc({ type, package, message });
}

module.exports = ({iot, auth}) => {
    let shadow = require('./shadow');
    let jobs = require('./jobs');
    let tunnel = require('./tunnel');

    let initChannels = [
        `devices/${auth.client}`,
        `devices/${auth.client}/packages`,
        `devices/$global`,
        `$aws/things/${auth.client}/shadow/delta`,
        `$aws/things/${auth.client}/shadow/get/#`,
        `$aws/things/${auth.client}/tunnels/notify`
    ];

    let channel = {
        iot: {
            private: initChannels[0],
            global: initChannels[2],
            tunnel: initChannels[6]
        },
        ipc: {
            state: `ipc::state`
        },
        map: {
            "iot::package/message": "$aws/rules/PackageMessage"
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
    emitter.on(`${channel.internal.private}/packages`, (payload) => packageMessageRouter(payload));
    emitter.on(channel.internal.global, (payload) => messageRouter("global", payload));

    // internal message routing
    emitter.on('package::started', (payload) => internalMessageRouter('package::started', payload));
    emitter.on('package::stopped', (payload) => internalMessageRouter('package::stopped', payload));
    emitter.on('package::startFailed', (payload) => internalMessageRouter('package::startFailed', payload));

    // ipc message routing
    emitter.on(channel.ipc.state, (payload) => ipcMessageRouter('state', payload.package, payload.state));

    // message emitter
    emitter.on(`iot::package/message`, ({ type, package, message }) => {
        iot.publish(`${channel.map[`iot::package/message`]}/${type}/${package}`, JSON.stringify(message || {}));
    });
    /*emitter.on('publish::iot', ({ topic, msg }) => {
        iot.publish(`${channel.iot.private}/${topic}`, JSON.stringify(msg || {}));
    });*/
};