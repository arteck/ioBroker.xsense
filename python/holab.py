# -*- coding: utf-8 -*-

import json
import sys
import time
import datetime

from xsense.xsense import XSense
from xsense.utils import dump_environment

MAX_RETRIES = 3
RETRY_DELAY = 5  # Sekunden

def fetch_data(api):
    for _, house in api.houses.items():
        for _, station in house.stations.items():
            for attempt in range(MAX_RETRIES):
                try:
                    api.get_state(station)
                    break
                except Exception as e:
                    print(f"[WARN] Fehler bei get_state: {e}", file=sys.stderr)
                    if attempt < MAX_RETRIES - 1:
                        time.sleep(RETRY_DELAY)
                    else:
                        print("[ERROR] Max. Versuche bei Abholung der Daten erreicht", file=sys.stderr)

def apply_session(api, session):
    def to_bytes(value):
        return value.encode("utf-8") if isinstance(value, str) else value

    api.userid = session.get("userid")
    api.clientid = session.get("clientid")
    api.clientsecret = to_bytes(session.get("clientsecret"))
    api.region = session.get("region")
    api.userpool = session.get("userpool")
    api.username = session.get("username")

    api.access_token = session.get("access_token")
    api.id_token = session.get("id_token")

    api.refresh_token = session.get("refresh_token")

    api.aws_access_expiry = datetime.datetime.fromisoformat(session.get("aws_access_expiry"))
    api.aws_access_key = session.get("aws_access_key")
    api.aws_session_token = session.get("aws_session_token")
    api.access_token_expiry = datetime.datetime.fromisoformat(session.get("access_token_expiry"))


def main():
    session_data = json.loads(sys.argv[1])

    api = XSense()
    api.init()

    apply_session(api, session_data)

    for attempt in range(MAX_RETRIES):
        try:
            api.load_all()
            break
        except Exception as e:
            print(f"[WARN] Fehler bei load_all: {e}", file=sys.stderr)
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
            else:
                print("[ERROR] Max. Versuche bei laden der Daten erreicht", file=sys.stderr)
                sys.exit(3)

    fetch_data(api)
    dump_environment(api)

if __name__ == '__main__':
    main()
