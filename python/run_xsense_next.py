# -*- coding: utf-8 -*-
import sys
import json
import os
import subprocess
import pickle
import io
import struct

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
    try:
        # Daten von stdin lesen
        input_data = sys.stdin.buffer.read()
        buffer = io.BytesIO(input_data)
        xsense = pickle.load(buffer)

        xsense.load_all()

        for _, h in xsense.houses.items():
            for _, s in h.stations.items():
                xsense.get_state(s)

        # Ergebnis in stdout schreiben
        out_buffer = io.BytesIO()

        env_dump = dump_environment(xsense)

        env_bytes = json.dumps(env_dump).encode('utf-8')
        # Länge der JSON-Bytes als 4-Byte-Integer voranstellen
        # out_buffer.write(struct.pack("!I", len(env_bytes)))
        out_buffer.write(env_bytes)

        xsense.houses = {}  # Jetzt erst leeren!

        pickle_bytes = pickle.dumps(xsense)
        out_buffer.write(pickle_bytes)

        sys.stdout.buffer.write(out_buffer.getvalue())

    except Exception as e:
        error_buffer = io.BytesIO()
        error_message = str(e).encode('utf-8')
        error_buffer.write(error_message)
        sys.stdout.buffer.write(error_buffer.getvalue())
        sys.exit(1)

if __name__ == '__main__':
    main()
