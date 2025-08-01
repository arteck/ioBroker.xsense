# -*- coding: utf-8 -*-
import sys
import json
import os
import subprocess
import json
import datetime
import uuid

MODULE_PATH = os.path.join(os.path.dirname(__file__), 'python-xsense')

# xsense importieren oder installieren, wenn nicht vorhanden
try:
    from xsense.xsense import XSense
    from xsense.utils import dump_environment
except ImportError:
    try:
        print("XSense-Modul nicht gefunden. Installiere lokal mit pip...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-e", MODULE_PATH])
        # Import erneut versuchen
        from xsense.xsense import XSense
        from xsense.utils import dump_environment
    except Exception as e:
        print(json.dumps({"error": f"Installation fehlgeschlagen: {str(e)}"}))
        sys.exit(1)

def serialize_object(obj):
    """
    Wandelt ein beliebiges Objekt rekursiv in JSON-kompatibles dict um.
    """
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj

    elif isinstance(obj, (datetime.datetime, datetime.date, datetime.time)):
        return obj.isoformat()

    elif isinstance(obj, uuid.UUID):
        return str(obj)

    elif isinstance(obj, (list, tuple, set)):
        return [serialize_object(item) for item in obj]

    elif isinstance(obj, dict):
        return {str(k): serialize_object(v) for k, v in obj.items()}

    elif hasattr(obj, "__dict__"):
        return {str(k): serialize_object(v) for k, v in vars(obj).items() if not k.startswith('_')}

    else:
        return str(obj)  # Fallback (z. B. Signer-Objekt)

def serialize_xsense(xsense):
    return json.dumps(serialize_object(xsense), indent=2)

def main():
    email = sys.argv[1]
    password = sys.argv[2]

    try:
        xsense = XSense()
        xsense.init()
        xsense.login(email, password)

        print(serialize_xsense(xsense))
    except Exception as e:
        print(json.dumps({"Error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
