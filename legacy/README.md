# Legacy Python services (reference only)

This directory holds the Python implementation inherited from upstream CanvasWatcher (`aca5813`): the FastAPI backend, the identity gateway, the Windows Auth Broker, the Azure/systemd operations scripts, and their Compose files and deployment guides.

It is kept only as a porting reference while the Node.js backend in `../server` reaches parity. It is not built, tested or deployed by this fork, and the Compose files here no longer resolve `./frontend`. Delete this directory before the CS409 submission (see `docs/cs409/REWRITE_PLAN.zh-CN.md`, week 6).
