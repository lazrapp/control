const crypto = require('crypto');
const { promisify } = require('util');
const child_process = require('child_process');
const exec = promisify(child_process.exec);
const fs = require('fs');
const path = require('path');

const _ = require('lodash');

const storage = require('./storage');
const { isUndefined } = require('../../services/common');
const emitter = require('../../services/emitter');
const logger = require('../../services/logger');

const maxStatusDetailLength = 64;

//
// Private function to safely convert errors to strings
//
function errorToString(err) {
    if (isUndefined(err)) {
        return undefined;
    } else if (err.toString().length > maxStatusDetailLength) {
        return err.toString().substring(0, maxStatusDetailLength - 3) + '...';
    } else {
        return err.toString();
    }
}

//
// Private function to validate checksum
//
async function validateChecksum(fileName, checksum) {
    const hashAlgorithm = checksum[0];
    const fileCheckSum = checksum[1];

    if (isUndefined(hashAlgorithm) || isUndefined(fileCheckSum)) return;

    var hash;
    try {
        hash = crypto.createHash(hashAlgorithm);
    } catch (err) {
        return new Error('Unsupported checksum hash algorithm: ' + hashAlgorithm);
    }

    var stream = fs.createReadStream(fileName);

    return new Promise((resolve, reject) => {
        stream.on('data', function (data) {
            hash.update(data, 'utf8');
        }).on('end', function () {
            if (hash.digest('hex') !== fileCheckSum) {
                var err = new Error('Checksum mismatch');
                err.fileName = fileName;
                return reject(err);
            }
            resolve();
        }).on('error', function (err) {
            err.fileName = fileName;
            return reject(err);
        });
    });
}

//
// Private function to promisify callback actions on jobs
//
function promisifyJobActions(job) {
    job.inProgress = promisify(job.inProgress);
    job.failed = promisify(job.failed);
    job.succeeded = promisify(job.succeeded);
    return job;
}

//
// Private function to exec stuff in the shell
//
async function runExec({ command, uid, cwd }) {
    logger.verbose('+ %s', command);
    logger.verbose('+ in %s as %s', cwd, uid);
    let args = {
        cwd: cwd || process.cwd()
    };
    if (uid) {
        args['uid'] = uid;
        args['gid'] = uid;
    }
    return exec(command, args);
}

//
// Private function to start a package
//
async function startPackage(package) {
    logger.info('Starting package %s', package);

    // is the package installed?
    let installation = storage.packages.get(package);
    if (!installation) throw Error(`Package ${package} is not installed`);

    // is the package already running?
    let running = storage.runtime.get(package);
    if (running) {
        // stop first
        await stopPackage(package);
    }

    // all good, start the package
    return new Promise((resolve, reject) => {
        let runtime = {};

        logger.verbose('Spawning %s %s', installation.sys.run[0], installation.sys.run[1]);
        runtime.process = child_process.spawn(installation.sys.run[0], installation.sys.run[1] || [], {
            cwd: installation.sys.dir,
            env: {
                lazr: {
                    package: installation.name,
                    installed: installation.installed
                }
            },
            uid: Number(installation.sys.user[1]),
            gid: Number(installation.sys.user[1])
        }).on('close', (code) => {
            logger.verbose('Process %s %s exited with code %s', installation.sys.run[0], installation.sys.run[1], code);
            storage.runtime.remove(package);
        }).on('error', (err) => {
            reject(err);
        });

        runtime.process.stdout.on('data', data => logger.verbose('Process %s stdout %s', installation.sys.run[0], data));
        runtime.process.stderr.on('data', data => logger.error('Process %s stderr %s', installation.sys.run[0], data));

        runtime.kill = () => {
            runtime.process.kill();
        };

        storage.runtime.set(package, runtime);

        if (runtime.process.pid) {
            resolve(runtime.process.pid);
        }
    });
}

//
// Private function to stop a package
//
async function stopPackage(package) {
    // is the package already running?
    let running = storage.runtime.get(package);
    if (!running) return; // silent skip

    running.kill();
}

//
// Private function to autostart installed packages
// should be invoked once at startup
//
async function autostartPackages() {
    let packages = storage.packages.list();
    packages = _.filter(packages, (o, id) => {
        o.id = id;
        return o.autostart;
    });

    await Promise.allSettled(packages.map((package) => startPackage(package.id)))
        .then(e => {
            let failed = [];
            e.forEach((p, n) => {
                if (p.status !== 'rejected') return;
                failed.push({ id: packages[n].id, err: p.reason });
            });
            if (failed.length > 0) return emitter.emit(`package::startFailed`, failed);
        })
        .catch(err => {
            logger.error('There has been an error autostarting packages');
            logger.error(err);
        });

    return true;
}

async function shutdownSystem(delay) {
    logger.info('System shutdown requested');
    return runExec({
        command: '/sbin/shutdown +' + delay
    });
}

async function rebootSystem(delay) {
    logger.info('System reboot requested');
    return runExec({
        command: '/sbin/shutdown -r +' + delay
    });
}

async function updateSystem() {
    logger.info('System update requested');
    logger.verbose('Updating control plane base');
    await runExec({
        command: `git fetch origin && git reset --hard origin/master`
    });
    logger.verbose('Updating control plane dependencies');
    await runExec({
        command: `npm install`
    });
    logger.info('System update completed, ending process (should be restarted by systemd)');
    process.exit(0);
}

//
// Public handlers
//
module.exports.systemShutdown = async (job) => {
    job = promisifyJobActions(job);

    // Change status to IN_PROGRESS
    await job.inProgress({ operation: job.operation, step: 'attempting' });
    let delay = (isUndefined(job.document.delay) ? '0' : job.document.delay.toString());
    
    shutdownSystem(delay).then(() => {
        job.succeeded({ operation: job.operation, step: 'initiated' });
    }).catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_SYSTEM_CALL_FAILED', errorMessage: 'unable to execute shutdown, you sure the control plane is running as root?',
            error: errorToString(err)
        });
    });
};

module.exports.systemReboot = async (job) => {
    job = promisifyJobActions(job);

    if (_.get(job, 'status.statusDetails.step') === 'initiated') {
        return job.succeeded({ operation: job.operation, step: 'rebooted' });
    }

    if (job.status.status !== 'QUEUED' ||
        !isUndefined(job.status.statusDetails) ||
        !isUndefined(job.status.statusDetails.step)) {
        return job.failed({ operation: job.operation, errorCode: 'ERR_UNEXPECTED', errorMessage: 'reboot job execution in unexpected state' });
    }
    
    await setProgress({ operation: job.operation, step: 'initiated' });
    let delay = (isUndefined(job.document.delay) ? '0' : job.document.delay.toString());
    
    await rebootSystem(delay).catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_SYSTEM_CALL_FAILED', errorMessage: 'unable to execute reboot, you sure control plane is running as root?',
            error: errorToString(err)
        });
    });
};

module.exports.systemUpdate = async (job) => {
    job = promisifyJobActions(job);

    if (_.get(job, 'status.statusDetails.step') === 'initiated') {
        return job.succeeded({ operation: job.operation, step: 'control plane has been updated' });
    }

    if (job.status.status !== 'QUEUED') {
        return job.failed({ operation: job.operation, errorCode: 'ERR_UNEXPECTED', errorMessage: 'reboot job execution in unexpected state' });
    }

    await job.inProgress({ operation: job.operation, step: 'initiated' });

    await updateSystem().catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_SYSTEM_CALL_FAILED', errorMessage: 'unable to execute update, this should not happen',
            error: errorToString(err)
        });
    });
}

//
// Private function to handle install new packages
//
/*{
    "operation": "packageInstall",
    "package": {
        "name": "",
        "id": "",
        "version": "1.0.1",
        "install": "git clone blabla",
        "start": ["npm", ["start"]],
        "download": [
            [ "https://some-bucket.s3.amazonaws.com/jobs-example.js", "SHA256:9569257356cfc5c7b2b849e5f58b5d287f183e08627743498d9bd52801a2fbe4" ]
        ],
        "hooks": {
            "pre": "",
            "post": "npm install"
        }
    },
    "autostart": true
}*/
async function installPackage({ job, updating, progress }) {
    const {
        package,
        autostart,
        priviledged
    } = job.document;

    // is the job in the expected state?
    if (job.status.status !== 'QUEUED') return job.failed({ operation: job.operation, errorCode: 'ERR_UNEXPECTED', errorMessage: 'job in unexpected state' });

    // is the job manifest valid?
    if (
        !package ||
        !package.id ||
        !package.install ||
        !package.start
    ) return job.failed({ operation: job.operation, errorCode: 'ERR_INVALID_MANIFEST', errorMessage: 'job has invalid manifest' });

    // is this package already installed?
    if (storage.packages.get(package.id)) return job.failed({ operation: job.operation, errorCode: 'ERR_PACKAGE_ALREADY_INSTALLED', errorMessage: 'selected package already installed' });

    // set directory (it will be created later)
    const packageDirectory = path.resolve(`./../packages/pck-${package.id}`);
    const packageUser = [`lazr-pck-${package.id}`, null];

    logger.info('Installing package %s as %s to %s', package.id, packageUser[0], packageDirectory);

    // basic validation passed, let's run the thing
    return installPackage().then(async () => {
        // install completed
        logger.info('Package %s successfully installed', package.id);
        storage.packages.set(package.id, {
            name: package.name,
            autostart: autostart,
            version: package.version,
            sys: {
                user: packageUser,
                dir: packageDirectory,
                run: package.start
            },
            installed: +new Date,
            manifest: job.document
        });
        job.succeeded({ operation: job.operation, state: 'package installation completed' });

        if (package.autostart) {
            // start package
            await startPackage(package.id);
        }
    }).catch(async err => {
        logger.error('There has been an error installing the package %s', package.id);
        logger.error(err);
        // install failed... cleanup the mess we created, deletes folders, and fails the job with an error

        await runExec({
            command: `rm -r ${packageDirectory}`
        }).catch(err => { });
        await runExec({
            command: `userdel -r ${packageUser[0]}`
        }).catch(err => { });
        job.failed({ operation: job.operation, errorCode: "ERR_PACKAGE_INSTALL_FAILED", errorMessage: errorToString(err) });
    });

    async function installPackage() {
        await progress('installing package');

        // create system user for package, create package directory
        await runExec({
            command: `useradd -m ${packageUser[0]} && usermod -L ${packageUser[0]}`
        });
        await runExec({
            command: `mkdir -p ${packageDirectory}`
        });

        // store user UID
        packageUser[1] = await runExec({
            command: `id -u ${packageUser[0]}`
        }).then(({ stdout }) => parseInt(stdout.replace(/(\r\n\t|\n|\r\t)/gm, "")));

        logger.verbose('Created user %s (%s) and directory %s', packageUser[0], packageUser[1], packageDirectory);

        // do we have to download any files?
        if (package.download && package.download.length > 0) {
            await progress('downloading files');
            let downloaded = [];
            package.download.forEach(async file => {
                // is file[0] in the right format?
                let url;
                try {
                    url = require('url').parse(file[0]);
                } catch (err) {
                    new Error(`URL ${file[0]} is invalid`);
                }

                // download file
                logger.verbose('Downloading %s to %s', url.toString(), packageDirectory);
                await runExec({
                    command: `cd ${packageDirectory} && { curl -O ${url.toString()} }`
                });

                // checksum
                return; // TODO
                try {
                    if (!file[1]) return;
                    validateChecksum('', file[1].split(':'));
                } catch (err) {
                    new Error(`URL ${file[0]} failed checksum`);
                }
            });
        }

        // make sure the package directory and its contents are chowned by the package user
        await runExec({
            command: `chown -R ${packageUser[0]}:${packageUser[0]} ${packageDirectory}`
        });

        // run preinstall hooks if any
        if (package.hooks && package.hooks.pre) {
            logger.verbose('Running preinstall hook');
            await progress('running pre-install hook');
            let args = {
                command: package.hooks.pre,
                cwd: packageDirectory
            };
            if (!priviledged) args.uid = Number(packageUser[1]);
            await runExec(args);
        }

        // run install hook if any
        if (package.install) {
            logger.verbose('Running install hook');
            await progress('running package install');
            let args = {
                command: package.install,
                cwd: packageDirectory
            };
            if (!priviledged) args.uid = Number(packageUser[1]);
            await runExec(args);
        }

        // run postinstall hooks if any
        if (package.hooks && package.hooks.post) {
            logger.verbose('Running postinstall hook');
            await progress('running post-install hook');
            let args = {
                command: package.hooks.post,
                cwd: packageDirectory
            };
            if (!priviledged) args.uid = Number(packageUser[1]);
            await runExec(args);
        }
    }
}

module.exports.packageInstall = (job) => {
    job = promisifyJobActions(job);

    let progressUpdate = async (step) => {
        return job.inProgress({ operation: job.operation, step: step });
    };

    installPackage({ job, progress: progressUpdate }).then(() => {

    }).catch(err => {

    });
};

//
// Private function to handle uninstall of packages
//
/*{
    "operation": "packageUninstall",
    "package": {
        "id": ""
    },
    "hooks": {
        "pre": "",
        "post": "npm install"
    }
}*/
async function uninstallPackage(job) {
    const {
        package,
        hooks
    } = job.document;

    // is the job manifest valid?
    if (
        !package ||
        !package.id
    ) throw Error('ERR_INVALID_MANIFEST');

    // is this package already installed?
    let installation = storage.packages.get(package.id);
    if (!installation) throw Error('ERR_PACKAGE_NOT_INSTALLED');

    // run pre uninstall hook if any
    if (hooks && hooks.pre) {
        await runExec({
            command: hooks.pre,
            cwd: installation.sys.dir,
            uid: Number(installation.sys.user[0])
        });
    }

    // stop the package
    await stopPackage(package.id);

    // run post uninstall hook if any
    if (hooks && hooks.post) {
        await runExec({
            command: hooks.post,
            cwd: installation.sys.dir,
            uid: Number(installation.sys.user[0])
        });
    }

    // remove the directory
    await runExec({
        command: `rm -r ${installation.sys.dir}`
    }).catch(err => { /*silent error*/ });

    // remove the user
    await runExec({
        command: `userdel -r ${installation.sys.user[0]}`
    }).catch(err => { /*silent error*/ });

    // remove entry from package storage
    storage.packages.remove(package.id);
}
module.exports.packageUninstall = (job) => {
    job = promisifyJobActions(job);

    // is the job in the expected state?
    if (job.status.status !== 'QUEUED') return job.failed({ operation: job.operation, errorCode: 'ERR_UNEXPECTED', errorMessage: 'job in unexpected state' });

    job.inProgress({ operation: job.operation, step: 'initiated' });

    uninstallPackage(job).then(() => {
        job.succeeded({ operation: job.operation, step: 'uninstalled package' });
    }).catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_PACKAGE_UNINSTALL_FAILED', errorMessage: 'unable to uninstall package',
            error: errorToString(err)
        });
    });
};

//
// Private function to handle updating of packages
//
/* manifest is the same as in install, the operation name is "packageUpdate" */
async function updatePackage(job) {
    const {
        package,
        hooks
    } = job.document;

    // is this package already installed?
    let installation = storage.packages.get(package.id);
    if (!installation) throw Error('ERR_PACKAGE_NOT_INSTALLED');

    // stop package

    // rename package directory

    // install package

    // start package

    // remove failover directory

    // if the process fails
        // cleanup the new directory
        // restore from failover
        // start package
}
module.exports.packageUpdate = (job) => {
    job = promisifyJobActions(job);

    job.inProgress({ operation: job.operation, step: 'initiated' });

    updatePackage(job).then(() => {
        job.succeeded({ operation: job.operation, step: 'updated package' });
    }).catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_PACKAGE_UPDATE_FAILED', errorMessage: 'unable to update package',
            error: errorToString(err)
        });
    });
};

module.exports.packageRestart = async (job) => {
    job = promisifyJobActions(job);

    job.inProgress({ operation: job.operation, step: 'initiated' });

    //stop package
    await stopPackage(job.document.package.id)
        .then(() => {
            job.inProgress({ operation: job.operation, step: 'stopped package' });
        })
        .catch(err => {
            // silent error
            logger.error('Expected to stop package, but was unable');
            logger.error(err);
        });
    
    //start package
    await startPackage(job.document.package.id)
        .then(async () => {
            await job.succeeded({ operation: job.operation, step: 'restarted package' });
        })
        .catch(err => {
            job.failed({
                operation: job.operation, errorCode: 'ERR_PACKAGE_START_FAILED', errorMessage: 'unable to restart package',
                error: errorToString(err)
            });
        });
};

module.exports.packageStop = async (job) => {
    job = promisifyJobActions(job);

    job.inProgress({ operation: job.operation, step: 'initiated' });

    //stop package
    await stopPackage(job.document.package.id)
        .then(() => {
            job.succeeded({ operation: job.operation, step: 'stopped package' });
        })
        .catch(err => {
            job.failed({
                operation: job.operation, errorCode: 'ERR_PACKAGE_STOP_FAILED', errorMessage: 'unable to stop package',
                error: errorToString(err)
            });
        });
};

module.exports.packageStart = async (job) => {
    job = promisifyJobActions(job);

    job.inProgress({ operation: job.operation, step: 'initiated' });

    //start package
    await startPackage(job.document.package.id)
        .then(() => {
            job.succeeded({ operation: job.operation, step: 'started package' });
        })
        .catch(err => {
            job.failed({
                operation: job.operation, errorCode: 'ERR_PACKAGE_START_FAILED', errorMessage: 'unable to start package',
                error: errorToString(err)
            });
        });
};

module.exports.autostart = () => {
    return autostartPackages();
};

/*setTimeout(() => {
    handlers.install({
        inProgress: (e, cb) => {
            console.log(`job.inProgress`, e);
            cb();
        },
        failed: (e, cb) => {
            console.log(`job.failed`, e);
            cb();
        },
        succeeded: (e, cb) => {
            console.log(`job.succeeded`, e);
            cb();
        },
        status: {
            status: "QUEUED"
        },
        operation: "install",
        document: {
            package: {
                id: "test0001",
                install: "ls /usr/var/lazr/control",
                start: "top"
            }
        }
    });
}, 10000);*/

/*setTimeout(async () => {
    let autostart = await autostartPackages();
    console.log('autostart', autostart);
}, 1000);*/

/*setInterval(() => {
    //console.log('>> package', storage.packages.list());
    console.log('>> runtime', storage.runtime.list());
}, 5000);*/