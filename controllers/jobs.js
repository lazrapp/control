// heavily sourced from https://github.com/aws/aws-iot-device-sdk-js/blob/master/examples/jobs-agent.js

/*
jobs agent error values:
ERR_DOWNLOAD_FAILED
ERR_FILE_COPY_FAILED
ERR_UNNAMED_PACKAGE
ERR_INVALID_PACKAGE_NAME
ERR_SYSTEM_CALL_FAILED
ERR_UNEXPECTED_PACKAGE_EXIT
ERR_UNABLE_TO_START_PACKAGE
ERR_UNABLE_TO_STOP_PACKAGE
ERR_UNSUPPORTED_CHECKSUM_ALGORITHM
ERR_CHECKSUM_FAILED
ERR_UNEXPECTED
*/

//node.js deps
const crypto = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const handlers = require('./jobs/handlers');

//npm deps

//package deps
const { isUndefined } = require('../services/common');
const logger = require('../services/logger');

const maxBackoff = 24 * 60 * 60;   // set max backoff for job subscriptions to 24 hours in seconds
const killTimout = 20;             // set timeout to kill process at 20 seconds
const startupTimout = 20;          // set timeout to start process at 20 seconds
const maxStatusDetailLength = 64;

//
// Track information about management of packages in installedPackages JSON array.
//
// General format:
// [
//   {
//      "operation":"install",
//      "packageName":"uniquePackageName",
//      "autoStart":"true",
//      "workingDirectory":"./root/directory/for/files/and/launch/command/execution",
//      "launchCommand":"command to pass to child_process exec in order to launch executable package",
//      "files":[
//         {
//            "fileName":"destinationFileName",
//            "fileSource":{
//               "url":"https://s3-example-bucket-name.s3.amazonaws.com/exampleFileName"
//            }
//         }
//      ]
//   },
//   ...
// ]
//
var installedPackages = [];

//
// Track information about running state of packages
//
var packageRuntimes = {};

//
// Private function to show jobs errors
//
function showJobsError(err) {
    if (!isUndefined(err)) {
        console.error('jobs error', err);
    }
}

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
// Private function to stop managed package process
//
function stopPackage(packageName, cb) {
    var packageRuntime = packageRuntimes[packageName];

    if (isUndefined(packageRuntime) || isUndefined(packageRuntime.process)) {
        cb();
        return;
    }

    if (!isUndefined(packageRuntime.killTimer)) {
        cb(new Error('already attempting to stop package ' + packageName));
        return;
    }

    if (!isUndefined(packageRuntime.startupTimer)) {
        clearTimeout(packageRuntime.startupTimer);
        packageRuntime.startupTimer = null;
    }

    packageRuntime.killedCallback = cb;
    packageRuntime.killTimer = setTimeout(function () {
        packageRuntime.killedCallback = null;
        packageRuntime.killTimer = null;
        cb(new Error('unable to stop package ' + packageName));
    }, killTimout * 1000);

    packageRuntime.process.kill();
}


//
// Private function to stop managed package process
//
function stopPackageFromJob(job) {
    if (!isUndefined(job.document.packageName)) {
        stopPackage(job.document.packageName, function (err) {
            if (isUndefined(err)) {
                job.succeeded({ operation: job.operation, state: 'package stopped' }, showJobsError);
            } else {
                job.failed({ operation: job.operation, errorCode: 'ERR_UNABLE_TO_STOP_PACKAGE', errorMessage: errorToString(err) }, showJobsError);
            }
        });
    } else {
        job.failed({ operation: job.operation, errorCode: 'ERR_UNNAMED_PACKAGE', errorMessage: 'no packageName property specified' }, showJobsError);
    }
}


//
// Private function to start installed package
//
function startPackage(package, cb) {
    if (isUndefined(packageRuntimes[package.packageName])) {
        packageRuntimes[package.packageName] = {};
    }

    var packageRuntime = packageRuntimes[package.packageName];

    if (!isUndefined(packageRuntime.process)) {
        cb(new Error('package already running'));
        return;
    }

    packageRuntime.startupTimer = setTimeout(function () {
        packageRuntime.startupTimer = null;
        cb();
    }, startupTimout * 1000);

    packageRuntime.process = exec(package.launchCommand, { cwd: (!isUndefined(package.workingDirectory) ? path.resolve(package.workingDirectory) : undefined) }, function (err) {
        packageRuntime.process = null;
        if (!isUndefined(packageRuntime.startupTimer)) {
            clearTimeout(packageRuntime.startupTimer);
            packageRuntime.startupTimer = null;
            cb(err);
        } else if (!isUndefined(packageRuntime.killTimer)) {
            clearTimeout(packageRuntime.killTimer);
            packageRuntime.killTimer = null;
            packageRuntime.killedCallback();
            packageRuntime.killedCallback = null;
        }
    });
}


//
// Private function to start managed package process
//
function startPackageFromJob(job) {
    if (!isUndefined(job.document.packageName)) {
        var package = installedPackages.find(function (element) {
            return (element.packageName === job.document.packageName);
        });

        if (isUndefined(package)) {
            job.failed({ operation: job.operation, errorCode: 'ERR_INVALID_PACKAGE_NAME', errorMessage: 'no package installed called: ' + job.document.packageName }, showJobsError);
            return;
        }

        job.inProgress({ operation: job.operation, step: 'starting package, checking stability' }, function (err) {
            showJobsError(err);
            startPackage(package, function (err) {
                if (isUndefined(err)) {
                    job.succeeded({ operation: job.operation, state: 'package started' }, showJobsError);
                } else {
                    job.failed({ operation: job.operation, errorCode: 'ERR_UNABLE_TO_START_PACKAGE', errorMessage: errorToString(err) }, showJobsError);
                }
            });
        });
    } else {
        job.failed({ operation: job.operation, errorCode: 'ERR_UNNAMED_PACKAGE', errorMessage: 'no packageName property specified' }, showJobsError);
    }
}


//
// Private function to start managed package process
//
function restartPackage(job) {
    if (!isUndefined(job.document.packageName)) {
        job.inProgress({ operation: job.operation, step: 'stopping running package' }, function (err) {
            showJobsError(err);
            stopPackage(job.document.packageName, function (err) {
                if (isUndefined(err)) {
                    startPackageFromJob(job);
                } else {
                    job.failed({ operation: job.operation, errorCode: 'ERR_UNABLE_TO_STOP_PACKAGE', errorMessage: 'unable to stop package for restart' }, showJobsError);
                }
            });
        });
    } else {
        job.failed({ operation: job.operation, errorCode: 'ERR_UNNAMED_PACKAGE', errorMessage: 'no packageName property specified' }, showJobsError);
    }
}

function jobsAgent(jobs, args) {
    function subscribeToJobsWithRetryOnError(thingName, operationName, handler, backoff) {
        jobs.subscribeToJobs(thingName, operationName, function (err, job) {
            if (isUndefined(err)) {
                if ((!isUndefined(args.Debug)) && (args.Debug === true)) {
                    logger.verbose('Job execution handler invoked', { thingName: thingName, operationName: operationName });
                }
                handler(job);
                backoff = 1;   // reset backoff upon successful job receipt
            } else {
                // on error attempt to resubscribe with increasing backoff
                if (isUndefined(backoff)) {
                    backoff = 1;
                }
                setTimeout(function () {
                    subscribeToJobsWithRetryOnError(thingName, operationName, handler, Math.min(backoff * 2, maxBackoff));
                }, backoff * 1000);
            }
        });
    }

    subscribeToJobsWithRetryOnError(args.thingName, 'systemShutdown', handlers.systemShutdown);
    subscribeToJobsWithRetryOnError(args.thingName, 'systemReboot', handlers.systemReboot);
    subscribeToJobsWithRetryOnError(args.thingName, 'systemUpdate', handlers.systemUpdate);

    subscribeToJobsWithRetryOnError(args.thingName, 'packageInstall', handlers.packageInstall);
    subscribeToJobsWithRetryOnError(args.thingName, 'packageUninstall', handlers.packageUninstall);
    subscribeToJobsWithRetryOnError(args.thingName, 'packageUpdate', handlers.packageUpdate);
    subscribeToJobsWithRetryOnError(args.thingName, 'packageStop', handlers.packageStop);
    subscribeToJobsWithRetryOnError(args.thingName, 'packageStart', handlers.packageStart);
    subscribeToJobsWithRetryOnError(args.thingName, 'packageRestart', handlers.packageRestart);

    jobs.startJobNotifications(args.thingName, function (err) {
        if (isUndefined(err)) {
            logger.verbose('Started the job notification handler for %s', args.thingName);
        }
        else {
            logger.error('There has been an error starting the job notification handler');
            logger.error(err);
        }
    });
}

module.exports.init = async ({ iot, auth }) => {
    jobsAgent(iot, { thingName: auth.client, Debug: true });

    logger.verbose('Autostart installed packages');
    await handlers.autostart()
        .then(() => {
            logger.verbose('Autostart completed');
        })
        .catch(err => {
            logger.error('There has been an error autostarting installed packages');
            logger.error(err);
        });
};
module.exports.installedPackages = installedPackages;
module.exports.packageRuntimes = packageRuntimes;