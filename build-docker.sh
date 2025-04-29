#!/bin/bash

# reproducible build of the docker image used for enclave image

NAME=nwc-enclaved
SOURCE_DATE_EPOCH=`cat timestamp.txt` 
echo "Commit timestamp" $SOURCE_DATE_EPOCH

mkdir -p build

docker \
    run \
    -it \
    --rm \
    --privileged \
    -v .:/tmp/work \
    -w /tmp/work \
    --entrypoint buildctl-daemonless.sh \
    moby/buildkit:v0.20.1 \
    build \
    --no-cache \
    --frontend dockerfile.v0 \
    --opt platform=linux/amd64 \
    --opt build-arg:SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} \
    --local dockerfile=. \
    --local context=. \
    --metadata-file=build/docker.json \
    --output type=docker,name=${NAME},dest=build/${NAME}.tar,buildinfo=false,rewrite-timestamp=true \
    --progress=plain \
  

