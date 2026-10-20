# DeviceHub observability

DeviceHub attaches the following fields to HTTP, Socket.IO, screen WebSocket and
ZeroMQ wire logs:

```text
trace, request, socket, session, user, device, op
```

`user` is a salted, truncated hash of the user's email. Tokens, cookies, ADB
keys and screen frames are never written to these fields.

## Log format

The default text format remains compatible with existing Docker log collection:

```text
[trace=trace-... request=req-... session=session-... user=u-... device=ab2de9d3 op=screen.session]
```

Set `OBS_LOG_FORMAT=json` in `scripts/variables.env` to emit JSON Lines. The
browser automatically sends `X-Request-ID`, `X-Trace-ID` and `X-Session-ID` on
API requests, and sends the same context through Socket.IO and screen WebSocket
connections.

## Diagnosis

Use the bundled command from the DeviceHub directory:

```bash
./devicehub.sh diagnose --device ab2de9d3 --since 15m
./devicehub.sh diagnose --user user@example.com --since 30m
./devicehub.sh diagnose --trace trace-xxxxxxxx
```

Proxy-specific checks:

```bash
./devicehub.sh proxy-status   # Nginx config, Docker DNS, resolved service IPs
./devicehub.sh proxy-test     # direct upstreams, through-Nginx paths, device workers
./devicehub.sh proxy-repair   # validate and recreate Nginx only
```

Nginx resolves App/API/Auth/WebSocket/Storage through Docker's DNS at request
time (`resolver 127.0.0.11 valid=10s`), so recreating a backend container does
not require restarting Nginx.

Provider lifecycle logs carry the device worker context:

```text
device.lifecycle event=status_changed deviceSerial=... oldStatus=... newStatus=... workerPort=... workerState=... providerName=...
screen.websocket.closed device=... session=... workerPort=... code=... reason=...
```

The command combines service state, host ADB state, Mongo device state, recent
API/WebSocket/Provider/Nginx events and a first-cause classification. The most
useful screen path events are `screen.websocket.auth_failed`,
`screen.frame_producer.started`, `screen.frame_producer.failed` and the Nginx
status for `/d/<provider>/<port>/`.

## Health endpoints

```text
/health/live
/health/ready  (API service)
```

All HTTP services return `X-Request-ID` and Nginx access logs retain request,
trace, session, upstream status and timing fields.
