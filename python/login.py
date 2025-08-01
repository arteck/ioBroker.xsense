# login_async.py
import asyncio
import json
import sys
from xsense import AsyncXSense

async def main():
    username = sys.argv[1]
    password = sys.argv[2]

    api = AsyncXSense()
    await api.init()
    await api.login(username, password)

    session_data = {
        "token": api.token,
        "user_id": api.user_id,
        "user_email": api.user_email
    }

    print(json.dumps(session_data))  # Ausgabe als JSON-String

asyncio.run(main())
