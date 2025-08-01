# fetch_async_robust.py
import asyncio
import json
import sys
from xsense import AsyncXSense
from xsense.utils import dump_environment

MAX_RETRIES = 3
RETRY_DELAY = 5  # Sekunden

async def fetch_data(api):
    for _, house in api.houses.items():
        for _, station in house.stations.items():
            for attempt in range(MAX_RETRIES):
                try:
                    await api.get_state(station)
                    break
                except Exception as e:
                    print(f"[WARN] Fehler bei get_state: {e}", file=sys.stderr)
                    if attempt < MAX_RETRIES - 1:
                        await asyncio.sleep(RETRY_DELAY)
                    else:
                        print("[ERROR] Max. Versuche bei Abholung der Daten erreicht", file=sys.stderr)

async def main():
    if len(sys.argv) < 2:
        print("[ERROR] Session-Daten fehlen als Argument", file=sys.stderr)
        sys.exit(1)

    try:
        session_data = json.loads(sys.argv[1])
    except Exception as e:
        print(f"[ERROR] Ungültiges JSON-Argument: {e}", file=sys.stderr)
        sys.exit(2)

    api = AsyncXSense()
    await api.init()

    api.token = session_data.get("token")
    api.user_id = session_data.get("user_id")
    api.user_email = session_data.get("user_email")

    for attempt in range(MAX_RETRIES):
        try:
            await api.load_all()
            break
        except Exception as e:
            print(f"[WARN] Fehler bei load_all: {e}", file=sys.stderr)
            if attempt < MAX_RETRIES - 1:
                await asyncio.sleep(RETRY_DELAY)
            else:
                print("[ERROR] Max. Versuche bei laden der Daten erreicht", file=sys.stderr)
                sys.exit(3)

    await fetch_data(api)
    dump_environment(api)

asyncio.run(main())
