const GetOpt = require("node-getopt");
const FS = require("fs");
const Path = require('path');
const Template = require('lodash.template');
const Tmp = require('tmp');
const Yaml = require("js-yaml");
const ChildProcess = require("child_process");
const OS = require("os");

var parsedArgs = GetOpt.create([
    ["h", "help", "shows help"],
    ["c", "config=FILE", "dockerish config file, defaults to ./dockerish.config.json"],
    ["o", "overwrite=ARG+", "overwrite config options"],
    ["v", "mounts=MOUNTS+", "additional mounts"],
    ["n", "namespace=NAMESPACE", "config sub name space (optional)"],
    ["t", "target=FILE", "dockerish template file or folder containing the template file, defaults to ./dockerish.template.yml"],
    ["r", "run", "runs the container (add additional parameters after --)"],
    ["x", "runc=CMD", "runs the container with a particular command (add additional parameters after --)"],
    ["s", "stop", "stops the container"],
    ["b", "build", "builds the container"],
    ["d", "debug", "debug"]
]).bindHelp().parseSystem();


var config = {};
if (parsedArgs.options.config)
    config = JSON.parse(FS.readFileSync(parsedArgs.options.config));
else if (FS.existsSync("./dockerish.config.json"))
    config = JSON.parse(FS.readFileSync("./dockerish.config.json"));

if (parsedArgs.options.overwrite) {
    parsedArgs.options.overwrite.forEach(function (keyvalue) {
        var splt = keyvalue.split(":");
        config[splt[0]] = splt[1];
    });
}

var mountPlaceholders = {};
if (parsedArgs.options.mounts) {
    parsedArgs.options.mounts.forEach(function (keyvalue) {
        var splt = keyvalue.split(":");
        mountPlaceholders[splt[0]] = splt[1];
    });
}

if (parsedArgs.options.namespace)
    config = config[parsedArgs.options.namespace] || {};

if (parsedArgs.options.debug)
    console.log(config);

var targetFile = "./dockerish.template.yml";
if (parsedArgs.options.target && FS.lstatSync(parsedArgs.options.target).isDirectory())
    targetFile = parsedArgs.options.target + "/dockerish.template.yml";
else if (parsedArgs.options.target)
    targetFile = parsedArgs.options.target;

var rawTarget = FS.readFileSync(targetFile);

if (parsedArgs.options.debug)
    console.log(rawTarget + "");

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
        if (ip.indexOf("192.") === 0 || ip.indexOf("10.") === 0 || (ip.indexOf("127.") === 0 && ip !== "127.0.0.1"))
            hostip = ip;
    });
    if (!hostip && ips.length > 0)
        hostip = ips[0];
    if (!hostip)
        hostip = "127.0.0.1";
    compiledTarget = compiledTarget.split("%{HOSTIP}").join(hostip);
}

if (parsedArgs.options.debug)
    console.log(compiledTarget);

var target = Yaml.safeLoad(compiledTarget);

if (parsedArgs.options.debug)
    console.log(target);

var dockerArgs = null;

var tempFiles = [];

if (parsedArgs.options.stop) {
    dockerArgs = target.run.restart ? ["rm", "-f"] : ["stop"];
    dockerArgs.push(target.container.image);
} else if (parsedArgs.options.run || parsedArgs.options.runc) {
    dockerArgs = ["run"];
    var targetrun = parsedArgs.options.runc ? target[parsedArgs.options.runc] : target.run;
    targetrun = targetrun || {};
    if (targetrun.daemon)
        dockerArgs.push("-d");
    if (targetrun.restart)
        dockerArgs.push("--restart=" + targetrun.restart);
    else
        dockerArgs.push("--rm");
    if (targetrun.portmaps) {
        targetrun.portmaps.forEach(function (portmap) {
            dockerArgs.push("-p");
            dockerArgs.push(portmap.host + ":" + portmap.container);
        });
    }
    if (targetrun.mounts) {
        targetrun.mounts.forEach(function (mount) {
            dockerArgs.push("-v");
            var mountHost = Path.resolve(mount.placeholder ? mountPlaceholders[mount.placeholder] : mount.host);
            dockerArgs.push(mountHost + ":" + mount.container + ":" + mount.permission);
            if (mount.permission.indexOf("w") >= 0 && !FS.existsSync(mountHost))
                FS.writeFileSync(mountHost, "");
        });
    }
    if (targetrun.privileged)
        dockerArgs.push("--privileged");
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
} else if (parsedArgs.options.build) {
    var targetDir = Path.dirname(targetFile) + (target.container.basedir ? "/" + target.container.basedir : "");
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
    ].concat(target.dockerfile.commands.split("\n"));
    var tempDockerfile = Tmp.tmpNameSync({
        template: targetDir + "/Dockerfile-tmp-XXXXXX"
    });
    tempFiles.push(tempDockerfile);
    FS.writeFileSync(tempDockerfile, dockerfileLines.join("\n"));
    dockerArgs = [
        "build",
        "-f",
        tempDockerfile,
        "-t",
        target.container.name,
        targetDir
    ];
}

if (dockerArgs) {
    dockerArgs = dockerArgs.concat(parsedArgs.argv);
    if (parsedArgs.options.debug)
        console.log("docker", dockerArgs.join(" "));
    var docker = ChildProcess.spawn("docker", dockerArgs);
    docker.on("close", function (status) {
        tempFiles.forEach(function (f) {
            FS.unlinkSync(f);
        });
        process.exit(status);
    });
    docker.stderr.pipe(process.stderr);
    docker.stdout.pipe(process.stdout);
    process.stdin.pipe(docker.stdin);
} else {
    tempFiles.forEach(function (f) {
        FS.unlinkSync(f);
    });
}