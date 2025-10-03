import sys
import os
import subprocess

class XSenseScriptTester:
    def __init__(self, base_dir, python_exe=None):
        self.base_dir = base_dir
        self.python_exe = python_exe or sys.executable
        self.run_xsense = os.path.join(self.base_dir, 'run_xsense.py')
        self.run_xsense_next = os.path.join(self.base_dir, 'run_xsense_next.py')

    def test_run_xsense(self, email, password):
        result = subprocess.run(
            [self.python_exe, self.run_xsense, email, password],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        return result

    def test_run_xsense_next(self, input_data):
        result = subprocess.run(
            [self.python_exe, self.run_xsense_next],
            input=input_data,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        return result

if __name__ == '__main__':
    tester = XSenseScriptTester(os.path.dirname(__file__))

    # Test für run_xsense.py
    email = sys.argv[1] if len(sys.argv) > 1 else 'test@example.com'
    password = sys.argv[2] if len(sys.argv) > 2 else 'test123'
    result1 = tester.test_run_xsense(email, password)
    print('run_xsense.py Rückgabecode:', result1.returncode)
    print('run_xsense.py stdout:', result1.stdout)
    print('run_xsense.py stderr:', result1.stderr)

    # Test für run_xsense_next.py
    dummy_pickle = b'\x80\x04}'  # leeres dict als Pickle
    result2 = tester.test_run_xsense_next(dummy_pickle)
    print('run_xsense_next.py Rückgabecode:', result2.returncode)
    print('run_xsense_next.py stdout:', result2.stdout)
    print('run_xsense_next.py stderr:', result2.stderr)
