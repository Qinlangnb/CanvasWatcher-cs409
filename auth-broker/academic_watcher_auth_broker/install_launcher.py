"""One-time HKCU protocol registration and optional per-user autostart. No admin rights or browser policy changes."""
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

from .launch import (
    RemoteSupervisor,
    Supervisor,
    runtime_root,
    safe_directory,
    safe_file,
    singleton,
)

REGISTRY = r'Software\Classes\academicwatcher'
OWNER = 'AcademicWatcherBrokerLauncher-v1'
TASK = 'Academic Watcher Broker'
TASK_INTERVAL = 'PT5M'


def command_for(pythonw):
    executable = safe_file(pythonw)
    return f'"{executable}" -m academic_watcher_auth_broker.launch "%1"'


def existing_handler(registry):
    try:
        with registry.OpenKey(registry.HKEY_CURRENT_USER, REGISTRY) as key:
            owner = registry.QueryValueEx(key, 'AcademicWatcherOwner')[0]
        with registry.OpenKey(registry.HKEY_CURRENT_USER, REGISTRY + r'\shell\open\command') as key:
            command = registry.QueryValueEx(key, '')[0]
        return owner, command
    except FileNotFoundError:
        # Distinguish no handler from an unowned pre-existing protocol key.
        try:
            with registry.OpenKey(registry.HKEY_CURRENT_USER, REGISTRY):
                return 'UNOWNED', ''
        except FileNotFoundError:
            return None


def install(tunnel=None, *, backend='http://127.0.0.1:8000',
            origins=('http://localhost:8080', 'http://127.0.0.1:8080'), remote=None, registry=None):
    if registry is None:
        import winreg as registry
    root = runtime_root()
    safe_directory(root)
    python = safe_file(sys.executable)
    pythonw = safe_file(str(Path(python).with_name('pythonw.exe')))
    if remote is not None:
        installed = {'python': python, 'backend': remote[0], 'origin': remote[1]}
        RemoteSupervisor(installed)  # Validate remote endpoints.
    elif tunnel:
        script = safe_file(tunnel)
        safe_file(str(Path(script).with_name('migration.py')))
        installed = {'python': python, 'tunnel': script}
    else:
        installed = {'python': python, 'backend': backend, 'origins': list(origins)}
    if remote is None:
        Supervisor(installed)  # Validate before registry/config writes.
    command = command_for(pythonw)
    previous = existing_handler(registry)
    if previous is not None and previous != (OWNER, command):
        raise RuntimeError('Existing URI handler not owned by this installation; not overwritten')
    # Never change live supervisor config behind its back.
    with singleton(root) as acquired:
        if not acquired:
            raise RuntimeError('Stop existing managed launcher before installation')
        config = root / 'config.json'
        if config.is_symlink():
            raise ValueError('Unsafe config path')
        if config.exists():
            backup = root / ('config.before-' + str(time.time_ns()) + '.json')
            backup.write_bytes(config.read_bytes())
        temporary = root / ('config-' + str(time.time_ns()) + '.new')
        temporary.write_text(json.dumps(installed), encoding='utf-8')
        temporary.replace(config)
        (root / 'stop.request').unlink(missing_ok=True)
        for suffix, values in (
            ('', {'': 'URL:Academic Watcher Broker', 'URL Protocol': '', 'AcademicWatcherOwner': OWNER}),
            (r'\shell\open\command', {'': command}),
        ):
            with registry.CreateKeyEx(registry.HKEY_CURRENT_USER, REGISTRY + suffix, 0, registry.KEY_WRITE) as key:
                for name, value in values.items():
                    registry.SetValueEx(key, name, 0, registry.REG_SZ, value)
    print('Current-user Start Broker handler installed. Browser confirmation remains enabled.')


def task_user():
    domain, user = os.environ.get('USERDOMAIN', ''), os.environ['USERNAME']
    return f'{domain}\\{user}' if domain else user


def task_xml(pythonw, user):
    """This user only: start the fixed launcher at sign-in, then every 5 minutes if it is not running.

    The launcher's own lock makes extra starts exit at once, and IgnoreNew keeps
    Task Scheduler from stacking instances while one is running.
    """
    executable = escape(safe_file(pythonw))
    user = escape(user)
    return f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{OWNER}: keeps the local Academic Watcher broker launcher running for this user.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>{TASK_INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <UserId>{user}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{executable}</Command>
      <Arguments>-m academic_watcher_auth_broker.launch academicwatcher://start</Arguments>
    </Exec>
  </Actions>
</Task>
'''


def schtasks(*args, check=True):
    executable = Path(os.environ['SystemRoot']) / 'System32' / 'schtasks.exe'
    result = subprocess.run([str(executable), *args], capture_output=True, timeout=30)
    if check and result.returncode:
        raise RuntimeError('Task Scheduler refused the request')
    return result


def task_owner():
    """None when there is no task, 'owned' for ours, 'foreign' for a task of the same name we did not create."""
    result = schtasks('/Query', '/TN', TASK, '/XML', check=False)
    if result.returncode:
        return None
    raw = result.stdout
    text = raw.decode('utf-16') if raw[:2] in (b'\xff\xfe', b'\xfe\xff') or b'\x00' in raw[:64] else raw.decode('utf-8', 'replace')
    return 'owned' if OWNER in text else 'foreign'


def autostart():
    """Opt-in: a per-user scheduled task (no admin rights) that keeps the launcher running."""
    root = runtime_root()
    safe_directory(root)
    if not (root / 'config.json').is_file():
        raise RuntimeError('Run install before autostart')
    if task_owner() == 'foreign':
        raise RuntimeError('Scheduled task not owned by this installation; not overwritten')
    pythonw = str(Path(sys.executable).with_name('pythonw.exe'))
    definition = root / ('task-' + str(time.time_ns()) + '.xml')
    definition.write_text(task_xml(pythonw, task_user()), encoding='utf-16')
    try:
        schtasks('/Create', '/TN', TASK, '/XML', str(definition), '/F')
    finally:
        definition.unlink(missing_ok=True)
    schtasks('/Run', '/TN', TASK)  # Start now as well, not only at the next sign-in.
    print('Broker launcher starts at sign-in and is restarted within 5 minutes if it exits.')


def remove_autostart():
    owner = task_owner()
    if owner is None:
        return False
    if owner != 'owned':
        raise RuntimeError('Scheduled task not owned by this installation; not removed')
    schtasks('/Delete', '/TN', TASK, '/F')
    return True


def stop():
    root = runtime_root()
    safe_directory(root)
    with singleton(root) as acquired:
        if acquired:
            (root / 'stop.request').unlink(missing_ok=True)
            return
    (root / 'stop.request').write_text('stop', encoding='ascii')
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        with singleton(root) as acquired:
            if acquired:
                (root / 'stop.request').unlink(missing_ok=True)
                return
        time.sleep(1)
    raise RuntimeError('Managed launcher did not stop; no unrelated process was terminated')


def uninstall():
    import winreg as registry
    command = command_for(str(Path(sys.executable).with_name('pythonw.exe')))
    if existing_handler(registry) != (OWNER, command):
        raise RuntimeError('Handler ownership mismatch; nothing removed')
    remove_autostart()  # Otherwise the task would start the launcher again.
    stop()
    for suffix in (r'\shell\open\command', r'\shell\open', r'\shell', ''):
        registry.DeleteKey(registry.HKEY_CURRENT_USER, REGISTRY + suffix)
    print('Owned URI handler removed; browser profiles and credentials retained.')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('install', 'autostart', 'remove-autostart', 'stop', 'uninstall'))
    parser.add_argument('--tunnel', help='Operator-supplied pinned SSH tunnel script')
    parser.add_argument('--backend', help='Hosted site: API base URL, e.g. https://watcher.example.com/cs409')
    parser.add_argument('--origin', help='Hosted site: frontend origin, e.g. https://watcher.example.com')
    parser.add_argument('--origins', help='Local mode: comma-separated exact frontend origins')
    parser.add_argument('--autostart', action='store_true',
                        help='Also start the launcher at Windows sign-in for this user (opt-in)')
    args = parser.parse_args()
    try:
        if args.action == 'install':
            if args.origin and not args.backend or args.tunnel and (args.backend or args.origin):
                parser.error('use local defaults, --tunnel, or --backend with --origin')
            if args.origin:
                install(remote=(args.backend, args.origin))
            else:
                install(args.tunnel, backend=args.backend or 'http://127.0.0.1:8000', origins=args.origins.split(',') if args.origins else ('http://localhost:8080', 'http://127.0.0.1:8080'))
            if args.autostart:
                autostart()
        elif args.action == 'autostart':
            autostart()
        elif args.action == 'remove-autostart':
            print('Autostart removed.' if remove_autostart() else 'No autostart task was installed.')
        elif args.action == 'stop':
            # With autostart on, the task starts the launcher again within 5 minutes.
            stop()
        else:
            uninstall()
    except Exception as error:
        print(f'Launcher operation failed: {type(error).__name__}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
