import sys
import json
import asyncio
from xsense import XSenseClient

async def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Benutzername und Passwort erforderlich"}))
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]
    region = sys.argv[3] if len(sys.argv) > 3 else "eu"

    try:
        async with XSenseClient(email=email, password=password, region=region) as client:
            creds = client.credentials
            print(json.dumps(creds))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    asyncio.run(main())
