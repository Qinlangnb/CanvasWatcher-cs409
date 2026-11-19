# Local Auth Broker (protocol v1)

The Auth Broker is a small desktop helper for **Settings → Sources → Sign in with Browser**. It opens a
visible, dedicated Chromium window on the official Canvas, Gradescope or PrairieLearn sign-in page. You
sign in there yourself (SSO, MFA and passwords stay on the official site); the broker then hands the
signed-in session cookies straight to your CanvasWatcher server, which checks them before storing them
encrypted. The web page only ever sees the sign-in status.

Version 0.8.0. It runs on the computer where you use the browser: not in Docker and not on the server.
Each computer needs its own installation; a phone cannot start a Windows broker.

## Requirements

- Python 3.12 and Playwright Chromium on the desktop.
- A CanvasWatcher server reachable from that desktop. A session for a different Canvas account than the
  one already connected is refused.

## Windows: one-click launcher

From the repository folder, install the broker and Chromium:

```powershell
cd "C:\path\to\CanvasWatcher"
py -3.12 -m venv auth-broker/.venv
auth-broker/.venv/Scripts/python.exe -m pip install -e ./auth-broker
auth-broker/.venv/Scripts/python.exe -m playwright install chromium
```

Then register the `academicwatcher://` launcher once for your Windows user (no admin rights), for the site
you use:

```powershell
# A hosted CanvasWatcher, for example served at https://watcher.example.com/cs409
auth-broker/.venv/Scripts/python.exe -m academic_watcher_auth_broker.install_launcher install --backend https://watcher.example.com/cs409 --origin https://watcher.example.com

# Local Docker Compose (the site and its /api on http://localhost:8080)
auth-broker/.venv/Scripts/python.exe -m academic_watcher_auth_broker.install_launcher install --backend http://127.0.0.1:8080 --origins http://localhost:8080,http://127.0.0.1:8080

# Local development (Vite on 5173, API on 8000)
auth-broker/.venv/Scripts/python.exe -m academic_watcher_auth_broker.install_launcher install --backend http://127.0.0.1:8000 --origins http://localhost:5173
```

`--backend` is where the API lives (`/api/...` is appended): a loopback `http://` address with a port, or
the public `https://` site including its base path (`PUBLIC_BASE_PATH`). `--origin` / `--origins` are the
exact page origins allowed to talk to the broker (no paths or wildcards). Without options, `install` uses
`http://127.0.0.1:8000` and the origins `http://localhost:8080,http://127.0.0.1:8080`.

Add `--autostart` (or run the `autostart` action later) to also start the launcher whenever you sign in to
Windows. This is opt-in: it creates a scheduled task for your user only ("Academic Watcher Broker"), which
starts the launcher at sign-in and again within 5 minutes if it stopped. Turn it off with
`remove-autostart`; `uninstall` removes it too.

Afterwards use Settings → Sources → **Start broker**, then **Check broker**. The page opens
`academicwatcher://start` (confirm the browser's prompt to open the launcher) and waits up to 60 seconds
until the broker and its connection back to the server are ready. The broker listens on `127.0.0.1:8765`;
the server's `AUTH_BROKER_URL` must match (the default does). The browser may also ask for permission to
reach a local network address; approve it only for your own CanvasWatcher page.

Stop the broker, or remove everything this installer registered (dedicated browser profiles are kept):

```powershell
auth-broker/.venv/Scripts/python.exe -m academic_watcher_auth_broker.install_launcher stop
auth-broker/.venv/Scripts/python.exe -m academic_watcher_auth_broker.install_launcher uninstall
```

`install --tunnel <absolute-script-path>` remains as an advanced, operator-managed SSH-tunnel mode (see
`launch.py`). Operators must write and secure that helper themselves; the modes above do not need it.

## Manual mode (any OS)

The package can also run directly; it is configured with environment variables:

```sh
python3.12 -m venv auth-broker/.venv
auth-broker/.venv/bin/python -m pip install -e ./auth-broker
auth-broker/.venv/bin/python -m playwright install chromium
AW_BROKER_BACKEND=http://127.0.0.1:8000 AW_BROKER_ORIGINS=http://localhost:5173 auth-broker/.venv/bin/python -m academic_watcher_auth_broker
```

`AW_BROKER_BACKEND` takes the same values as `--backend`, `AW_BROKER_ORIGINS` a comma-separated list of
exact origins, and `AW_BROKER_PORT` changes the port (8765 by default; set the server's `AUTH_BROKER_URL`
to match). Stop it with Ctrl+C.

## How the hand-over works

1. The page asks the server for a challenge (`POST /api/auth/broker/challenges`) and receives a one-time
   ticket, valid for 240 seconds and bound to your account and that one source.
2. The page passes the ticket to the broker (`POST http://127.0.0.1:8765/login`). The broker claims it
   directly from the server (`/api/auth/broker/claim`) for a separate exchange token. Broker calls carry
   `X-AW-Broker: 1` and never an Origin header or cookies; the server refuses them otherwise.
3. You sign in in the broker's window. The broker sends the cookies only to the server
   (`/api/auth/broker/complete`), which checks them with the provider and against your connected account.
4. The page polls `/api/auth/broker/status` until the sign-in is AUTHENTICATED, FAILED, CANCELLED or
   TIMED_OUT.

"Clear browser session" removes that dedicated browser profile and the server's stored session; course
data and other sign-in methods (PAT, OAuth) stay. Do not enable HTTP debug or access logs, export browser
storage, copy profile folders, or expose port 8765 to the network.

## Tests

```sh
py -3.12 -m unittest discover -s auth-broker/tests -t auth-broker
```
