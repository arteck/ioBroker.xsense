# -*- coding: utf-8 -*-
import sys
import json
import os
import subprocess

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

def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Benutzername und Passwort erforderlich"}))
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]

    try:
        xsense = XSense()
        xsense.init()
        xsense.login(email, password)
        xsense.load_all()

#        for _, h in xsense.houses.items():
#            for _, s in h.stations.items():
#                xsense.get_state(s)

        dump_environment(xsense)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
