# `pi-remote --status` Design

## Summary

Add a `--status` flag to pi-remote that queries the local discovery service and prints its status.

## Behavior

Parsed in `cli.ts` following the same pattern as `--discovery`. Hits existing discovery APIs on `localhost:7008`:

1. `GET /api/token` — determines if the service is reachable; retrieves the access token
2. `GET /api/sessions` — retrieves active session list

### Output (running, with sessions)

```
Discovery service: running
Discovery page:    https://<hostname>/pi/?token=<token>

Sessions (2):
  • /home/user/project-a  (3m ago)
  • /home/user/project-b  (12m ago)
```

### Output (not running)

```
Discovery service: not running
```

### Exit code

- `0` if discovery service is running
- `1` if not running

## Scope

- Only `cli.ts` changes — no server-side modifications needed
- Uses existing `/api/token` and `/api/sessions` endpoints
