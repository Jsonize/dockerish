const { program } = require("commander");
const FS = require("fs");
const Path = require('path');
const Template = require('lodash.template');
const Tmp = require('tmp');
const Yaml = require("js-yaml");
const ChildProcess = require("child_process");
const OS = require("os");

program
    .option("-c, --config <file>", "dockerish config file, defaults to ./dockerish.config.json")
    .option("-o, --overwrite <arg...>", "overwrite config options")
    .option("-v", "mounts <mount...>", "additional mounts")
    .option("-n, --namespace <namespace>", "config sub name space (optional)")
    .option("-t, --target <file>", "dockerish template file or folder containing the template file, defaults to ./dockerish.template.yml")
    .option("-r, --run", "runs the container (add additional parameters after --)")
    .option("-x, --runc <cmd>", "runs the container with a particular command (add additional parameters after --)")
    .option("-s, --stop", "stops the container")
    .option("-b, --build", "builds the container")
    .option("-nc, --nocache", "builds the container without cache")
    .option("-bx, --buildx <archictectures>", "builds the container against architectures ")
    .option("-e, --buildondemand", "builds the container on demand when running")
    .option("-d, --debug", "debug");

program.parse(process.argv);
const options = program.opts();


var tempFiles = [];

const cleanTempFiles = function () {
    while (tempFiles.length > 0)
        FS.unlinkSync(tempFiles.shift());
}

process.on('SIGINT', function() {
    cleanTempFiles();
    process.exit();
});


var config = {};
if (options.config)
    config = JSON.parse(FS.readFileSync(options.config));
else if (FS.existsSync("./dockerish.config.json"))
    config = JSON.parse(FS.readFileSync("./dockerish.config.json"));

if (options.overwrite) {
    options.overwrite.forEach(function (keyvalue) {
        var splt = keyvalue.split(":");
        config[splt.shift()] = splt.join(":");
    });
}

var mountPlaceholders = {};
if (options.mounts) {
    options.mounts.forEach(function (keyvalue) {
        var splt = keyvalue.split(":");
        mountPlaceholders[splt[0]] = splt[1];
    });
}

const json_replacer = function (obj) {
    for (var key in obj) {
        var value = obj[key];
        if (typeof value === "string") {
            value = value.split("%{JSON:");
            var result = value.shift();
            while (value.length > 0) {
                var current = value.shift().split("}");
                var json = current.shift().split(".");
                var root = config;
                while (json.length > 0)
                    root = root[json.shift()];
                result += root + current.join("}");
                obj[key] = result;
            }
        } else if (value && typeof value === "object")
            json_replacer(value);
    }
};

json_replacer(config);

const shellScriptOf = function (lines, next) {
    console.log(lines);
    var shell = ChildProcess.spawn("sh", ["-c", lines.trim().split("\n").join("&&")], {
        cwd: config.target
    });
    shell.on("close", function (status) {
        next(status);
    });
    shell.stderr.pipe(process.stderr);
    shell.stdout.pipe(process.stdout);
};


if (options.namespace)
    config = config[options.namespace] || {};

if (options.debug)
    console.log(config);

var targetFile = "./dockerish.template.yml";
if (options.target && FS.lstatSync(options.target).isDirectory())
    targetFile = options.target + "/dockerish.template.yml";
else if (options.target)
    targetFile = options.target;

var rawTarget = FS.readFileSync(targetFile);

if (options.debug)
    console.log(rawTarget + "");

config.FS = FS;
config.target = Path.dirname(targetFile);

var compiledTarget = Template(rawTarget)(config);

if (compiledTarget.indexOf("%{HOSTIP}") >= 0) {
    var ifaces = OS.networkInterfaces();
    var ips = [];
    Object.keys(ifaces).forEach(function(dev) {
        for (var i = 0, len = ifaces[dev].length; i < len; i++) {
            var details = ifaces[dev][i];
            if (details.family === 'IPv4')
                ips.push(details.address);
        }
    });
    var hostip = null;
    ips.forEach(function (ip) {
        if (hostip)
            return;
        if (ip.indexOf("192.") === 0 || ip.indexOf("10.") === 0 || ip.indexOf("172.") === 0 || (ip.indexOf("127.") === 0 && ip !== "127.0.0.1"))
            hostip = ip;
    });
    if (!hostip && ips.length > 0)
        hostip = ips[0];
    if (!hostip)
        hostip = "127.0.0.1";
    compiledTarget = compiledTarget.split("%{HOSTIP}").join(hostip);
}

if (options.debug)
    console.log(compiledTarget);

var target = Yaml.safeLoad(compiledTarget);

if (options.debug)
    console.log(target);

var tasks = [];

const targetDir = Path.dirname(targetFile) + (target.container.basedir ? "/" + target.container.basedir : "");


if (options.stop) {
    tasks.push(function (next) {
        var dockerArgs = target.run && target.run.restart ? ["rm", "-f"] : ["stop"];
        dockerArgs.push(target.container.image);
        dockerArgs = dockerArgs.concat(program.args);
        if (options.debug)
            console.log("docker", dockerArgs.join(" "));
        var docker = ChildProcess.spawn("docker", dockerArgs, {
            cwd: config.target
        });
        docker.on("close", next);
        docker.stderr.pipe(process.stderr);
        docker.stdout.pipe(process.stdout);
    });
}



const pushTaskBuild = function () {
    if (target.prebuild) {
        tasks.push(function (next) {
            shellScriptOf(target.prebuild, next);
        });
    }

    tasks.push(function (next) {
        if (target.dockerfile.symlinks) {
            target.dockerfile.symlinks.forEach(function (symlink) {
                var tempFile = Tmp.tmpNameSync({
                    template: targetDir + "/symlink-tmp-XXXXXX"
                }) + ".tar";
                tempFiles.push(tempFile);
                ChildProcess.execSync("tar -C " + symlink + " -cvf " + tempFile + " . 2> /dev/null");
                target.dockerfile.commands = target.dockerfile.commands.replace(symlink, tempFile);
            });
        }
        var dockerfileLines = [
            "FROM " + target.dockerfile.from,
            "MAINTAINER " + target.dockerfile.maintainer
        ];
        if (options.nocache)
            dockerfileLines.push("RUN echo " + (new Date()).getTime());
        dockerfileLines = dockerfileLines.concat(target.dockerfile.commands.split("\n"));
        var tempDockerfile = Tmp.tmpNameSync({
            template: targetDir + "/Dockerfile-tmp-XXXXXX"
        });
        tempFiles.push(tempDockerfile);
        FS.writeFileSync(tempDockerfile, dockerfileLines.join("\n"));
        var dockerArgs = ["build"];
        if (options.buildx)
            dockerArgs = ["buildx", "build", "--platform", options.buildx, "--output", "type=docker"];
        dockerArgs = dockerArgs.concat([
            "-f",
            tempDockerfile,
            "-t",
            target.container.name,
            targetDir
        ]);
        dockerArgs = dockerArgs.concat(program.args);
        if (options.debug)
            console.log("docker", dockerArgs.join(" "));
        var docker = ChildProcess.spawn("docker", dockerArgs, {
            cwd: config.target
        });
        docker.on("close", function (status) {
            cleanTempFiles();
            next(status);
        });
        docker.stderr.pipe(process.stderr);
        docker.stdout.pipe(process.stdout);
    });

    if (target.postbuild) {
        tasks.push(function (next) {
            shellScriptOf(target.postbuild, next);
        });
    }
};


const pushTaskRun = function (buildondemand) {
    if (target.prerun) {
        tasks.push(function (next) {
            shellScriptOf(target.prerun, next);
        });
    }

    tasks.push(function (next) {
        var dockerArgs = ["run"];
        var targetrun = options.runc ? target[options.runc] : target.run;
        targetrun = targetrun || {};
        if (targetrun.daemon)
            dockerArgs.push("-d");
        if (targetrun.restart)
            dockerArgs.push("--restart=" + targetrun.restart);
        else
            dockerArgs.push("--rm");
        if (target.environment) {
            var tempFile = Tmp.tmpNameSync({
                template: targetDir + "/dockerenv-tmp-XXXXXX"
            }) + ".env";
            tempFiles.push(tempFile);
            FS.writeFileSync(tempFile, target.environment);
            dockerArgs.push("--env-file");
            dockerArgs.push(tempFile);
        }
        if (targetrun.portmaps) {
            targetrun.portmaps.forEach(function (portmap) {
                dockerArgs.push("-p");
                dockerArgs.push(portmap.host + ":" + portmap.container + (portmap.udp ? "/udp" : ""));
            });
        }
        if (targetrun.mounts) {
            targetrun.mounts.forEach(function (mount) {
                dockerArgs.push("-v");
                var mountHost = Path.resolve(mount.placeholder ? mountPlaceholders[mount.placeholder] : mount.host);
                dockerArgs.push(mountHost + ":" + mount.container + ":" + mount.permission);
                if (mount.permission.indexOf("w") >= 0 && !FS.existsSync(mountHost)) {
                    if (Path.extname(mountHost))
                        FS.writeFileSync(mountHost, "");
                    else
                        FS.mkdirSync(mountHost);
                }

            });
        }
        if (targetrun.privileged) {
            dockerArgs.push("--privileged");
            dockerArgs.push("-v");
            dockerArgs.push("/dev:/dev");
        }
        if (targetrun.memory) {
            dockerArgs.push("--memory=" + targetrun.memory);
        }
        if (targetrun.logmaxsize) {
            dockerArgs.push("--log-opt");
            dockerArgs.push("max-size=" + targetrun.logmaxsize);
        }
        if (target.container.image) {
            dockerArgs.push("--name");
            dockerArgs.push(target.container.image);
        }
        if (targetrun.interactive)
            dockerArgs.push("-i");
        else
            dockerArgs.push("-t");
        dockerArgs.push(target.container.name);
        if (targetrun.command)
            dockerArgs = dockerArgs.concat(targetrun.command.split(" "));
        dockerArgs = dockerArgs.concat(program.args);
        if (options.debug)
            console.log("docker", dockerArgs.join(" "));
        var docker = ChildProcess.spawn("docker", dockerArgs, {
            cwd: config.target
        });
        var errorData = "";
        docker.on("close", function () {
            cleanTempFiles();
            if (errorData.indexOf("Unable to find image") >= 0 && buildondemand) {
                pushTaskBuild();
                pushTaskRun(false);
            }
            next();
        });
        docker.stderr.pipe(process.stderr);
        docker.stdout.pipe(process.stdout);
        docker.stderr.on("data", function (data) {
            errorData += data;
        });
        process.stdin.pipe(docker.stdin);
    });
};


if (options.build)
    pushTaskBuild();

if (options.run || options.runc)
    pushTaskRun(options.buildondemand);


var taskExecute = function (status) {
    if (tasks.length > 0) {
        var task = tasks.shift();
        task(taskExecute);
    } else {
        process.exit(status);
    }
};


taskExecute(0);