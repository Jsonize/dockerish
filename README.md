# dockerish

Dockerish is an easy way to build, run and stop containers with a local config file based on a template.


## Installation


```bash
	npm install dockerish -g
```


## Creating a Dockerish Target

In your repository, create a file called `dockerish.template.yml`:
```yaml
container:
  name: container/name
  image: container-image

run:
  daemon: true
  restart: always
  portmaps:
    - host: <%= port %>
      container: 9000

dockerfile:
  from: node
  maintainer: you you@you.com
  commands: !
    WORKDIR ...

    ADD ...

    RUN ...

    ENTRYPOINT ... http://<%= hostname %> ...

    EXPOSE 9000
```


## Creating a Dockerish Config

Create a file called `dockerish.config.json` (e.g. in the same directory):
```json
{
  "hostname": "%hostname:8080",
  "port": 9000
}
```

## Run Dockerish

- Build: `dockerish --build`
- Run: `dockerish --run`
- Stop: `dockerish --stop`


## Options
```
  -h, --help                 shows help
  -c, --config=FILE          dockerish config file, defaults to ./dockerish.config.json
  -n, --namespace=NAMESPACE  config sub name space (optional)
  -t, --target=FILE          dockerish template file or folder containing the template file, defaults to ./dockerish.template.yml
  -r, --run                  runs the container (add additional parameters after --)
  -s, --stop                 stops the container
  -b, --build                builds the container
  -d, --debug                debug
```



## License

Apache-2.0

