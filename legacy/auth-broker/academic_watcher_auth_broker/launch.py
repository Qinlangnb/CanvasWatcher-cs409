"""Fixed start-only URI activation; supervise only owned broker/tunnel children."""
import errno
import importlib.util
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from .config import backend_base, frontend_origin, loopback_origin
from .windows_process import OwnedChild

START_URIS = frozenset(('academicwatcher://start', 'academicwatcher://start/'))


class PortOccupied(RuntimeError):
    """A required local port is in use by an application this launcher does not own."""

    state = 'PORT_OCCUPIED'

    def __init__(self, ports):
        self.ports = tuple(ports)
        super().__init__(self.state)


class PortReserved(PortOccupied):
    """Windows keeps the port in an excluded range (Hyper-V, WSL, Docker); nothing listens on it."""

    state = 'PORT_RESERVED'


def validate_activation(args):
    if len(args) != 1 or args[0] not in START_URIS:
        raise ValueError('Only fixed Start Broker activation is allowed')


def runtime_root():
    return Path(os.environ['LOCALAPPDATA']) / 'AcademicWatcher' / 'BrokerLauncher'


def safe_directory(root):
    root.mkdir(parents=True, exist_ok=True)
    if any(p.is_symlink() or p.is_junction() for p in (root, *root.parents)):
        raise ValueError('Unsafe launcher directory')


def safe_file(value):
    path = Path(value)
    if not path.is_absolute() or not path.is_file() or any(c in str(path) for c in ('"', '%', '\r', '\n')):
        raise ValueError('Invalid installed launcher path')
    if any(p.is_symlink() or p.is_junction() for p in (path, *path.parents)):
        raise ValueError('Unsafe installed launcher path')
    return str(path)


@contextmanager
def singleton(root):
    import msvcrt
    safe_directory(root)
    path = root / 'supervisor.lock'
    if path.is_symlink():
        raise ValueError('Unsafe lock path')
    with path.open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0'); lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            yield False
            return
        try:
            yield True
        finally:
            lock.seek(0); msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def lan_origin(value):
    p = urlsplit(value)
    address = ipaddress.IPv4Address(p.hostname or '')
    if (p.scheme != 'https' or p.port != 8080 or p.path or p.query or p.fragment or p.username or p.password
            or value != f'https://{address}:8080'
            or not any(address in ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))):
        raise ValueError('Invalid pinned LAN origin')
    return value


def origin_from_metadata(data):
    # The remote host metadata supplies both fields. Use IP as the authority and
    # reject an inconsistent optional convenience origin instead of trusting it.
    address = ipaddress.IPv4Address(data['ip'])
    origin = lan_origin(f'https://{address}:8080')
    if 'origin' in data and data['origin'] != origin:
        raise ValueError('Inconsistent LAN metadata')
    return origin


WSAEACCES = 10013


def port_state(port):
    """'free', 'in_use', or 'reserved' when Windows refuses the bind and nothing listens there."""
    with socket.socket() as probe:
        try:
            probe.bind(('127.0.0.1', port))
            return 'free'
        except OSError as error:
            if getattr(error, 'winerror', None) != WSAEACCES and error.errno != errno.EACCES:
                return 'in_use'
    # An application holding the port with SO_EXCLUSIVEADDRUSE also yields
    # WSAEACCES, but it accepts connections; an excluded range does not.
    with socket.socket() as probe:
        probe.settimeout(.5)
        return 'in_use' if probe.connect_ex(('127.0.0.1', port)) == 0 else 'reserved'


def port_free(port):
    return port_state(port) == 'free'


def require_ports(*ports):
    states = {port: port_state(port) for port in ports}
    reserved = [port for port in ports if states[port] == 'reserved']
    if reserved:
        raise PortReserved(reserved)
    busy = [port for port in ports if states[port] == 'in_use']
    if busy:
        raise PortOccupied(busy)


def backend_ready(origin='http://127.0.0.1:8000'):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(origin + '/api/health', timeout=2) as response:
            return response.status == 200 and json.loads(response.read(8192)).get('status') == 'ok'
    except Exception:
        return False


class Supervisor:
    def __init__(self, config, *, child=OwnedChild, discover=None, ready=None):
        self.local = set(config) == {'python', 'backend', 'origins'}
        if not self.local and set(config) != {'python', 'tunnel'}:
            raise ValueError('Invalid launcher config schema')
        self.python = safe_file(config['python'])
        if self.local:
            self.backend = loopback_origin(config['backend'])
            if urlsplit(self.backend).port == 8765:
                raise ValueError('Backend and Broker ports must differ')
            if not isinstance(config['origins'], list) or not config['origins']:
                raise ValueError('Explicit frontend origins required')
            self.origin = ','.join(frontend_origin(value) for value in config['origins'])
            self.tunnel_script = None
        else:
            self.backend = 'http://127.0.0.1:8000'
            self.tunnel_script = safe_file(config['tunnel'])
            self.origin = None
        self.child = child
        self.discover = discover or self.discover_origin
        self.ready = ready or (lambda: backend_ready(self.backend))
        self.tunnel = self.broker = None
        self.last_origin_check = 0

    def discover_origin(self):
        # Host/key/password remain exclusively in the existing pinned SSH helper.
        path = safe_file(str(Path(self.tunnel_script).with_name('migration.py')))
        spec = importlib.util.spec_from_file_location('_aw_pinned_ssh', path)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        ssh, password = helper.client()
        # Guard/metadata reads must not hang shutdown or the UI startup wait.
        deadline = threading.Timer(20, ssh.close)
        deadline.daemon = True
        deadline.start()
        try:
            helper.guard(ssh)
            data = json.loads(helper.remote(ssh, 'cat ' + helper.ROOT + '/.runtime/lan.json', password=password, timeout=15))
            return origin_from_metadata(data)
        finally:
            deadline.cancel()
            ssh.close()

    def close(self):
        for name in ('broker', 'tunnel'):
            process = getattr(self, name)
            if process:
                process.stop(); setattr(self, name, None)

    def start_broker(self):
        require_ports(8765)
        env = dict(os.environ, AW_BROKER_BACKEND=self.backend, AW_BROKER_PORT='8765',
                   AW_BROKER_ORIGINS=self.origin)
        self.broker = self.child([self.python, '-m', 'academic_watcher_auth_broker'], env=env)

    def tick(self, now):
        if self.local:
            # Docker/the operator owns the backend. Never start or stop it.
            if not self.ready():
                return 'CALLBACK_UNAVAILABLE'
            if not self.broker or self.broker.poll() is not None:
                if self.broker:
                    self.broker.stop(); self.broker = None
                    deadline = time.monotonic() + 5
                    while not port_free(8765) and time.monotonic() < deadline:
                        time.sleep(.05)
                self.start_broker()
                return 'STARTING'
            return 'RUNNING'
        if not self.tunnel or self.tunnel.poll() is not None:
            replacing_owned = self.tunnel is not None or self.broker is not None
            self.close()
            if replacing_owned:
                # Winsock can lag behind Job Object process termination. Give
                # only our own replacement a bounded cleanup grace period.
                deadline = time.monotonic() + 5
                while not (port_free(8000) and port_free(8765)) and time.monotonic() < deadline:
                    time.sleep(.05)
            require_ports(8000, 8765)
            self.origin = lan_origin(self.discover())
            self.tunnel = self.child([self.python, self.tunnel_script])
            self.last_origin_check = now
            return 'CONNECTING'
        if not self.ready():
            return 'CALLBACK_UNAVAILABLE'
        if now - self.last_origin_check >= 60:
            self.last_origin_check = now
            try:
                updated = lan_origin(self.discover())
            except Exception:
                # A new metadata SSH connection may fail while the existing
                # callback is healthy. Keep its already validated exact origin
                # and owned children; retry at the next periodic boundary.
                updated = self.origin
            if updated != self.origin:
                if self.broker:
                    self.broker.stop(); self.broker = None
                self.origin = updated
        if not self.broker or self.broker.poll() is not None:
            if self.broker:
                self.broker.stop(); self.broker = None
            self.start_broker()
            return 'STARTING'
        return 'RUNNING'


def gateway_ready(backend):
    import httpx

    from .resolve import PinnedSyncTransport
    try:
        with httpx.Client(transport=PinnedSyncTransport(backend), trust_env=False, timeout=5,
                          follow_redirects=False) as client:
            response = client.get(backend + '/api/health')
        return response.status_code == 200 and response.json().get('status') == 'ok'
    except Exception:
        return False


class RemoteSupervisor:
    """Public HTTPS gateway (Azure): no tunnel or LAN discovery, only the owned broker child."""

    def __init__(self, config, *, child=OwnedChild, ready=gateway_ready):
        if set(config) != {'python', 'backend', 'origin'}:
            raise ValueError('Invalid launcher config schema')
        self.python = safe_file(config['python'])
        self.backend = backend_base(config['backend'])
        if not self.backend.startswith('https://'):
            raise ValueError('Remote mode requires an HTTPS gateway')
        self.origin = frontend_origin(config['origin'])
        if urlsplit(self.origin).scheme != 'https':
            raise ValueError('Remote mode requires an HTTPS frontend origin')
        self.child = child
        self.ready = ready
        self.broker = None

    def close(self):
        if self.broker:
            self.broker.stop(); self.broker = None

    def tick(self, now):
        if not self.ready(self.backend):
            return 'CALLBACK_UNAVAILABLE'
        if not self.broker or self.broker.poll() is not None:
            self.close()
            require_ports(8765)
            env = dict(os.environ, AW_BROKER_BACKEND=self.backend, AW_BROKER_PORT='8765',
                       AW_BROKER_ORIGINS=self.origin)
            self.broker = self.child([self.python, '-m', 'academic_watcher_auth_broker'], env=env)
            return 'STARTING'
        return 'RUNNING'


def supervisor_for(config):
    return RemoteSupervisor(config) if 'origin' in config else Supervisor(config)


def record(root, state):
    # Fixed categories only. Never log URI, command line, HTTP content or exception text.
    temporary = root / ('status-' + str(os.getpid()) + '.new')
    temporary.write_text(json.dumps({'state': state, 'pid': os.getpid(), 'updated': time.time()}), encoding='utf-8')
    temporary.replace(root / 'status.json')


def port_conflict_message(problem):
    """Fixed wording plus the port numbers; never exception or system text."""
    ports = ' and '.join(str(port) for port in problem.ports)
    plural = len(problem.ports) > 1
    if isinstance(problem, PortReserved):
        commands = '\n'.join(
            ['net stop winnat']
            + [f'netsh int ipv4 add excludedportrange protocol=tcp startport={port} numberofports=1'
               for port in problem.ports]
            + ['net start winnat'])
        return (f'Windows has reserved local port{"s" if plural else ""} {ports} for Hyper-V, WSL or Docker, '
                f'so the broker cannot use {"them" if plural else "it"}. No other process was stopped.\n\n'
                'To keep the port for Academic Watcher, run these commands in an administrator PowerShell '
                '(WSL and Docker networking pause for a moment), then click Start broker again:\n\n' + commands)
    return (f'Local port{"s" if plural else ""} {ports} {"are" if plural else "is"} in use by another application. '
            'No other process was stopped. Close that application, then click Start broker again.')


def notify_port_conflict(problem):
    if os.name == 'nt':
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, port_conflict_message(problem), 'Academic Watcher Broker', 0x30)


def run(args):
    validate_activation(args)  # Before filesystem, network or process activity.
    root = runtime_root()
    with singleton(root) as acquired:
        if not acquired:
            return
        config = json.loads((root / 'config.json').read_text())
        supervisor = supervisor_for(config)
        delay = 2
        notified = None
        try:
            while not (root / 'stop.request').exists():
                try:
                    state = supervisor.tick(time.monotonic())
                    record(root, state)
                    delay = 2
                    notified = None
                except PortOccupied as problem:
                    supervisor.close()
                    record(root, problem.state)
                    # Tell the user once per distinct problem, not on every retry.
                    if notified != (problem.state, problem.ports):
                        notified = (problem.state, problem.ports)
                        # Native attention must not block shutdown or recovery.
                        threading.Thread(target=notify_port_conflict, args=(problem,), daemon=True).start()
                    delay = min(delay * 2, 30)
                except Exception:
                    supervisor.close()
                    record(root, 'CONNECTION_FAILED')
                    delay = min(delay * 2, 30)
                for _ in range(delay):
                    if (root / 'stop.request').exists():
                        break
                    time.sleep(1)
        finally:
            supervisor.close()
            (root / 'stop.request').unlink(missing_ok=True)
            record(root, 'STOPPED')


def main():
    try:
        run(sys.argv[1:])
    except Exception:
        # A visible native error is needed because pythonw has no console.
        if os.name == 'nt':
            import ctypes
            ctypes.windll.user32.MessageBoxW(None, 'Academic Watcher could not start its local helper. Check the installed launcher configuration or contact the operator.', 'Academic Watcher', 0x10)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
