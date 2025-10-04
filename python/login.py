# -*- coding: utf-8 -*-
import sys
import os
import io
import subprocess
import json
import pickle

MODULE_PATH = os.path.join(os.path.dirname(__file__), 'python-xsense')

# xsense importieren oder installieren, wenn nicht vorhanden
try:
    from xsense.xsense import XSense

except ImportError:
    try:
        print("XSense-Modul nicht gefunden. Installiere lokal mit pip...")
        subprocess.check_call([sys.executable, "-m", "pip", "install", "-e", MODULE_PATH])
        # Import erneut versuchen
        from xsense.xsense import XSense

    except Exception as e:
        print(json.dumps({"error": f"Installation fehlgeschlagen: {str(e)}"}))
        sys.exit(1)

def main():

    email = sys.argv[1]
    password = sys.argv[2]

    try:
        xsense = XSense()
        xsense.init()
        xsense.login(email, password)

        out_buffer = io.BytesIO()
        pickle.dump(xsense, out_buffer)
        sys.stdout.buffer.write(out_buffer.getvalue())

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
