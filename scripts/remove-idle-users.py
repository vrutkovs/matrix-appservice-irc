#!/usr/bin/env python
from __future__ import print_function
import argparse
from datetime import datetime
import sys
import json
import urllib
import requests
import time

def get_room_id(homeserver, alias, token):
    res = requests.get(homeserver + "/_matrix/client/r0/directory/room/" + urllib.quote(alias) + "?access_token=" + token)
    res.raise_for_status()
    return res.json()["room_id"]

def get_last_active_ago(homeserver, user_id, token):
    res = requests.get(homeserver + "/_matrix/client/r0/presence/" + urllib.quote(user_id) + "/status?access_token=" + token).json()
    return res.get("last_active_ago", None)

def is_idle(homeserver, user_id, token, activity_threshold_ms):
    return get_last_active_ago(homeserver, user_id, token) > activity_threshold_ms

def should_ignore_user(test_user_id, user_prefix, bot_user_id):
    return test_user_id.startswith(user_prefix) or test_user_id == bot_user_id

def get_idle_users(homeserver, room_id, token, since, user_prefix, bot_user_id):
    res = requests.get(homeserver + "/_matrix/client/r0/rooms/" + urllib.quote(room_id) + "/joined_members?access_token=" + token)
    user_ids = [user_id for user_id in res.json().get("joined", None)]

    activity_threshold_ms = since * 24 * 60 * 60 * 1000
    total_joined = len(user_ids)
    
    # Do not kick users that start with the user_prefix or are the bot. Do this check now before
    # we try to GET /presence for all of them.
    user_ids = [u for u in user_ids if not should_ignore_user(u, user_prefix, bot_user_id)]
    print("%s :   %s/%s users may be kicked if they are idle" % (str(datetime.now()), len(user_ids), total_joined))

    return [user_id for user_id in user_ids if is_idle(homeserver, user_id, token, activity_threshold_ms)]

def kick_idlers(homeserver, room_id, token, since, user_prefix, bot_user_id):
    print("%s : Processing %s" % (str(datetime.now()), room_id))
    reason = "Being idle for >%s days" % since

    user_ids = get_idle_users(homeserver, room_id, token, since, user_prefix, bot_user_id)
    failure_responses = []
    count = 0
    print("%s :   %s idle users in %s" % (str(datetime.now()), len(user_ids), room_id))
    for user_id in user_ids:
        res = requests.put(
            homeserver + "/_matrix/client/r0/rooms/" +
            urllib.quote(room_id) + "/state/m.room.member/" +
            urllib.quote(user_id) + "?access_token=" + token,
            data = json.dumps({
                "reason": reason,
                "membership": "leave"
            })
        )
        if res.status_code >= 400:
            failure = { "user_id" : user_id }
            try:
                failure["response_json"] = res.json()
            except Exception as e:
                print("Could not get JSON body from failure response: %s" % e)
            failure_responses.append(failure)
        else:
            count += 1
    if count > 0:
        print("%s :   %s/%s kicked users in total (%s failed requests)" % (str(datetime.now()), count, count + len(failure_responses), len(failure_responses)))

    if len(failure_responses) == 0:
        return
    print("Could not kick the following users:")
    for failure in failure_responses:
        print("%s - %s" % (failure["user_id"], failure["response_json"]))

def main(token, alias, homeserver, since, user_prefix, user_id, room_id=None):
    if room_id is None:
        print("Removing idle users in %s" % alias)
        room_id = get_room_id(homeserver, alias, token)

    if not room_id:
        raise Exception("Cannot resolve room alias to room_id")

    kick_idlers(homeserver, room_id, token, since, user_prefix, user_id)

if __name__ == "__main__":
    parser = argparse.ArgumentParser("Remove idle users from a given Matrix room")
    parser.add_argument("-t", "--token", help="The access token", required=True)
    parser.add_argument("-a", "--alias", help="The alias of the room eg '#freenode_#matrix-dev:matrix.org'", required=False)
    parser.add_argument("-r", "--room", help="Optional. The room ID instead of the alias eg '!curBafw45738:matrix.org'", required=False)
    parser.add_argument("-H", "--homeserver", help="Base homeserver URL eg 'https://matrix.org'", required=True)
    parser.add_argument("-s", "--since", type=int, help="Days since idle users have been offline for eg '30'", required=True)
    parser.add_argument("-p", "--prefix", help="User prefix to determine whether a user should be kicked. E.g. @freenode_", required=True)
    parser.add_argument("-u", "--user", help="The user ID of the AS bot. E.g '@appservice-irc:matrix.org'", required=True)
    args = parser.parse_args()
    if not args.token or not args.homeserver or not args.user or (not args.alias and not args.room):
        parser.print_help()
        sys.exit(1)
    if args.user[0] != "@":
        parser.print_help()
        print("--user must start with '@'")
        sys.exit(1)
    main(token=args.token, alias=args.alias, homeserver=args.homeserver, since=args.since, user_prefix=args.prefix, room_id=args.room, user_id=args.user)
