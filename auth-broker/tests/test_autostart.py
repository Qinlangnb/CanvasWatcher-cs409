import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from academic_watcher_auth_broker import install_launcher


class AutostartTests(unittest.TestCase):
    def test_task_runs_the_fixed_launcher_for_this_user_only(self):
        with tempfile.TemporaryDirectory() as folder:
            pythonw = Path(folder) / 'pythonw.exe'
            pythonw.write_text('', encoding='ascii')
            xml = install_launcher.task_xml(str(pythonw), 'EXAMPLE\student&<x>')
        self.assertIn('<LogonType>InteractiveToken</LogonType>', xml)
        self.assertIn('<RunLevel>LeastPrivilege</RunLevel>', xml)
        self.assertIn('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', xml)
        self.assertIn('-m academic_watcher_auth_broker.launch academicwatcher://start', xml)
        self.assertIn('EXAMPLE\student&amp;&lt;x&gt;', xml)
        self.assertIn(install_launcher.OWNER, xml)

    def test_foreign_task_is_never_removed(self):
        with mock.patch.object(install_launcher, 'task_owner', return_value='foreign'):
            with self.assertRaises(RuntimeError):
                install_launcher.remove_autostart()
        with mock.patch.object(install_launcher, 'task_owner', return_value=None):
            self.assertFalse(install_launcher.remove_autostart())

    def test_autostart_is_opt_in(self):
        with mock.patch.object(install_launcher, 'install') as install, \
                mock.patch.object(install_launcher, 'autostart') as autostart, \
                mock.patch('sys.argv', ['install_launcher', 'install']):
            install_launcher.main()
        install.assert_called_once()
        autostart.assert_not_called()
        with mock.patch.object(install_launcher, 'install'), \
                mock.patch.object(install_launcher, 'autostart') as autostart, \
                mock.patch('sys.argv', ['install_launcher', 'install', '--autostart']):
            install_launcher.main()
        autostart.assert_called_once()


if __name__ == '__main__':
    unittest.main()
