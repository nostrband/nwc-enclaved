#!/bin/sh

PHOENIX_PASSWORD=`grep "http-password=" /home/phoenix/.phoenix/phoenix.conf | awk 'BEGIN{FS="="}{print $2}'`
# echo "phoenix password: $PHOENIX_PASSWORD"

cd /app/

node_modules/.bin/tsx src/index.ts $PHOENIX_PASSWORD