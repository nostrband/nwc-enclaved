#!/bin/sh
runuser -u phoenix -- /home/phoenix/phoenixd --verbose --agree-to-terms-of-service --log-rotate-size=1 --log-rotate-max-files=5 --http-bind-ip=0.0.0.0 --http-bind-port=9740