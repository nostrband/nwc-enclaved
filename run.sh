#!/bin/sh

# stop on errors
set -e

# some info for debugging
cd /app
pwd
free
df
ls -la
ls -la data/
ls -la /

chown -R phoenix:phoenix /home/phoenix
ls -la /home/phoenix/.phoenix

# Run supervisor first, no programs should be running yet
cat supervisord.conf
./supervisord -c supervisord.conf &
SUPERVISOR_PID=$!
sleep 1
echo "status"
./supervisord ctl -c supervisord.conf status

# start phoenix
./supervisord ctl -c supervisord.conf start phoenix

# let phoenix start and generate keys etc
sleep 2

# nwc
./supervisord ctl -c supervisord.conf start nwc

wait $SUPERVISOR_PID




