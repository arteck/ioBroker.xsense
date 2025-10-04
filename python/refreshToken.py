# -*- coding: utf-8 -*-
import sys
import json
import os
import subprocess
import pickle
import io

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
    try:
        # Daten von stdin lesen
        input_data = sys.stdin.buffer.read()
        buffer = io.BytesIO(input_data)
        xsense = pickle.load(buffer)

        xsense.refresh()

        out_buffer = io.BytesIO()
        pickle.dump(xsense, out_buffer)
        sys.stdout.buffer.write(out_buffer.getvalue())

    except Exception as e:
        error_buffer = io.BytesIO()
        error_message = str(e).encode('utf-8')
        error_buffer.write(error_message)
        sys.stdout.buffer.write(error_buffer.getvalue())
        sys.exit(1)

if __name__ == '__main__':
    main()
