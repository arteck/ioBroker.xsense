import argparse
import contextlib
import json

from xsense.base import XSenseBase


def get_credentials():
    parser = argparse.ArgumentParser()
    parser.add_argument('--username', help='Username')
    parser.add_argument('--password', help='Password')
    args = parser.parse_args()

    if args.username and args.password:
        return args.username, args.password

    with contextlib.suppress(FileNotFoundError):
        with open('.env', 'r') as file:
            for line in file:
                with contextlib.suppress(ValueError):
                    key, value = line.strip().split('=')
                    if key.lower() == 'username':
                        username = value
                    elif key.lower() == 'password':
                        password = value

    if username and password:
        return username, password

    raise ValueError('Username and password not provided')


def dump_environment(env: XSenseBase):
    for h_id, h in env.houses.items():
        print(f'----[ {h.name} ({h_id}) ]-----------------')
        for s_id, s in h.stations.items():
            dump_device(s)
            print(f'# {s.name} ({s_id})')
            for d_id, d in s.devices.items():
                dump_device(d)
                
def environment_to_dict(env: XSenseBase):
    result = {}
    for h_id, h in env.houses.items():
        house = {
            'name': h.name,
            'id': h_id,
            'stations': {}
        }
        for s_id, s in h.stations.items():
            station = {
                'name': s.name,
                'id': s_id,
                'serial': s.sn,
                'type': s.type,
                'online': s.online,
                'values': s.data,
                'devices': {}
            }
            for d_id, d in s.devices.items():
                device = {
                    'name': d.name,
                    'id': d_id,
                    'serial': d.sn,
                    'type': d.type,
                    'online': d.online,
                    'values': d.data
                }
                station['devices'][d_id] = device
            house['stations'][s_id] = station
        result[h_id] = house
    return result

def dump_environment_json(env: XSenseBase):
    env_dict = environment_to_dict(env)
    print(json.dumps(env_dict, indent=2, ensure_ascii=False))

def dump_device(d):
    print(f'{d.name} ({d.type}):')
    print(f'  serial  : {d.sn}')
    print(f'  online  : {"yes" if d.online else "no"}')
    print(f'  values  : {d.data}')
