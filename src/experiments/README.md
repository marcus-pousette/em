# Experiments

## TreeCRDT sync (experimental)

This experiment connects em to a TreeCRDT v0 sync server over WebSocket.

- It provides a small debug API (`window.treecrdtSync`).
- It can bridge em thought updates through TreeCRDT so multiple windows stay in sync.

### Run locally

1) Start the TreeCRDT sync server:

```sh
yarn treecrdt:sync-server:setup
yarn treecrdt:sync-server
```

2) Start em:

```sh
yarn install
VITE_TREECRDT_SYNC_WS_BASE=ws://localhost:8787 yarn start
```

3) Open em with TreeCRDT enabled:

- `http://localhost:3000/?treecrdt=1` (partial sync via children subscriptions)
- `http://localhost:3000/?treecrdt=all` (full sync, useful for debugging)

### Doc ids

By default, the TreeCRDT doc id is your current em thoughtspace id (`tsid`).
So `http://localhost:3000/?treecrdt=1` is valid even though it does not include a doc id.

- View it in DevTools Console: `localStorage.getItem('tsid')`
- Use an isolated thoughtspace with `share=...`, e.g. `http://localhost:3000/?share=demo&treecrdt=1`

### Test with multiple tabs

Open the exact same URL in two contexts:

- Tab A: `http://localhost:3000/?share=treecrdt-manual-1&treecrdt=1`
- Tab B: `http://localhost:3000/?share=treecrdt-manual-1&treecrdt=1`

Notes:

- Prefer opening a second tab by copy and paste. Avoid duplicating the tab, since some browsers may clone `sessionStorage`.
- If you use separate browser profiles, you must include `share=...` so both windows use the same doc id.

You can inspect the debug API in DevTools as `window.treecrdtSync`.
