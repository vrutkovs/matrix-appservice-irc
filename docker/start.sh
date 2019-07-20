#!/bin/sh

if [ ! -z $PREFIX ]
then
  ip route add local $PREFIX dev lo
fi

exec node app.js -c $CONFIG_PATH -p $BRIDGE_PORT -f $APPSERVICE -u $APPSERVICE_URL
