const GetOpt = require("node-getopt");
const FS = require("fs");
const Path = require('path');
const Template = require('lodash.template');
const Tmp = require('tmp');
const Yaml = require("js-yaml");
const ChildProcess = require("child_process");

var parsedArgs = GetOpt.create([
    ["h", "help", "shows help"],
    ["c", "config=FILE", "dockerish config file, defaults to ./dockerish.config.json"],
    ["n", "namespace=NAMESPACE", "config sub name space (optional)"],
    ["t", "target=FILE", "dockerish template file or folder containing the template file, defaults to ./dockerish.template.yml"],
    ["r", "run", "runs the container (add additional parameters after --)"],
    ["s", "stop", "stops the container"],
    ["b", "build", "builds the container"],
    ["d", "debug", "debug"]
]).bindHelp().parseSystem();


var config = {};
if (parsedArgs.options.config)
    config = JSON.parse(FS.readFileSync(parsedArgs.options.config));
else if (FS.existsSync("./dockerish.config.json"))
    config = JSON.parse(FS.readFileSync("./dockerish.config.json"));

if (parsedArgs.options.namespace)
    config = config["namespace"] || {};

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

if (parsedArgs.options.debug)
    console.log(compiledTarget);

var target = Yaml.safeLoad(compiledTarget);

if (parsedArgs.options.debug)
    console.log(target);

var dockerArgs = null;

if (parsedArgs.options.stop) {
    dockerArgs = target.run.restart ? ["rm", "-f"] : ["stop"];
    dockerArgs.push(target.container.image);
} else if (parsedArgs.options.run) {
    dockerArgs = ["run"];
    if (target.run.daemon)
        dockerArgs.push("-d");
    if (target.run.restart)
        dockerArgs.push("--restart=" + target.run.restart);
    else
        dockerArgs.push("--rm");
    if (target.run.portmaps) {
        target.run.portmaps.forEach(function (portmap) {
            dockerArgs.push("-p");
            dockerArgs.push(portmap.host + ":" + portmap.container);
        });
    }
    dockerArgs.push("--name");
    dockerArgs.push(target.container.image);
    dockerArgs.push("-t");
    dockerArgs.push(target.container.name);
} else if (parsedArgs.options.build) {
    var targetDir = Path.dirname(targetFile) + (target.container.basedir ? "/" + target.container.basedir : "");
    var dockerfileLines = [
        "FROM " + target.dockerfile.from,
        "MAINTAINER " + target.dockerfile.maintainer
    ].concat(target.dockerfile.commands.split("\n"));
    var tempDockerfile = Tmp.tmpNameSync({
        template: targetDir + "/Dockerfile-tmp-XXXXXX"
    });
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
        process.exit(status);
    });
    docker.stderr.pipe(process.stderr);
    docker.stdout.pipe(process.stdout);
}
