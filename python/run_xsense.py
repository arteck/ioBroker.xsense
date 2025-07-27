# -*- coding: utf-8 -*-
import sys
import json
from xsense.xsense import XSense  # synchroner Client
from xsense.utils import dump_environment

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Benutzername und Passwort erforderlich"}))
        sys.exit(1)

    email = sys.argv[1]
    password = sys.argv[2]
    
    try:
        xsense = XSense()
        xsense.init()
        xsense.login(email, password)
        xsense.load_all()
        
        for _, h in xsense.houses.items():
          for _, s in h.stations.items():
            xsense.get_state(s)
            
        dump_environment(xsense)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
