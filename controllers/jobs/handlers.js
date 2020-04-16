const crypto = require('crypto');
const { promisify } = require('util');
const child_process = require('child_process');
const exec = promisify(child_process.exec);
const fs = require('fs');
const path = require('path');

const _ = require('lodash');

const storage = require('./storage');
const { isUndefined, downloadFile, copyFile } = require('../../services/common');
const emitter = require('../../services/emitter');

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
// Private function to start a package
//
async function startPackage(package) {
    console.log('<<', 'startPackage', package);

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

        console.log('>> spawn', installation.sys.run[0], installation.sys.run[1]);
        runtime.process = child_process.spawn(installation.sys.run[0], installation.sys.run[1] || [], {
            cwd: installation.sys.dir,
            env: {
                lazr: {
                    package: installation.name,
                    installed: installation.installed
                }
            },
            uid: Number(installation.sys.user[1])
        }).on('close', () => {
            storage.runtime.remove(package);
        }).on('error', (err) => {
            reject(err);
        });

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
    if (!running) {
        // try to find the process
        throw Error(`Can't find running process`); // TODO
    }

    running.kill();
}

//
// Private function to install a package
//
/*{
    "operation": "install",
    "package": {
        "name": "",
        "id": "",
        "version": "1.0.1",
        "install": "git clone blabla",
        "start": ["npm", ["start"]],
        "download": [
            [ "https://some-bucket.s3.amazonaws.com/jobs-example.js", "SHA256:9569257356cfc5c7b2b849e5f58b5d287f183e08627743498d9bd52801a2fbe4" ]
        ]
    },
    "hooks": {
        "pre": "",
        "post": "npm install"
    },
    "autostart": true
}*/
async function installPackage(job) {
    const {
        package,
        hooks,
        autostart
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
    const packageDirectory = path.resolve(`./../packages/pck_${package.id}`);
    const packageUser = [`lazr_pck_${package.id}`, null];

    // basic validation passed, let's run the thing
    installPackage().then(() => {
        // install completed
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
    }).catch(async err => {
        console.error(err);
        // install failed... cleanup the mess we created, deletes folders, and fails the job with an error
        await exec(`sudo rm -r ${packageDirectory}`).catch(err => { });
        await exec(`sudo userdel ${packageUser[0]}`).catch(err => { });
        job.failed({ operation: job.operation, errorCode: "ERR_PACKAGE_INSTALL_FAILED", errorMessage: errorToString(err) });
    });

    async function installPackage() {
        await job.inProgress({ operation: job.operation, step: 'installing package' });

        // create system user for package, create package directory
        await exec(`sudo useradd -M ${packageUser[0]} && sudo usermod -L ${packageUser[0]}`);
        await exec(`sudo mkdir ${packageDirectory}`);

        // store user UID
        packageUser[1] = await exec(`sudo id -u ${packageUser[0]}`).then(({ stdout }) => stdout.replace(/(\r\n\t|\n|\r\t)/gm, "").parseInt());

        // do we have to download any files?
        if (package.download && package.download.length > 0) {
            await job.inProgress({ operation: job.operation, step: 'downloading files' });
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
                await exec(`cd ${packageDirectory} && { sudo curl -O ${url.toString()} }`);

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
        await exec(`sudo chown -R ${packageUser[0]} ${packageDirectory}`);

        // run preinstall hooks if any
        if (hooks && hooks.pre) {
            await job.inProgress({ operation: job.operation, step: 'running pre-install hook' });
            await exec(`${hooks.pre}`);
        }

        // run install hook if any
        if (package.install) {
            await job.inProgress({ operation: job.operation, step: 'running package install' });
            await exec(`${package.install}`);
        }

        // start package
        await job.inProgress({ operation: job.operation, step: 'starting package' });
        await startPackage(package.id);

        // run postinstall hooks if any
        if (hooks && hooks.post) {
            await job.inProgress({ operation: job.operation, step: 'running post-install hook' });
            await exec(`${hooks.post}`);
        }
    }
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
            console.error(err);
        });

    return true;
}

async function shutdownSystem(delay) {
    // User account running node.js agent must have passwordless sudo access on /sbin/shutdown
    // Recommended online search for permissions setup instructions https://www.google.com/search?q=passwordless+sudo+access+instructions
    return exec('sudo /sbin/shutdown +' + delay);
}

async function rebootSystem(delay) {
    // User account running node.js agent must have passwordless sudo access on /sbin/shutdown
    // Recommended online search for permissions setup instructions https://www.google.com/search?q=passwordless+sudo+access+instructions
    return exec('sudo /sbin/shutdown -r +' + delay);
}

async function updateSystem() {
    console.log("<<", "updating control plane base");
    await exec(`git fetch origin && git reset --hard origin/master`, { cwd: process.cwd() });
    console.log("<<", "updating control plane dependencies");
    await exec(`npm install`, { cwd: process.cwd() });
    console.log("<<", "shutting down");
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
            operation: job.operation, errorCode: 'ERR_SYSTEM_CALL_FAILED', errorMessage: 'unable to execute shutdown, check passwordless sudo permissions on agent',
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

    // User account running node.js agent must have passwordless sudo access on /sbin/shutdown
    // Recommended online search for permissions setup instructions https://www.google.com/search?q=passwordless+sudo+access+instructions
    await rebootSystem(delay).catch(err => {
        job.failed({
            operation: job.operation, errorCode: 'ERR_SYSTEM_CALL_FAILED', errorMessage: 'unable to execute reboot, check passwordless sudo permissions on agent',
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
        ]
    },
    "hooks": {
        "pre": "",
        "post": "npm install"
    },
    "autostart": true
}*/
module.exports.packageInstall = (job) => {
    job = promisifyJobActions(job);

    installPackage(job);
};

module.exports.packageRestart = async (job) => {
    job = promisifyJobActions(job);

    job.inProgress({ operation: job.operation, step: 'initiated' });

    //stop package
    await stopPackage()
        .then(() => {
            job.inProgress({ operation: job.operation, step: 'stopped package' });
        })
        .catch(err => {
            // silent error
            console.error('expected to stop package, but was unable', err);
        });
    
    //start package
    await startPackage()
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
    await stopPackage()
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
    await startPackage()
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